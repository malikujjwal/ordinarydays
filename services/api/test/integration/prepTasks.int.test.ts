import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { MAX_PREP_TASKS_PER_PLAN } from '@od/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { authedHeaders, withUser } from '../helpers/auth.js';
import { useTestTable } from './harness.js';

/**
 * Prep tasks against a real DynamoDB Local (P3-18).
 *
 * The unit suites prove the right transaction is composed. What only a database can prove is
 * that the pieces stay in agreement over a sequence of writes: that a plan's `childCount`
 * still equals its pointers after a create, a completion, a re-parent and a delete; that the
 * 51st really writes nothing rather than writing the Activity and failing afterwards; and
 * that the bounded page really is the whole collection rather than the first page of one.
 *
 * Those are the properties the product renders as `3 of 5 done` and invites the user to tap,
 * so every one of them is a number that has to be true, not approximately true.
 */
useTestTable();

type Base = typeof import('../../src/repositories/base.js');
type Ddb = typeof import('../../src/lib/ddb.js');
type Keys = typeof import('../../src/repositories/keys.js');
type Repo = typeof import('../../src/repositories/activityRepository.js');
type Service = typeof import('../../src/services/activityService.js');

let base: Base;
let ddbModule: Ddb;
let keys: Keys;
let repo: Repo;
let service: Service;

const DEV = 'usr_local_dev';
const TODAY = new Date().toISOString().slice(0, 10);
const TIMEZONE = 'America/New_York';

beforeAll(async () => {
  base = await import('../../src/repositories/base.js');
  ddbModule = await import('../../src/lib/ddb.js');
  keys = await import('../../src/repositories/keys.js');
  repo = await import('../../src/repositories/activityRepository.js');
  service = await import('../../src/services/activityService.js');
});

const post = (
  path: string,
  body: unknown,
  options: { key?: string; userId?: string } = {},
) =>
  withUser(options.userId).fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: authedHeaders({ idempotencyKey: options.key ?? crypto.randomUUID() }),
      body: JSON.stringify(body),
    }),
  );

const patch = (activityId: string, body: unknown, ifMatch: string) =>
  withUser().fetch(
    new Request(`http://localhost/v1/activities/${activityId}`, {
      method: 'PATCH',
      headers: { ...authedHeaders(), 'If-Match': ifMatch },
      body: JSON.stringify(body),
    }),
  );

const remove = (activityId: string) =>
  withUser().fetch(
    new Request(`http://localhost/v1/activities/${activityId}`, {
      method: 'DELETE',
      headers: authedHeaders(),
    }),
  );

const agenda = () =>
  withUser().fetch(
    new Request(
      `http://localhost/v1/agenda?from=${TODAY}&to=${TODAY}&tz=${encodeURIComponent(TIMEZONE)}`,
      {
        method: 'GET',
        headers: authedHeaders({ timezone: TIMEZONE }),
      },
    ),
  );

const dataOf = async (response: Response) => (await response.json()).data;

const createPlan = async (title = 'Poconos trip') =>
  dataOf(await post('/v1/activities', { objectKind: 'plan', type: 'event', title }));

const createChild = async (
  parentActivityId: string,
  overrides: Record<string, unknown> = {},
  options: { key?: string } = {},
) =>
  post(
    '/v1/activities',
    {
      objectKind: 'task',
      type: 'task',
      title: 'Book hotel',
      parentActivityId,
      ...overrides,
    },
    options,
  );

/** The parent's stored counter, read back rather than inferred from a response body. */
const childCountOf = async (activityId: string) =>
  (await repo.getActivityMeta(activityId))?.childCount;

const activityRows = async () =>
  (await base.queryAll<Record<string, unknown>>({ pk: keys.userProfile(DEV).pk })).filter(
    (row) => row.entity === 'ActivityIndex',
  );

