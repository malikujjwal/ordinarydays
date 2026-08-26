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

describe('nesting stays two levels deep', () => {
  it('refuses a prep task assembled onto a task that already has one', async () => {
    const plan = await createPlan();
    const middle = await dataOf(
      await post('/v1/activities', {
        objectKind: 'task',
        type: 'task',
        title: 'Sort the garage',
      }),
    );
    const leaf = await dataOf(
      await createChild(middle.activityId, { title: 'Find the boxes' }),
    );

    const res = await patch(
      middle.activityId,
      { parentActivityId: plan.activityId },
      middle.updatedAt,
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
    const rows = body.data.days.flatMap(
      (day: {
        schedule: { title: string; subtitle?: string }[];
        anytime: { title: string; subtitle?: string }[];
      }) => [...day.schedule, ...day.anytime],
    );

    expect(rows).toContainEqual(
      expect.objectContaining({
        title: 'Return the rental car',
        subtitle: 'Poconos trip',
      }),
    );
  });
});