describe('the 50-prep-task cap', () => {
  /**
   * Fifty children, written straight to the table rather than through fifty HTTP creates: the
   * subject is what happens at the boundary, and fifty round trips through the rate limiter
   * would test the limiter instead.
   */
  const fillPlan = async (planId: string, count = MAX_PREP_TASKS_PER_PLAN) => {
    for (let index = 0; index < count; index += 1) {
      const child = {
        activityId: `act_01J8XKQ2M4N5P6R7S8T9V${String(index).padStart(5, '0')}`,
        ownerId: DEV,
        objectKind: 'task' as const,
        type: 'task' as const,
        status: 'saved' as const,
        title: `Prep ${index}`,
        details: { kind: 'task' as const },
        parentActivityId: planId,
        participantCount: 0,
        childCount: 0,
        expenseTotalCents: 0,
        visibility: 'private' as const,
        icsSequence: 0,
        createdAt: '2026-08-01T10:00:00.000Z',
        lastActivityAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-01T10:00:00.000Z',
        schemaVersion: 1 as const,
      };
      await repo.createActivity(DEV, child, { taskSubtitle: 'Poconos trip' });
    }
  };

  it('refuses the 51st with the exact copy and writes neither Activity nor pointer', async () => {
    const plan = await createPlan();
    await fillPlan(plan.activityId);
    const before = await activityRows();

    const res = await createChild(plan.activityId, { title: 'One too many' });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.message).toBe('Plan has too many prep tasks.');

    expect(await activityRows()).toHaveLength(before.length);
    expect(await repo.listChildPointers(plan.activityId)).toHaveLength(
      MAX_PREP_TASKS_PER_PLAN,
    );
    expect(await childCountOf(plan.activityId)).toBe(MAX_PREP_TASKS_PER_PLAN);
  });

  /**
   * The same refusal for an offline intent replayed after its receipt expired — there is no
   * stored response to return, so it arrives as a fresh create and meets the same cap. The
   * client-minted id makes the transaction, not the precheck, the thing that refuses it.
   */
  it('refuses a replayed offline create at the cap, and still writes nothing', async () => {
    const plan = await createPlan();
    await fillPlan(plan.activityId);
    const before = await activityRows();

    const res = await createChild(plan.activityId, {
      activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X9',
      title: 'Replayed',
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Plan has too many prep tasks.');
    expect(await activityRows()).toHaveLength(before.length);
    expect(await repo.getActivityMeta('act_01J8XKQ2M4N5P6R7S8T9V0W1X9')).toBeUndefined();
    expect(await childCountOf(plan.activityId)).toBe(MAX_PREP_TASKS_PER_PLAN);
  });

  it('accepts the 50th', async () => {
    const plan = await createPlan();
    await fillPlan(plan.activityId, MAX_PREP_TASKS_PER_PLAN - 1);

    expect((await createChild(plan.activityId)).status).toBe(201);
    expect(await childCountOf(plan.activityId)).toBe(MAX_PREP_TASKS_PER_PLAN);
  });
});

describe('childCount through a prep task’s life', () => {
  it('is correct after adding, completing, re-parenting and deleting', async () => {
    const plan = await createPlan();
    const other = await createPlan('Ski trip');

    const first = await dataOf(
      await createChild(plan.activityId, { title: 'Book hotel' }),
    );
    const second = await dataOf(await createChild(plan.activityId, { title: 'Pack' }));
    expect(await childCountOf(plan.activityId)).toBe(2);

    // Completion changes the pointer's status. It is not a change of membership.
    const completed = await post(`/v1/activities/${first.activityId}/complete`, {});
    expect(completed.status).toBe(200);
    expect(await childCountOf(plan.activityId)).toBe(2);

    const pointers = await repo.listPrepTaskPointers(plan.activityId);
    expect(pointers.find((row) => row.childActivityId === first.activityId)?.status).toBe(
      'completed',
    );

    // A re-parent moves the membership, so both counters move with it.
    const moved = await patch(
      second.activityId,
      { parentActivityId: other.activityId },
      second.updatedAt,
    );
    expect(moved.status).toBe(200);
    expect(await childCountOf(plan.activityId)).toBe(1);
    expect(await childCountOf(other.activityId)).toBe(1);
    expect(await repo.listChildPointers(plan.activityId)).toHaveLength(1);
    expect(await repo.listChildPointers(other.activityId)).toHaveLength(1);

    expect((await remove(first.activityId)).status).toBe(200);
    expect(await childCountOf(plan.activityId)).toBe(0);
  });

  /**
   * The half of the delete cascade P1-14 never had: the child's own partition went, and the
   * parent kept a pointer to it and a count that included it. A plan then rendered a ratio
   * whose rows could not be reached — the "no unexplained numbers" rule, broken by a delete.
   */
  it('leaves the parent with no stale pointer when a prep task is deleted', async () => {
    const plan = await createPlan();
    const child = await dataOf(await createChild(plan.activityId));

    expect((await remove(child.activityId)).status).toBe(200);

    expect(await repo.listChildPointers(plan.activityId)).toEqual([]);
    expect(await childCountOf(plan.activityId)).toBe(0);
    await expect(service.getPrepTasks(plan.activityId)).resolves.toEqual({
      prepTasks: [],
      doneCount: 0,
      openCount: 0,
    });
  });

  /**
   * The counter is a denormalised count of other rows, not an edit to the plan — so the
   * plan's concurrency token must survive its children coming and going. The last assertion
   * is the reason it matters: a token the client is still holding has to keep working.
   */
  it('never moves the parent’s updatedAt, so an open editor still commits', async () => {
    const plan = await createPlan();
    const child = await dataOf(await createChild(plan.activityId));

    expect((await repo.getActivityMeta(plan.activityId))?.updatedAt).toBe(plan.updatedAt);

    await remove(child.activityId);
    expect((await repo.getActivityMeta(plan.activityId))?.updatedAt).toBe(plan.updatedAt);

    const renamed = await patch(
      plan.activityId,
      { title: 'Poconos trip, take two' },
      plan.updatedAt,
    );
    expect(renamed.status).toBe(200);
  });

  it('clears the counter when a prep task’s parent is removed by PATCH', async () => {
    const plan = await createPlan();
    const child = await dataOf(await createChild(plan.activityId));

    const detached = await patch(
      child.activityId,
      { parentActivityId: null },
      child.updatedAt,
    );

    expect(detached.status).toBe(200);
    expect(await dataOf(detached)).not.toHaveProperty('parentActivityId');
    expect(await childCountOf(plan.activityId)).toBe(0);
    expect(await repo.listChildPointers(plan.activityId)).toEqual([]);
  });
});

/**
 * The counter is not covered by `updatedAt`, and that is deliberate — a prep task being added
 * must not 409 an open editor. The cost is that the two writes which *care* about the counter
 * cannot see each other through `updatedAt`, so each conditions on what the other changes.
 */
describe('attaching a child races converting the plan', () => {
  /**
   * **The invariant under real concurrency, not the regression guard.** Two requests fired
   * together do not reliably interleave inside the window — this passes against the unfixed
   * code whenever they happen to serialise, which was observed. It earns its place by
   * asserting the invariant end to end through the HTTP layer; the test below it is the one
   * that fails when the conditions are removed, because it reproduces the damaging order by
   * construction instead of hoping for it.
   */
  it('commits exactly one of a concurrent attach and Plan → Task conversion', async () => {
    const plan = await createPlan('Poconos trip');

    const [attach, convert] = await Promise.all([
      createChild(plan.activityId, { title: 'Book hotel' }),
      patch(
        plan.activityId,
        { objectKind: 'task', type: 'task', details: { kind: 'task' } },
        plan.updatedAt,
      ),
    ]);

    const attached = attach.status === 201;
    const converted = convert.status === 200;
    expect(attached).not.toBe(converted);

    const parent = await repo.getActivityMeta(plan.activityId);
    const pointers = await repo.listChildPointers(plan.activityId);

    if (attached) {
      // The conversion lost: the plan is still a Plan and still counts its child.
      expect(parent?.objectKind).toBe('plan');
      expect(parent?.childCount).toBe(1);
      expect(pointers).toHaveLength(1);
      // And it is told what actually blocked it, not handed back its own token.
      expect(convert.status).toBe(409);
      expect((await convert.json()).error.message).toBe(
        'Remove 1 prep task before changing this to a Task.',
      );
    } else {
      // The attach lost: nothing was written for it, so no child is stranded on a Task.
      expect(parent?.objectKind).toBe('task');
      expect(parent?.childCount).toBe(0);
      expect(pointers).toEqual([]);
      expect(await activityRows()).toHaveLength(1);
      expect(attach.status).toBe(400);
      expect((await attach.json()).error.message).toBe('A prep task belongs to a plan.');
    }
  });

  /**
   * The **service** half: an ordinary stale conversion is refused before any transaction is
   * built, by the 409 guard reading the current row. Worth keeping, but it is not the guard
   * on the condition — see the two repository tests below, which is where the conditions
   * actually live.
   */
  it('refuses a conversion once the plan has a child, at the service guard', async () => {
    const plan = await createPlan('Poconos trip');
    const stale = plan.updatedAt;

    await createChild(plan.activityId, { title: 'Book hotel' });

    const parent = await repo.getActivityMeta(plan.activityId);
    expect(parent?.updatedAt).toBe(stale);
    expect(parent?.childCount).toBe(1);

    const res = await patch(
      plan.activityId,
      { objectKind: 'task', type: 'task', details: { kind: 'task' } },
      stale,
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe(
      'Remove 1 prep task before changing this to a Task.',
    );
    expect((await repo.getActivityMeta(plan.activityId))?.objectKind).toBe('plan');
  });
});

/**
 * The conditions themselves, driven at the **repository**, in both orders.
 *
 * Every route-level test above is refused by a service precheck reading current truth, which
 * is correct behaviour and useless as a guard on a transaction condition: the request never
 * reaches DynamoDB. These two build the losing write from a snapshot taken **before** the
 * other one landed — exactly what a real concurrent request holds — and hand it to the
 * repository, so the condition is the only thing that can refuse it. Remove either half of
 * the pair and the matching test fails.
 */
describe('the transaction conditions, from a stale snapshot', () => {
  it('refuses a conversion built before the child attached', async () => {
    const plan = await createPlan('Poconos trip');
    const snapshot = await repo.getActivityMeta(plan.activityId);
    if (snapshot === undefined) throw new Error('the plan should exist');

    // The attach lands after the conversion was authorised, moving childCount but not
    // updatedAt — so the conversion's version condition would still pass on its own.
    await createChild(plan.activityId, { title: 'Book hotel' });

    const converted = {
      ...snapshot,
      objectKind: 'task',
      type: 'task',
      details: { kind: 'task' },
      updatedAt: '2026-08-26T12:00:00.000Z',
    } as unknown as Parameters<typeof repo.patchActivity>[1];

    await expect(
      repo.patchActivity(DEV, converted, snapshot.updatedAt, {
        previous: snapshot,
        expectedChildCount: 0,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const parent = await repo.getActivityMeta(plan.activityId);
    expect(parent?.objectKind).toBe('plan');
    expect(parent?.childCount).toBe(1);
    expect(await repo.listChildPointers(plan.activityId)).toHaveLength(1);
  });

  it('refuses an attach built before the plan was converted', async () => {
    const CHILD_ID = 'act_01M0Z943P3VCA6E1P2X4N44N99';
    const plan = await createPlan('Poconos trip');
    const snapshot = await repo.getActivityMeta(plan.activityId);
    if (snapshot === undefined) throw new Error('the plan should exist');

    // The conversion lands after the attach was authorised: legal, the plan is still empty.
    const convert = await patch(
      plan.activityId,
      { objectKind: 'task', type: 'task', details: { kind: 'task' } },
      snapshot.updatedAt,
    );
    expect(convert.status).toBe(200);

    /**
     * Built field by field rather than spread from the snapshot: the stored row carries its
     * own `pk`/`sk`, and reusing them puts this write on the **plan's** key, where the id
     * condition fails first and the parent condition is never reached. The first version of
     * this test did exactly that and passed for the wrong reason.
     */
    const child = {
      activityId: CHILD_ID,
      ownerId: DEV,
      status: 'saved',
      objectKind: 'task',
      type: 'task',
      title: 'Book hotel',
      details: { kind: 'task' },
      parentActivityId: plan.activityId,
      participantCount: 0,
      childCount: 0,
      expenseTotalCents: 0,
      visibility: 'private',
      icsSequence: 0,
      createdAt: snapshot.createdAt,
      lastActivityAt: snapshot.createdAt,
      updatedAt: snapshot.createdAt,
      schemaVersion: 1,
    } as unknown as Parameters<typeof repo.createActivity>[1];

    await expect(repo.createActivity(DEV, child, {})).rejects.toBeInstanceOf(
      repo.ParentUnavailableError,
    );

    const parent = await repo.getActivityMeta(plan.activityId);
    expect(parent?.objectKind).toBe('task');
    expect(parent?.childCount).toBe(0);
    expect(await repo.listChildPointers(plan.activityId)).toEqual([]);
    expect(await repo.getActivityMeta(CHILD_ID)).toBeUndefined();
  });
});

describe('the bounded collection read', () => {
  it('answers the complete set and exact counts from one capped Query', async () => {
    const plan = await createPlan();
    const done = await dataOf(
      await createChild(plan.activityId, { title: 'Book hotel' }),
    );
    await createChild(plan.activityId, { title: 'Pack' });
    await createChild(plan.activityId, { title: 'Buy sunscreen' });
    await post(`/v1/activities/${done.activityId}/complete`, {});

    const send = vi.spyOn(ddbModule.ddb, 'send');
    const collection = await service.getPrepTasks(plan.activityId);

    expect(collection.prepTasks).toHaveLength(3);
    expect(collection.doneCount).toBe(1);
    expect(collection.openCount).toBe(2);

    /**
     * One Query, carrying the model cap as its `Limit`. `queryAll` pages until the partition
     * is exhausted and sends no `Limit` at all, so this assertion is what keeps the detail
     * path off it — the read has to be bounded by the model, not by how much there happens
     * to be.
     */
    const queries = send.mock.calls.filter(
      ([command]) => command instanceof QueryCommand,
    );
    expect(queries).toHaveLength(1);
    const [sent] = queries[0] ?? [];
    expect((sent as QueryCommand).input).toMatchObject({
      Limit: MAX_PREP_TASKS_PER_PLAN,
      ConsistentRead: true,
    });
    send.mockRestore();
  });
});

describe('the recurrence bit on the pointer', () => {
  /** Daily, so today is always an occurrence the conversion may explicitly target. */
  const repeating = {
    schedule: { date: TODAY, timezone: TIMEZONE },
    recurrence: { mode: 'fixed', segments: [{ freq: 'daily', effectiveFrom: TODAY }] },
  };

  it('is true for a recurring child and false again after conversion', async () => {
    const plan = await createPlan();
    const child = await dataOf(
      await createChild(plan.activityId, { title: 'Water the plants', ...repeating }),
    );

    const created = await repo.listPrepTaskPointers(plan.activityId);
    expect(created[0]).toMatchObject({ isRecurring: true, title: 'Water the plants' });

    const converted = await post(
      `/v1/activities/${child.activityId}/recurrence/convert`,
      { occurrenceDate: TODAY },
    );
    expect(converted.status).toBe(200);

    const after = await repo.listPrepTaskPointers(plan.activityId);
    expect(after[0]).toMatchObject({ isRecurring: false });
    expect(await childCountOf(plan.activityId)).toBe(1);
  });

  it('follows a prep task that gains recurrence through PATCH', async () => {
    const plan = await createPlan();
    const child = await dataOf(
      await createChild(plan.activityId, {
        title: 'Water the plants',
        schedule: { date: TODAY, timezone: TIMEZONE },
      }),
    );

    const res = await patch(
      child.activityId,
      { recurrence: repeating.recurrence },
      child.updatedAt,
    );

    expect(res.status).toBe(200);
    expect((await repo.listPrepTaskPointers(plan.activityId))[0]).toMatchObject({
      isRecurring: true,
    });
  });
});

describe('a prep task hangs off a plan', () => {
  /**
   * `plans-and-lists.md` §3 opens with "`parentActivityId` set to the plan" and caps the
   * count "per Plan". A Task parent produces a row no screen can render — the PREP section
   * belongs to plan detail, and Task detail has none.
   */
  it('refuses a task as the parent, on POST', async () => {
    const standalone = await dataOf(
      await post('/v1/activities', {
        objectKind: 'task',
        type: 'task',
        title: 'Sort the garage',
      }),
    );

    const res = await createChild(standalone.activityId, { title: 'Find the boxes' });

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('A prep task belongs to a plan.');
    expect(await childCountOf(standalone.activityId)).toBe(0);
    expect(await repo.listChildPointers(standalone.activityId)).toEqual([]);
  });

  it('refuses a task as the parent, on PATCH', async () => {
    const standalone = await dataOf(
      await post('/v1/activities', {
        objectKind: 'task',
        type: 'task',
        title: 'Sort the garage',
      }),
    );
    const orphan = await dataOf(
      await post('/v1/activities', {
        objectKind: 'task',
        type: 'task',
        title: 'Find the boxes',
      }),
    );

    const res = await patch(
      orphan.activityId,
      { parentActivityId: standalone.activityId },
      orphan.updatedAt,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('A prep task belongs to a plan.');
    expect(await childCountOf(standalone.activityId)).toBe(0);
  });
});

describe('nesting stays two levels deep', () => {
  /**
   * A Task holding children is no longer reachable through the API — a parent must be a Plan,
   * and a Plan with children refuses conversion — so the state is seeded **directly**. The
   * check stays because legacy and repaired rows can still present it, and the previous
   * version of this test manufactured the state through the public API, which quietly
   * asserted that an invalid shape was legal.
   */
  it('refuses attaching an activity that already has prep tasks of its own', async () => {
    const plan = await createPlan();
    const middle = await createPlan('Sort the garage');
    const leaf = await dataOf(
      await createChild(middle.activityId, { title: 'Find the boxes' }),
    );

    // Seeded, not reachable: a Task carrying the children a Plan accumulated.
    const corrupted = await repo.getActivityMeta(middle.activityId);
    await base.putItem({
      ...(corrupted as unknown as Record<string, unknown>),
      ...keys.activityMeta(middle.activityId),
      entity: 'Activity',
      objectKind: 'task',
      type: 'task',
      details: { kind: 'task' },
    });

    const res = await patch(
      middle.activityId,
      { parentActivityId: plan.activityId },
      String(corrupted?.updatedAt),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(await childCountOf(plan.activityId)).toBe(0);
    expect(await repo.listChildPointers(plan.activityId)).toEqual([]);
    expect((await repo.getActivityMeta(leaf.activityId))?.parentActivityId).toBe(
      middle.activityId,
    );
  });
});

describe('a prep task is a task', () => {
  /**
   * `parentActivityId` lives on the shape both `objectKind` arms share, so the schema alone
   * never refused an attached Plan — and the row it produced took a `SUB#` pointer and a slot
   * against the 50-cap while sitting in a PREP section the product describes as tasks.
   */
  it('refuses a Plan created with a parent, and touches neither pointer nor counter', async () => {
    const plan = await createPlan();

    const res = await post('/v1/activities', {
      objectKind: 'plan',
      type: 'meal',
      title: 'Dinner on the way',
      parentActivityId: plan.activityId,
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Only a task can be a prep task.');
    expect(await childCountOf(plan.activityId)).toBe(0);
    expect(await repo.listChildPointers(plan.activityId)).toEqual([]);
  });

  /** The other door: converting a task that is *already* attached, changing no parent. */
  it('refuses converting an attached prep task into a Plan', async () => {
    const plan = await createPlan();
    const child = await dataOf(await createChild(plan.activityId));

    const res = await patch(
      child.activityId,
      { objectKind: 'plan', type: 'event', details: { kind: 'event' } },
      child.updatedAt,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Only a task can be a prep task.');

    const unchanged = await repo.getActivityMeta(child.activityId);
    expect(unchanged?.objectKind).toBe('task');
    expect(unchanged?.updatedAt).toBe(child.updatedAt);
    expect(await childCountOf(plan.activityId)).toBe(1);
  });
});

describe('deleting the plan', () => {
  /**
   * The rule that differs from every other cascade, and is therefore the easiest to get wrong
   * by pattern-matching the participant and expense ones: a user who cancels a trip may still
   * need to return the rental car.
   */
  it('leaves its prep tasks with their schedules and no parent', async () => {
    const plan = await createPlan();
    const child = await dataOf(
      await createChild(plan.activityId, {
        title: 'Return the rental car',
        schedule: { date: TODAY, timezone: TIMEZONE, time: '09:00' },
      }),
    );

    expect((await remove(plan.activityId)).status).toBe(200);

    const survivor = await repo.getActivityMeta(child.activityId);
    expect(survivor).toBeDefined();
    expect(survivor).not.toHaveProperty('parentActivityId');
    expect(survivor?.schedule).toMatchObject({
      date: TODAY,
      time: '09:00',
      timezone: TIMEZONE,
    });
  });

  /**
   * A child moved to another plan is not this delete's to release. The pointer records what
   * was true when it was written; the child is the authority on who its parent is now, and
   * clearing it would undo the move *and* leave the new plan's pointer and `childCount`
   * describing a child that no longer names it.
   */
  it('leaves a child that has been re-parented onto another plan', async () => {
    const from = await createPlan('Poconos trip');
    const to = await createPlan('Catskills trip');
    const child = await dataOf(await createChild(from.activityId));

    const moved = await dataOf(
      await patch(child.activityId, { parentActivityId: to.activityId }, child.updatedAt),
    );
    expect(moved.parentActivityId).toBe(to.activityId);

    expect((await remove(from.activityId)).status).toBe(200);

    const survivor = await repo.getActivityMeta(child.activityId);
    expect(survivor?.parentActivityId).toBe(to.activityId);
    expect(await childCountOf(to.activityId)).toBe(1);
    expect(await repo.listChildPointers(to.activityId)).toHaveLength(1);
  });
});

describe('a prep task on Today', () => {
  /** Acceptance criterion 20: its own date, and the plan's title underneath it. */
  it('renders on its own date with the parent plan’s title as its subtitle', async () => {
    const plan = await createPlan('Poconos trip');
    await createChild(plan.activityId, {
      title: 'Return the rental car',
      schedule: { date: TODAY, timezone: TIMEZONE, time: '09:00' },
    });

    const body = await (await agenda()).json();
    /**
     * **All three of Today's sections**, because which one holds a 09:00 task depends on what
     * time the suite runs: before it, `schedule`; after it, `earlier`. The criterion is that
     * the prep task appears on Today under its parent's title, not which band of the day it
     * lands in, so pinning the assertion to one section made it a clock-dependent test.
     */
    const rows = body.data.days.flatMap(
      (day: {
        schedule: { title: string; subtitle?: string }[];
        anytime: { title: string; subtitle?: string }[];
        earlier: { title: string; subtitle?: string }[];
      }) => [...day.schedule, ...day.anytime, ...day.earlier],
    );

    expect(rows).toContainEqual(
      expect.objectContaining({
        title: 'Return the rental car',
        subtitle: 'Poconos trip',
      }),
    );
  });
});
