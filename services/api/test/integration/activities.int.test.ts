import { MAX_AUTOMATIC_INTENT_AGE_DAYS } from '@od/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { authedHeaders, withUser } from '../helpers/auth.js';
import { useTestTable } from './harness.js';

/**
 * `POST /v1/activities` against a real DynamoDB Local (P1-11).
 *
 * The unit suite proves the right transaction is composed. What it cannot prove is that the
 * transaction lands: that the index entry really goes in the bucket the agenda will query,
 * that a retry with the same key really returns the first response instead of creating a
 * second activity, and that a rejected body really leaves the table untouched.
 *
 * The empty table between tests is doing more work here than it looks. Before P1-28 this file
 * swept the two users' `USER#` partitions **and** their `RATE#` counters by hand, the latter
 * added after the suite grew past the limiter's 120-per-minute budget and began answering
 * `429` — which surfaced as four unrelated-looking failures, none of them about rate limiting.
 * Truncating the whole table covers that partition and every other one nobody has thought of
 * yet.
 */
useTestTable();

type Base = typeof import('../../src/repositories/base.js');
type Keys = typeof import('../../src/repositories/keys.js');
type Repo = typeof import('../../src/repositories/activityRepository.js');
type Tx = typeof import('../../src/repositories/tx.js');

let base: Base;
let keys: Keys;
let repo: Repo;
let tx: Tx;

/** The id `LocalIdentityProvider` resolves, which is what the real app will read as. */
const DEV = 'usr_local_dev';
const OTHER = 'usr_int_activities_other';
const TEST_TODAY = new Date().toISOString().slice(0, 10);
const TEST_TODAY_WEEKDAY = new Date(`${TEST_TODAY}T00:00:00.000Z`).getUTCDay();
const TEST_TOMORROW_DATE = new Date(`${TEST_TODAY}T12:00:00.000Z`);
TEST_TOMORROW_DATE.setUTCDate(TEST_TOMORROW_DATE.getUTCDate() + 1);
const TEST_TOMORROW = TEST_TOMORROW_DATE.toISOString().slice(0, 10);
const TEST_TOMORROW_WEEKDAY = TEST_TOMORROW_DATE.getUTCDay();

beforeAll(async () => {
  base = await import('../../src/repositories/base.js');
  keys = await import('../../src/repositories/keys.js');
  repo = await import('../../src/repositories/activityRepository.js');
  tx = await import('../../src/repositories/tx.js');
});

const post = (body: unknown, options: { key?: string; userId?: string } = {}) =>
  withUser(options.userId).fetch(
    new Request('http://localhost/v1/activities', {
      method: 'POST',
      headers: authedHeaders({ idempotencyKey: options.key ?? crypto.randomUUID() }),
      body: JSON.stringify(body),
    }),
  );

/** Every index entry in one user's partition, whatever bucket it is in. */
const indexRows = async (userId: string) =>
  (
    await base.queryAll<Record<string, unknown>>({ pk: keys.userProfile(userId).pk })
  ).filter((row) => row.entity === 'ActivityIndex');

const TASK = { objectKind: 'task', type: 'task', title: 'Buy milk' } as const;

describe('a minimal body', () => {
  it('creates a saved activity with every derived field', async () => {
    const res = await post(TASK);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({
      objectKind: 'task',
      type: 'task',
      title: 'Buy milk',
      status: 'saved',
      ownerId: DEV,
      participantCount: 0,
      childCount: 0,
      expenseTotalCents: 0,
      visibility: 'private',
      schemaVersion: 1,
    });
    expect(body.data.lastActivityAt).toBe(body.data.createdAt);
  });

  it('stores a row the next read finds', async () => {
    const { data } = await (await post(TASK)).json();

    const stored = await repo.getActivityMeta(data.activityId);

    expect(stored).toMatchObject({ activityId: data.activityId, title: 'Buy milk' });
  });

  it('writes exactly one index entry for the owner', async () => {
    const { data } = await (await post(TASK)).json();

    const rows = await indexRows(DEV);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastActivityAt).toBe(data.createdAt);
  });

  it('returns a body the shared activity schema accepts', async () => {
    const { activity } = await import('@od/shared/schemas');
    const { data } = await (await post(TASK)).json();

    expect(activity.safeParse(data).success).toBe(true);
  });

  it('leaks no storage attribute', async () => {
    const { data } = await (await post(TASK)).json();

    expect(data).not.toHaveProperty('pk');
    expect(data).not.toHaveProperty('sk');
    expect(data).not.toHaveProperty('entity');
  });
});

describe('a body with a date', () => {
  it('creates a scheduled activity in the #S bucket', async () => {
    const { data } = await (
      await post({
        ...TASK,
        schedule: { date: '2026-08-15', time: '19:30', timezone: 'America/New_York' },
      })
    ).json();

    expect(data.status).toBe('scheduled');

    const [entry] = await indexRows(DEV);
    expect(entry?.gsi1pk).toBe(`U#${DEV}#S`);
    expect(String(entry?.gsi1sk)).toContain('2026-08-15');
  });

  /** Derived, and stored alongside the wall-clock fields rather than instead of them. */
  it('derives the UTC instant and keeps the wall-clock truth', async () => {
    const { data } = await (
      await post({
        ...TASK,
        schedule: { date: '2026-08-15', time: '19:30', timezone: 'America/New_York' },
      })
    ).json();

    expect(data.schedule).toMatchObject({
      date: '2026-08-15',
      time: '19:30',
      timezone: 'America/New_York',
      scheduledAtUtc: '2026-08-15T23:30:00.000Z',
    });
  });

  /** An undated Task goes to Anytime, an undated Plan to Needs a date — same title. */
  it('puts an undated task in #N and an undated plan in #P', async () => {
    await post(TASK);
    const [task] = await indexRows(DEV);
    expect(task?.gsi1pk).toBe(`U#${DEV}#N`);

    await post(
      { objectKind: 'plan', type: 'custom', title: 'Buy milk' },
      { userId: OTHER },
    );
    const [plan] = await indexRows(OTHER);
    expect(plan?.gsi1pk).toBe(`U#${OTHER}#P`);
  });
});

/**
 * The explicit-intent gate, run end to end against the table: a title with no target writes
 * **nothing**, and the same title under two targets produces two different objects
 * (`definition-of-done.md` §3.1).
 */
describe('the target is the caller’s, never inferred', () => {
  it.each([
    ['a title alone', { title: 'Buy milk' }],
    ['type without objectKind', { title: 'Buy milk', type: 'task' }],
    ['objectKind without type', { title: 'Buy milk', objectKind: 'plan' }],
    ['an incompatible pair', { title: 'Buy milk', objectKind: 'plan', type: 'task' }],
  ])('400s %s and writes nothing at all', async (_why, body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(await indexRows(DEV)).toHaveLength(0);
  });

  it('stores one identical title as whichever the caller chose', async () => {
    const asTask = await (await post({ ...TASK, title: 'Dinner with Sam' })).json();
    const asPlan = await (
      await post({ objectKind: 'plan', type: 'custom', title: 'Dinner with Sam' })
    ).json();

    expect(await repo.getActivityMeta(asTask.data.activityId)).toMatchObject({
      objectKind: 'task',
      type: 'task',
    });
    expect(await repo.getActivityMeta(asPlan.data.activityId)).toMatchObject({
      objectKind: 'plan',
      type: 'custom',
    });
  });
});

/**
 * A retry that the phone could not confirm must not produce a second activity — the failure
 * mode `Idempotency-Key` exists for, and the one a user would report as "it saved twice"
 * (`api-contract.md` §1, P1-04).
 */
describe('a retried create', () => {
  it('returns the original 201 response, and creates nothing new', async () => {
    const key = crypto.randomUUID();

    const first = await post(TASK, { key });
    const firstBody = await first.json();

    const retry = await post(TASK, { key });
    const retryBody = await retry.json();

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retryBody.data.activityId).toBe(firstBody.data.activityId);
    expect(await indexRows(DEV)).toHaveLength(1);
  });

  it('is not confused by a different key, which is a different request', async () => {
    await post(TASK, { key: crypto.randomUUID() });
    await post(TASK, { key: crypto.randomUUID() });

    expect(await indexRows(DEV)).toHaveLength(2);
  });

  it('returns two identical 201 responses but commits once when first attempts race', async () => {
    const key = crypto.randomUUID();

    const [first, second] = await Promise.all([post(TASK, { key }), post(TASK, { key })]);
    const [firstBody, secondBody] = await Promise.all([first.text(), second.text()]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(secondBody).toBe(firstBody);
    expect(await indexRows(DEV)).toHaveLength(1);
  });
});

describe('reminders at creation', () => {
  it('writes them into the activity’s own partition, for the creator alone', async () => {
    const { data } = await (
      await post({
        ...TASK,
        schedule: { date: '2026-08-15', time: '19:30', timezone: 'UTC' },
        reminders: [{ offsetMinutes: -15 }, { offsetMinutes: -60 }],
      })
    ).json();

    const partition = await repo.getActivityPartition(data.activityId);
    const reminders = partition.filter((row) => row.entity === 'Reminder');

    expect(reminders).toHaveLength(2);
    expect(reminders.every((row) => row.userId === DEV)).toBe(true);
  });

  it('rejects reminders on an undated activity and writes nothing', async () => {
    const res = await post({ ...TASK, reminders: [{ offsetMinutes: 0 }] });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(await indexRows(DEV)).toHaveLength(0);
  });
});

describe('a prep task', () => {
  it('is created under its plan, and the plan gains a pointer to it', async () => {
    const plan = await (
      await post({ objectKind: 'plan', type: 'custom', title: 'Trip' })
    ).json();

    const child = await (
      await post({ ...TASK, title: 'Book hotel', parentActivityId: plan.data.activityId })
    ).json();

    expect(child.data.parentActivityId).toBe(plan.data.activityId);

    const pointers = await repo.listChildPointers(plan.data.activityId);
    expect(pointers).toHaveLength(1);
    expect(pointers[0]).toMatchObject({ childActivityId: child.data.activityId });
  });

  /** Two levels, and the third is refused rather than flattened. */
  it('cannot have a prep task of its own', async () => {
    const plan = await (
      await post({ objectKind: 'plan', type: 'custom', title: 'Trip' })
    ).json();
    const child = await (
      await post({ ...TASK, title: 'Book hotel', parentActivityId: plan.data.activityId })
    ).json();

    const res = await post({
      ...TASK,
      title: 'Compare prices',
      parentActivityId: child.data.activityId,
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify((await res.json()).error.details)).toContain(
      'parentActivityId',
    );
  });

  /**
   * Guessing a parent id belonging to somebody else is `404`, never `403` — so the endpoint
   * cannot be used to discover that an activity exists.
   */
  it('404s a parent belonging to another user, and creates nothing', async () => {
    const theirs = await (
      await post(
        { objectKind: 'plan', type: 'custom', title: 'Their trip' },
        { userId: OTHER },
      )
    ).json();

    const res = await post({ ...TASK, parentActivityId: theirs.data.activityId });

    expect(res.status).toBe(404);
    expect(await indexRows(DEV)).toHaveLength(0);
  });
});

/**
 * `GET /v1/activities/:id` (P1-12), against the real partition.
 *
 * The unit suite proves the projection filters. What only a table proves is that the single
 * `Query` behind it really returns everybody's rows in the first place — which is why the
 * filter has to exist, and what a mocked partition can only assert by construction.
 */
describe('reading one activity back', () => {
  const read = (id: string, userId?: string) =>
    withUser(userId).fetch(
      new Request(`http://localhost/v1/activities/${id}`, { headers: authedHeaders() }),
    );

  it('returns what was written, in named collections', async () => {
    const { data } = await (await post(TASK)).json();

    const res = await read(data.activityId);
    const body = await res.json();

    expect(res.status).toBe(200);
    /**
     * Each collection is **added** as its phase lands rather than changing the envelope —
     * `updates` is P3-19's. An activity with no feed still carries the key, as an empty array,
     * so a client never has to tell "no entries" from "this server does not have the feed".
     */
    expect(Object.keys(body.data).sort()).toEqual([
      'activity',
      'capabilities',
      'completedOccurrenceCount',
      'reminders',
      'updates',
    ]);
    expect(body.data.updates).toEqual([]);
    expect(body.data.completedOccurrenceCount).toBe(0);
    expect(body.data.activity).toMatchObject({
      activityId: data.activityId,
      title: 'Buy milk',
      objectKind: 'task',
      type: 'task',
      ownerId: DEV,
    });
  });

  it('returns a body the shared detail schema accepts', async () => {
    const { activityDetail } = await import('@od/shared/schemas');
    const { data } = await (
      await post({
        ...TASK,
        schedule: { date: '2026-08-15', time: '19:30', timezone: 'UTC' },
        reminders: [{ offsetMinutes: -15 }],
      })
    ).json();

    const body = await (await read(data.activityId)).json();

    expect(activityDetail.safeParse(body.data).success).toBe(true);
  });

  it('returns the caller’s reminders on it', async () => {
    const { data } = await (
      await post({
        ...TASK,
        schedule: { date: '2026-08-15', time: '19:30', timezone: 'UTC' },
        reminders: [{ offsetMinutes: -15 }, { offsetMinutes: -60 }],
      })
    ).json();

    const body = await (await read(data.activityId)).json();

    expect(body.data.reminders).toHaveLength(2);
    expect(body.data.reminders.every((r: { userId: string }) => r.userId === DEV)).toBe(
      true,
    );
  });

  it('leaks no storage attribute from the real stored rows', async () => {
    const { data } = await (
      await post({
        ...TASK,
        schedule: { date: '2026-08-15', time: '19:30', timezone: 'UTC' },
        reminders: [{ offsetMinutes: -15 }],
      })
    ).json();

    const body = await (await read(data.activityId)).json();

    for (const shape of [body.data.activity, body.data.reminders[0]]) {
      expect(shape).not.toHaveProperty('pk');
      expect(shape).not.toHaveProperty('sk');
      expect(shape).not.toHaveProperty('entity');
    }
  });

  /**
   * **The filter, proved against the partition that makes it necessary.** Two users' reminder
   * rows are written into one activity's partition by hand — Phase 1 has no way to do it
   * through the API, since only the creator can add one — and each reader sees exactly their
   * own (`security-privacy.md` §1 row 15).
   */
  it('returns only the caller’s reminders from a partition holding two users’', async () => {
    const { data } = await (
      await post({
        ...TASK,
        schedule: { date: '2026-08-15', time: '19:30', timezone: 'UTC' },
        reminders: [{ offsetMinutes: -15 }],
      })
    ).json();

    const theirReminder = 'rem_01J8XKQ2M4N5P6R7S8T9V0W1BB';
    await base.putItem({
      ...keys.reminder(data.activityId, OTHER, theirReminder),
      entity: 'Reminder',
      reminderId: theirReminder,
      activityId: data.activityId,
      userId: OTHER,
      offsetMinutes: -90,
      channel: 'push',
      schemaVersion: 1,
    });

    // The partition really does hold both — otherwise the assertion below proves nothing.
    const partition = await repo.getActivityPartition(data.activityId);
    expect(partition.filter((row) => row.entity === 'Reminder')).toHaveLength(2);

    const raw = await (await read(data.activityId)).text();
    const body = JSON.parse(raw);

    expect(body.data.reminders).toHaveLength(1);
    expect(body.data.reminders[0].userId).toBe(DEV);
    expect(raw).not.toContain(OTHER);
    expect(raw).not.toContain(theirReminder);
    expect(raw).not.toContain('-90');
  });

  it('404s another user’s activity rather than 403ing it', async () => {
    const theirs = await (await post(TASK, { userId: OTHER })).json();

    const res = await read(theirs.data.activityId);

    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toBe('Activity not found.');
  });

  it('404s an activity that does not exist', async () => {
    const res = await read('act_01J8XKQ2M4N5P6R7S8T9V0W1ZZ');

    expect(res.status).toBe(404);
  });
});

/**
 * `PATCH /v1/activities/:id` (P1-13), against the real table.
 *
 * The unit suite proves the right transaction is composed. What only a table proves is that
 * the condition on `updatedAt` actually cancels a stale write and that a kind change leaves
 * the reminder rows in the partition alone. Schedule moves use the dedicated POST below.
 */
describe('patching an activity', () => {
  const patch = (
    id: string,
    body: unknown,
    options: { ifMatch?: string; userId?: string } = {},
  ) =>
    withUser(options.userId).fetch(
      new Request(`http://localhost/v1/activities/${id}`, {
        method: 'PATCH',
        headers: {
          ...authedHeaders(),
          ...(options.ifMatch === undefined ? {} : { 'If-Match': options.ifMatch }),
        },
        body: JSON.stringify(body),
      }),
    );

  const created = async (body: unknown = TASK) => (await (await post(body)).json()).data;

  const schedule = (id: string, body: unknown, userId?: string) =>
    withUser(userId).fetch(
      new Request(`http://localhost/v1/activities/${id}/schedule`, {
        method: 'POST',
        headers: authedHeaders({ idempotencyKey: crypto.randomUUID() }),
        body: JSON.stringify(body),
      }),
    );

  it('applies the change and bumps updatedAt', async () => {
    const activity = await created();

    const res = await patch(
      activity.activityId,
      { title: 'Buy oat milk' },
      { ifMatch: activity.updatedAt },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.title).toBe('Buy oat milk');
    expect(body.data.updatedAt).not.toBe(activity.updatedAt);
    expect(body.data.lastActivityAt).toBe(activity.lastActivityAt);
  });

  it('keeps a captured If-Match valid after discussion activity moves', async () => {
    const createdPlan = await created({
      objectKind: 'plan',
      type: 'custom',
      title: 'Dinner sometime',
    });
    const before = await repo.getActivityMeta(createdPlan.activityId);
    if (before === undefined) throw new Error('Expected the created Activity META row');
    const capturedIfMatch = before.updatedAt;
    const touchedAt = '2026-08-10T12:00:00.000Z';
    const items: Parameters<typeof repo.touchLastActivity>[3] = [];

    repo.touchLastActivity(before, touchedAt, [DEV], items);
    await tx.transactWrite(items, { operation: 'touchLastActivityTest' });

    const touched = await repo.getActivityMeta(createdPlan.activityId);
    expect(touched?.lastActivityAt).toBe(touchedAt);
    expect(touched?.updatedAt).toBe(capturedIfMatch);

    const res = await patch(
      createdPlan.activityId,
      { title: 'Dinner at Zahav' },
      { ifMatch: capturedIfMatch },
    );

    expect(res.status).toBe(200);
  });

  it('persists, so the next read sees it', async () => {
    const activity = await created();
    await patch(
      activity.activityId,
      { title: 'Buy oat milk' },
      { ifMatch: activity.updatedAt },
    );

    expect(await repo.getActivityMeta(activity.activityId)).toMatchObject({
      title: 'Buy oat milk',
    });
  });

  /** The condition on the item is what makes the guarantee real against a live table. */
  it('409s a stale If-Match, names the current value, and changes nothing', async () => {
    const activity = await created();
    await patch(activity.activityId, { title: 'First' }, { ifMatch: activity.updatedAt });

    const res = await patch(
      activity.activityId,
      { title: 'Second' },
      { ifMatch: activity.updatedAt },
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.details?.[0]?.path).toBe('updatedAt');
    expect(await repo.getActivityMeta(activity.activityId)).toMatchObject({
      title: 'First',
    });
  });

  it('400s a missing If-Match and changes nothing', async () => {
    const activity = await created();

    const res = await patch(activity.activityId, { title: 'Buy oat milk' });

    expect(res.status).toBe(400);
    expect(await repo.getActivityMeta(activity.activityId)).toMatchObject({
      title: 'Buy milk',
    });
  });

  it('404s a patch from a different user, and changes nothing', async () => {
    const activity = await created();

    const res = await patch(
      activity.activityId,
      { title: 'Theirs now' },
      { ifMatch: activity.updatedAt, userId: OTHER },
    );

    expect(res.status).toBe(404);
    expect(await repo.getActivityMeta(activity.activityId)).toMatchObject({
      title: 'Buy milk',
    });
  });

  it('rejects schedule on PATCH, leaving the sole POST path', async () => {
    const activity = await created();
    const res = await patch(
      activity.activityId,
      { schedule: { date: '2026-08-15', timezone: 'UTC' } },
      { ifMatch: activity.updatedAt },
    );
    expect(res.status).toBe(400);
  });

  /** One index entry after the POST move, not two — the whole-item re-put from P1-09. */
  it('POST /schedule moves a task to #N when cleared and leaves one index entry', async () => {
    const activity = await created({
      ...TASK,
      schedule: { date: '2026-08-15', timezone: 'America/New_York' },
    });
    expect(activity.status).toBe('scheduled');

    const body = await (await schedule(activity.activityId, { date: null })).json();

    expect(body.data.activity.status).toBe('saved');

    const rows = await indexRows(DEV);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.gsi1pk).toBe(`U#${DEV}#N`);
  });

  it('POST /schedule moves an undated task to #S when a date is added', async () => {
    const activity = await created();

    const body = await (
      await schedule(activity.activityId, { date: '2026-08-15', timezone: 'UTC' })
    ).json();
    expect(body.data.activity.status).toBe('scheduled');

    const rows = await indexRows(DEV);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.gsi1pk).toBe(`U#${DEV}#S`);
  });

  it('reschedules one recurring occurrence into one OCC row without changing the series', async () => {
    const activity = await created({
      ...TASK,
      schedule: { date: '2026-08-01', time: '18:00', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
      },
    });
    const before = await repo.getActivityMeta(activity.activityId);

    const res = await schedule(activity.activityId, {
      date: '2026-08-11',
      time: '19:30',
      timezone: 'UTC',
      occurrenceDate: '2026-08-11',
    });

    expect(res.status).toBe(200);
    expect(await repo.getActivityMeta(activity.activityId)).toEqual(before);
    expect(
      (await repo.getActivityPartition(activity.activityId)).filter(
        (row) => row.entity === 'Occurrence',
      ),
    ).toEqual([
      expect.objectContaining({
        sk: 'OCC#2026-08-11',
        status: 'rescheduled',
        overrideTime: '19:30',
      }),
    ]);
  });

  it('writes a cross-day occurrence source and destination marker atomically', async () => {
    const activity = await created({
      ...TASK,
      schedule: { date: '2026-08-01', time: '18:00', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
      },
    });
    const before = await repo.getActivityMeta(activity.activityId);

    const res = await schedule(activity.activityId, {
      date: '2026-08-13',
      time: '19:30',
      timezone: 'UTC',
      occurrenceDate: '2026-08-11',
    });

    expect(res.status).toBe(200);
    expect(await repo.getActivityMeta(activity.activityId)).toEqual(before);
    const rows = await repo.getActivityPartition(activity.activityId);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sk: 'OCC#2026-08-11',
          status: 'rescheduled',
          overrideDate: '2026-08-13',
          overrideTime: '19:30',
        }),
        expect.objectContaining({
          sk: 'MOVE#2026-08-13',
          entity: 'OccurrenceMoveMarker',
          movedFrom: ['2026-08-11'],
        }),
      ]),
    );
  });

  it('replaces an active segment created today while no occurrence history exists', async () => {
    const activity = await created({
      ...TASK,
      schedule: { date: TEST_TODAY, time: '18:00', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TEST_TODAY }],
      },
    });

    const res = await patch(
      activity.activityId,
      {
        recurrence: {
          mode: 'fixed',
          segments: [
            {
              freq: 'weekly',
              interval: 1,
              byWeekday: [TEST_TODAY_WEEKDAY],
              effectiveFrom: TEST_TODAY,
            },
          ],
        },
      },
      { ifMatch: activity.updatedAt },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.recurrence.segments).toEqual([
      {
        freq: 'weekly',
        interval: 1,
        byWeekday: [TEST_TODAY_WEEKDAY],
        effectiveFrom: TEST_TODAY,
        time: '18:00',
      },
    ]);
  });

  it('rejects a same-day replacement after today has occurrence history', async () => {
    const activity = await created({
      ...TASK,
      schedule: { date: TEST_TODAY, time: '18:00', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TEST_TODAY }],
      },
    });
    const completed = await withUser().fetch(
      new Request(`http://localhost/v1/activities/${activity.activityId}/complete`, {
        method: 'POST',
        headers: authedHeaders({ idempotencyKey: crypto.randomUUID() }),
        body: JSON.stringify({ occurrenceDate: TEST_TODAY }),
      }),
    );
    expect(completed.status).toBe(200);

    const res = await patch(
      activity.activityId,
      {
        recurrence: {
          mode: 'fixed',
          segments: [{ freq: 'weekdays', effectiveFrom: TEST_TODAY }],
        },
      },
      { ifMatch: activity.updatedAt },
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.message).toContain('already has history');
    expect((await repo.getActivityMeta(activity.activityId))?.recurrence).toEqual(
      activity.recurrence,
    );
  });

  it('appends an all-future segment while preserving history and occurrence overrides', async () => {
    const activity = await created({
      ...TASK,
      schedule: { date: '2026-08-01', time: '18:00', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
      },
    });
    await schedule(activity.activityId, {
      date: '2026-08-09',
      time: '17:00',
      timezone: 'UTC',
      occurrenceDate: '2026-08-09',
    });
    const occurrenceBefore = (
      await repo.getActivityPartition(activity.activityId)
    ).filter((row) => row.entity === 'Occurrence');
    const originalSegment = activity.recurrence.segments[0];

    const res = await patch(
      activity.activityId,
      {
        recurrence: {
          ...activity.recurrence,
          segments: [
            originalSegment,
            { freq: 'daily', effectiveFrom: '2099-01-01', time: '20:15' },
          ],
        },
        editedFromDate: '2026-08-11',
      },
      { ifMatch: activity.updatedAt },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.recurrence.segments[0]).toEqual(originalSegment);
    expect(body.data.recurrence.segments[1]).toEqual({
      freq: 'daily',
      effectiveFrom: '2026-08-11',
      time: '20:15',
    });
    expect(body.data.schedule.time).toBe('20:15');
    expect(
      (await repo.getActivityPartition(activity.activityId)).filter(
        (row) => row.entity === 'Occurrence',
      ),
    ).toEqual(occurrenceBefore);
  });

  it('runs the stabilized recurrence story without leaking occurrence state onto META', async () => {
    const activity = await created({
      ...TASK,
      schedule: { date: TEST_TODAY, time: '18:00', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TEST_TODAY }],
      },
    });
    const originalMeta = await repo.getActivityMeta(activity.activityId);

    const completed = await withUser().fetch(
      new Request(`http://localhost/v1/activities/${activity.activityId}/complete`, {
        method: 'POST',
        headers: authedHeaders({ idempotencyKey: crypto.randomUUID() }),
        body: JSON.stringify({ occurrenceDate: TEST_TODAY }),
      }),
    );
    expect(completed.status).toBe(200);
    expect(await repo.getActivityMeta(activity.activityId)).toEqual(originalMeta);

    const tomorrowAgenda = await withUser().fetch(
      new Request(
        `http://localhost/v1/agenda?from=${TEST_TOMORROW}&to=${TEST_TOMORROW}&tz=UTC&include=anytime_unscheduled,overdue`,
        { headers: authedHeaders({ timezone: 'UTC' }) },
      ),
    );
    const tomorrowBody = await tomorrowAgenda.json();
    const tomorrowRows = [
      ...tomorrowBody.data.days[0].schedule,
      ...tomorrowBody.data.days[0].anytime,
      ...tomorrowBody.data.days[0].earlier,
    ];
    expect(tomorrowRows).toContainEqual(
      expect.objectContaining({ activityId: activity.activityId, status: 'scheduled' }),
    );

    const rescheduled = await schedule(activity.activityId, {
      date: TEST_TOMORROW,
      time: '19:30',
      timezone: 'UTC',
      occurrenceDate: TEST_TOMORROW,
    });
    expect(rescheduled.status).toBe(200);
    expect(await repo.getActivityMeta(activity.activityId)).toEqual(originalMeta);

    const future = await patch(
      activity.activityId,
      {
        recurrence: {
          ...activity.recurrence,
          segments: [
            ...activity.recurrence.segments,
            {
              freq: 'weekly',
              interval: 1,
              byWeekday: [TEST_TOMORROW_WEEKDAY],
              effectiveFrom: TEST_TOMORROW,
            },
          ],
        },
        editedFromDate: TEST_TOMORROW,
      },
      { ifMatch: activity.updatedAt },
    );
    const futureBody = await future.json();
    expect(future.status).toBe(200);
    expect(futureBody.data.recurrence.segments).toHaveLength(2);

    const converted = await withUser().fetch(
      new Request(
        `http://localhost/v1/activities/${activity.activityId}/recurrence/convert`,
        {
          method: 'POST',
          headers: authedHeaders({ idempotencyKey: crypto.randomUUID() }),
          body: JSON.stringify({ occurrenceDate: TEST_TOMORROW }),
        },
      ),
    );
    const convertedBody = await converted.json();
    expect(converted.status).toBe(200);
    expect(convertedBody.data).not.toHaveProperty('recurrence');
    expect(convertedBody.data.schedule).toEqual({
      date: TEST_TOMORROW,
      time: '19:30',
      timezone: 'UTC',
      scheduledAtUtc: `${TEST_TOMORROW}T19:30:00.000Z`,
    });
    expect(
      (await repo.getActivityPartition(activity.activityId)).filter(
        (row) => row.entity === 'Occurrence',
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sk: `OCC#${TEST_TODAY}`, status: 'completed' }),
        expect.objectContaining({ sk: `OCC#${TEST_TOMORROW}`, status: 'rescheduled' }),
      ]),
    );
    expect(
      (await indexRows(DEV)).find((row) => row.activityId === activity.activityId),
    ).toMatchObject({ gsi1pk: `U#${DEV}#S`, status: 'scheduled' });

    const ending = await created({
      ...TASK,
      title: 'End and restart series',
      schedule: { date: TEST_TODAY, time: '20:00', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TEST_TODAY }],
      },
    });
    const ended = await patch(
      ending.activityId,
      { recurrence: { ...ending.recurrence, endDate: TEST_TODAY } },
      { ifMatch: ending.updatedAt },
    );
    const endedBody = await ended.json();
    expect(ended.status).toBe(200);
    expect(endedBody.data.recurrence.endDate).toBe(TEST_TODAY);

    const {
      endDate: _endDate,
      count: _count,
      ...openRecurrence
    } = endedBody.data.recurrence;
    const restarted = await patch(
      ending.activityId,
      { recurrence: openRecurrence },
      { ifMatch: endedBody.data.updatedAt },
    );
    const restartedBody = await restarted.json();
    expect(restarted.status).toBe(200);
    expect(restartedBody.data.recurrence).not.toHaveProperty('endDate');
    expect(restartedBody.data.recurrence).not.toHaveProperty('count');
  });
});

/**
 * The conversion case P1-13 names, end to end: a Watch with a full payload becomes a Task,
 * the type-specific fields go, the common fields stay, and **every reminder row survives**.
 */
describe('converting a plan to a task', () => {
  const watchPlan = async () =>
    (
      await (
        await post({
          objectKind: 'plan',
          type: 'watch',
          title: 'Severance',
          notes: 'Start from the beginning',
          schedule: { date: '2026-08-15', time: '19:30', timezone: 'UTC' },
          reminders: [{ offsetMinutes: -15 }],
          details: {
            kind: 'watch',
            mediaTitle: 'Severance',
            season: 2,
            episode: 4,
            service: 'Apple TV+',
          },
        })
      ).json()
    ).data;

  const convert = (id: string, ifMatch: string, body: unknown) =>
    withUser().fetch(
      new Request(`http://localhost/v1/activities/${id}`, {
        method: 'PATCH',
        headers: { ...authedHeaders(), 'If-Match': ifMatch },
        body: JSON.stringify(body),
      }),
    );

  it('drops the watch payload and keeps title, notes and schedule', async () => {
    const plan = await watchPlan();

    const body = await (
      await convert(plan.activityId, plan.updatedAt, {
        objectKind: 'task',
        type: 'task',
      })
    ).json();

    expect(body.data).toMatchObject({
      objectKind: 'task',
      type: 'task',
      title: 'Severance',
      notes: 'Start from the beginning',
      details: { kind: 'task' },
    });
    expect(body.data.schedule.date).toBe('2026-08-15');
  });

  /**
   * **The reminders are separate items and the conversion must not touch them.** A reminder
   * belongs to its user and says nothing about what kind of thing the activity is.
   */
  it('leaves every reminder row in the partition untouched', async () => {
    const plan = await watchPlan();
    const before = (await repo.getActivityPartition(plan.activityId)).filter(
      (row) => row.entity === 'Reminder',
    );
    expect(before).toHaveLength(1);

    await convert(plan.activityId, plan.updatedAt, { objectKind: 'task', type: 'task' });

    const after = (await repo.getActivityPartition(plan.activityId)).filter(
      (row) => row.entity === 'Reminder',
    );
    expect(after).toEqual(before);
  });

  it('stores the dropped payload nowhere on the row', async () => {
    const plan = await watchPlan();

    await convert(plan.activityId, plan.updatedAt, { objectKind: 'task', type: 'task' });

    const stored = await repo.getActivityMeta(plan.activityId);
    expect(stored?.details).toEqual({ kind: 'task' });
    expect(JSON.stringify(stored)).not.toContain('Apple TV+');
  });

  /**
   * The same request with one participant is refused — and refused **before anything is
   * written**, which is what "never deletes coordinated data as a side effect" means in
   * practice.
   */
  it('409s once the plan has a participant, and changes nothing', async () => {
    const plan = await watchPlan();

    // Phase 1 has no endpoint that adds a participant, so the count is set directly — the
    // conversion reads it from the stored row exactly as it would in Phase 6.
    await base.putItem({
      ...keys.activityMeta(plan.activityId),
      ...(await repo.getActivityMeta(plan.activityId)),
      participantCount: 1,
    });
    const withParticipant = await repo.getActivityMeta(plan.activityId);

    const res = await convert(plan.activityId, String(withParticipant?.updatedAt), {
      objectKind: 'task',
      type: 'task',
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.message).toBe('Remove 1 person before changing this to a Task.');
    expect(await repo.getActivityMeta(plan.activityId)).toMatchObject({
      objectKind: 'plan',
      type: 'watch',
    });
  });
});

/**
 * `DELETE /v1/activities/:id` and its cascade (P1-14), against the real table.
 *
 * The unit suite proves the right keys are handed to a batch delete. What only a table proves
 * is that the partition is genuinely empty afterwards, that the prep task is genuinely still
 * there, and that a second delete finds nothing rather than half a row.
 */
describe('deleting an activity', () => {
  const remove = (id: string, userId?: string) =>
    withUser(userId).fetch(
      new Request(`http://localhost/v1/activities/${id}`, {
        method: 'DELETE',
        headers: authedHeaders(),
      }),
    );

  const plan = async () =>
    (
      await (
        await post({ objectKind: 'plan', type: 'custom', title: 'Paris weekend' })
      ).json()
    ).data;

  it('removes every item under the activity', async () => {
    const subject = (
      await (
        await post({
          ...TASK,
          schedule: { date: '2026-08-15', time: '19:30', timezone: 'UTC' },
          reminders: [{ offsetMinutes: -15 }, { offsetMinutes: -60 }],
        })
      ).json()
    ).data;
    expect(await repo.getActivityPartition(subject.activityId)).toHaveLength(3);

    const res = await remove(subject.activityId);

    expect(res.status).toBe(200);
    /**
     * **The tombstone is the one row that survives** (P2-49). Everything the activity was —
     * META, its reminders, its pointers — is gone; what remains is a marker that this id was
     * used and deleted, so a create replayed from an offline queue cannot resurrect it. This
     * assertion is deliberately exact rather than relaxed to `toHaveLength(1)`: a second
     * surviving row would be a leak, and naming the survivor is what makes that visible.
     */
    const remaining = await repo.getActivityPartition(subject.activityId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ sk: 'TOMBSTONE', entity: 'ActivityTombstone' });
  });

  it('removes the index entry, so it leaves no feed', async () => {
    const subject = await plan();

    await remove(subject.activityId);

    expect(await indexRows(DEV)).toHaveLength(0);
  });

  /**
   * **The rule this cascade exists to get right.** A user who cancels a trip may still need
   * to return the rental car (`today-and-tasks.md` §5.5).
   */
  it('leaves the prep task behind, as an ordinary task', async () => {
    const parent = await plan();
    const child = (
      await (
        await post({ ...TASK, title: 'Book hotel', parentActivityId: parent.activityId })
      ).json()
    ).data;

    await remove(parent.activityId);

    const survivor = await repo.getActivityMeta(child.activityId);
    expect(survivor).toMatchObject({ activityId: child.activityId, title: 'Book hotel' });
    expect(survivor).not.toHaveProperty('parentActivityId');
  });

  it('leaves the prep task on its own feed, with the parent title gone from it', async () => {
    const parent = await plan();
    const child = (
      await (
        await post({ ...TASK, title: 'Book hotel', parentActivityId: parent.activityId })
      ).json()
    ).data;

    await remove(parent.activityId);

    const rows = await indexRows(DEV);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.activityId).toBe(child.activityId);
    expect(rows[0]).not.toHaveProperty('subtitle');
  });

  /** Batched rather than transactional, so a retry finishes it — and finds nothing left. */
  it('404s a second delete, and does not throw', async () => {
    const subject = await plan();

    expect((await remove(subject.activityId)).status).toBe(200);

    const second = await remove(subject.activityId);
    expect(second.status).toBe(404);
    expect((await second.json()).error.code).toBe('not_found');
  });

  it('404s another user’s activity, and leaves it entirely alone', async () => {
    const theirs = (await (await post(TASK, { userId: OTHER })).json()).data;

    const res = await remove(theirs.activityId, DEV);

    expect(res.status).toBe(404);
    expect(await repo.getActivityMeta(theirs.activityId)).toBeDefined();
    expect(await indexRows(OTHER)).toHaveLength(1);
  });

  it('404s an activity that never existed', async () => {
    expect((await remove('act_01J8XKQ2M4N5P6R7S8T9V0W1ZZ')).status).toBe(404);
  });
});

/**
 * `POST /v1/activities/:id/duplicate` (P1-15), against the real table.
 *
 * The unit suite proves the copy carries the right fields. What only a table proves is that
 * the copy is a **second row with its own index entry**, that the original is untouched, and
 * that the reminders on the original stay on the original.
 */
describe('duplicating an activity', () => {
  const copy = (id: string, userId?: string) =>
    withUser(userId).fetch(
      new Request(`http://localhost/v1/activities/${id}/duplicate`, {
        method: 'POST',
        headers: authedHeaders({ idempotencyKey: crypto.randomUUID() }),
      }),
    );

  const watchPlan = async () =>
    (
      await (
        await post({
          objectKind: 'plan',
          type: 'watch',
          title: 'Severance',
          notes: 'Start from the beginning',
          location: { label: 'Living room' },
          schedule: { date: '2026-08-15', time: '19:30', timezone: 'UTC' },
          reminders: [{ offsetMinutes: -15 }],
          details: { kind: 'watch', mediaTitle: 'Severance', season: 2, episode: 4 },
        })
      ).json()
    ).data;

  it('creates a second activity, leaving the original exactly as it was', async () => {
    const original = await watchPlan();

    const res = await copy(original.activityId);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.activityId).not.toBe(original.activityId);
    expect(await repo.getActivityMeta(original.activityId)).toMatchObject({
      title: 'Severance',
      status: 'scheduled',
    });
  });

  it('carries the content and drops the schedule', async () => {
    const original = await watchPlan();

    const body = await (await copy(original.activityId)).json();

    expect(body.data).toMatchObject({
      objectKind: 'plan',
      type: 'watch',
      title: 'Severance (copy)',
      notes: 'Start from the beginning',
      location: { label: 'Living room' },
      details: { kind: 'watch', mediaTitle: 'Severance', season: 2, episode: 4 },
      status: 'saved',
    });
    expect(body.data).not.toHaveProperty('schedule');
  });

  /**
   * A reminder is an offset from a schedule the copy does not have. The original keeps its
   * own — the two partitions are entirely separate.
   */
  it('writes no reminder on the copy and leaves the original’s alone', async () => {
    const original = await watchPlan();

    const body = await (await copy(original.activityId)).json();

    const copied = await repo.getActivityPartition(body.data.activityId);
    expect(copied.filter((row) => row.entity === 'Reminder')).toHaveLength(0);
    expect(copied).toHaveLength(1);

    const source = await repo.getActivityPartition(original.activityId);
    expect(source.filter((row) => row.entity === 'Reminder')).toHaveLength(1);
  });

  /** Undated, so the copy lands in Needs a date while the original stays in Scheduled. */
  it('gives the copy its own index entry, in the bucket its lack of a date implies', async () => {
    const original = await watchPlan();

    const body = await (await copy(original.activityId)).json();

    const rows = await indexRows(DEV);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.activityId === original.activityId)?.gsi1pk).toBe(
      `U#${DEV}#S`,
    );
    expect(rows.find((row) => row.activityId === body.data.activityId)?.gsi1pk).toBe(
      `U#${DEV}#P`,
    );
  });

  /** A prep task's copy is not a second prep task — structure is not content. */
  it('does not attach the copy to the original’s parent plan', async () => {
    const parent = (
      await (await post({ objectKind: 'plan', type: 'custom', title: 'Trip' })).json()
    ).data;
    const child = (
      await (
        await post({ ...TASK, title: 'Book hotel', parentActivityId: parent.activityId })
      ).json()
    ).data;

    const body = await (await copy(child.activityId)).json();

    expect(body.data).not.toHaveProperty('parentActivityId');
    expect(await repo.listChildPointers(parent.activityId)).toHaveLength(1);
  });

  it('404s another user’s activity, and writes nothing', async () => {
    const theirs = (await (await post(TASK, { userId: OTHER })).json()).data;

    const res = await copy(theirs.activityId, DEV);

    expect(res.status).toBe(404);
    expect(await indexRows(DEV)).toHaveLength(0);
  });

  /** A retried duplicate is the case the header exists for: one copy, not two. */
  it('returns the first copy on a retry with the same key', async () => {
    const original = await watchPlan();
    const key = crypto.randomUUID();

    const send = () =>
      withUser().fetch(
        new Request(`http://localhost/v1/activities/${original.activityId}/duplicate`, {
          method: 'POST',
          headers: authedHeaders({ idempotencyKey: key }),
        }),
      );

    const first = await (await send()).json();
    const retry = await send();

    expect(retry.status).toBe(201);
    expect((await retry.json()).data.activityId).toBe(first.data.activityId);
    // The original plus exactly one copy.
    expect(await indexRows(DEV)).toHaveLength(2);
  });
});

/**
 * `GET /v1/activities?filter=` (P1-16), against the real index.
 *
 * The unit suite proves the right query is composed. What only a table proves is that the
 * four stages genuinely partition a user's activities — that nothing appears in two of them
 * and nothing falls through all four — and that a cursor really resumes where it stopped.
 */
describe('the flat lists', () => {
  const list = (query: string, userId?: string) =>
    withUser(userId).fetch(
      new Request(`http://localhost/v1/activities?${query}`, {
        // The `upcoming`/`past` split is drawn at the caller's current date, and every row
        // below is dated in UTC — so this is the one place the header is stated rather than
        // left at the helper's deliberately-not-UTC default.
        headers: authedHeaders({ timezone: 'UTC' }),
      }),
    );

  const ids = async (query: string, userId?: string) =>
    ((await (await list(query, userId)).json()).data as { activityId: string }[]).map(
      (row) => row.activityId,
    );

  /** One of each stage, so every assertion below is about partitioning rather than presence. */
  const fourStages = async () => {
    const past = (
      await (
        await post({
          ...TASK,
          title: 'Last week',
          schedule: { date: '2020-01-01', timezone: 'UTC' },
        })
      ).json()
    ).data;
    const upcoming = (
      await (
        await post({
          ...TASK,
          title: 'Next year',
          schedule: { date: '2099-01-01', timezone: 'UTC' },
        })
      ).json()
    ).data;
    const saved = (await (await post({ ...TASK, title: 'Whenever' })).json()).data;
    const needsDate = (
      await (await post({ objectKind: 'plan', type: 'custom', title: 'Someday' })).json()
    ).data;

    return { past, upcoming, saved, needsDate };
  };

  it('puts each activity in exactly one stage', async () => {
    const { past, upcoming, saved, needsDate } = await fourStages();

    expect(await ids('filter=past')).toEqual([past.activityId]);
    expect(await ids('filter=upcoming')).toEqual([upcoming.activityId]);
    expect(await ids('filter=saved')).toEqual([saved.activityId]);
    expect(await ids('filter=needs_date')).toEqual([needsDate.activityId]);
  });

  it('accounts for every activity across the four stages', async () => {
    const created = await fourStages();

    const seen = [
      ...(await ids('filter=past')),
      ...(await ids('filter=upcoming')),
      ...(await ids('filter=saved')),
      ...(await ids('filter=needs_date')),
    ];

    expect(seen.sort()).toEqual(
      Object.values(created)
        .map((row) => row.activityId)
        .sort(),
    );
  });

  it('returns rows the shared schema accepts', async () => {
    const { activityListItem } = await import('@od/shared/schemas');
    await fourStages();

    const body = await (await list('filter=upcoming')).json();

    expect(activityListItem.safeParse(body.data[0]).success).toBe(true);
  });

  it('orders upcoming earliest first and past latest first', async () => {
    const early = (
      await (
        await post({ ...TASK, schedule: { date: '2099-01-01', timezone: 'UTC' } })
      ).json()
    ).data;
    const late = (
      await (
        await post({ ...TASK, schedule: { date: '2099-06-01', timezone: 'UTC' } })
      ).json()
    ).data;
    const older = (
      await (
        await post({ ...TASK, schedule: { date: '2020-01-01', timezone: 'UTC' } })
      ).json()
    ).data;
    const newer = (
      await (
        await post({ ...TASK, schedule: { date: '2021-01-01', timezone: 'UTC' } })
      ).json()
    ).data;

    expect(await ids('filter=upcoming')).toEqual([early.activityId, late.activityId]);
    expect(await ids('filter=past')).toEqual([newer.activityId, older.activityId]);
  });

  /** A series is one row carrying `isRecurring`, never one row per occurrence. */
  it('returns a recurring series as a single row', async () => {
    await post({
      ...TASK,
      title: 'Gym',
      schedule: { date: '2099-01-01', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'weekly', effectiveFrom: '2099-01-01' }],
      },
    });

    // `#R` is the recurring bucket; none of the four stages read it, so a series appears in
    // none of them. That is the agenda's job, not this endpoint's.
    for (const filter of ['upcoming', 'past', 'saved', 'needs_date']) {
      expect(await ids(`filter=${filter}`)).toEqual([]);
    }
  });

  it('narrows by type', async () => {
    await post({ ...TASK, title: 'Whenever' });
    const meal = (
      await (await post({ objectKind: 'plan', type: 'meal', title: 'Tacos' })).json()
    ).data;

    expect(await ids('filter=needs_date&type=meal')).toEqual([meal.activityId]);
    expect(await ids('filter=needs_date&type=event')).toEqual([]);
  });

  /** A cursor resumes where the previous page stopped, with no row seen twice or skipped. */
  it('pages through a stage with a cursor', async () => {
    for (const day of ['2099-01-01', '2099-02-01', '2099-03-01']) {
      await post({ ...TASK, schedule: { date: day, timezone: 'UTC' } });
    }

    const first = await (await list('filter=upcoming&limit=2')).json();
    expect(first.data).toHaveLength(2);
    expect(first.meta.nextCursor).toBeDefined();

    const second = await (
      await list(
        `filter=upcoming&limit=2&cursor=${encodeURIComponent(first.meta.nextCursor)}`,
      )
    ).json();

    const seen = [...first.data, ...second.data].map(
      (row: { activityId: string }) => row.activityId,
    );
    expect(new Set(seen).size).toBe(3);
  });

  it('lists only the caller’s own activities', async () => {
    await post({ ...TASK, title: 'Mine' });
    await post({ ...TASK, title: 'Theirs' }, { userId: OTHER });

    expect(await ids('filter=saved')).toHaveLength(1);
    expect(await ids('filter=saved', OTHER)).toHaveLength(1);
  });

  it('400s a filter the enum no longer carries', async () => {
    expect((await list('filter=inbox')).status).toBe(400);
  });
});

/** Two users' activities are invisible to each other, before Phase 4 makes it matter. */
describe('tenant isolation', () => {
  it('gives each user their own index partition', async () => {
    await post(TASK);
    await post({ ...TASK, title: 'Their milk' }, { userId: OTHER });

    expect(await indexRows(DEV)).toHaveLength(1);
    expect(await indexRows(OTHER)).toHaveLength(1);
  });
});

/**
 * Durable creation against a real table (P2-49).
 *
 * The unit suite proves the transaction is composed with a conditional put and a tombstone
 * check. What only a database can prove is that those conditions actually fire: that a second
 * create on the same id is refused rather than overwriting, and that a tombstone written by a
 * delete really blocks a create replayed days later.
 */
describe('client-minted ids and deletion tombstones', () => {
  const CLIENT_ID = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
  const clientTask = (activityId: string, title = 'Written offline') => ({
    ...TASK,
    title,
    activityId,
  });

  const del = (activityId: string) =>
    withUser().fetch(
      new Request(`http://localhost/v1/activities/${activityId}`, {
        method: 'DELETE',
        headers: authedHeaders(),
      }),
    );

  const get = (activityId: string) =>
    withUser().fetch(
      new Request(`http://localhost/v1/activities/${activityId}`, {
        headers: authedHeaders(),
      }),
    );

  it('stores the client’s id verbatim and derives everything else', async () => {
    const res = await post(clientTask(CLIENT_ID));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.activityId).toBe(CLIENT_ID);
    expect(body.data.ownerId).toBe(DEV);
    expect(await repo.getActivityMeta(CLIENT_ID)).toMatchObject({
      activityId: CLIENT_ID,
      ownerId: DEV,
    });
  });

  /**
   * The lost-response replay, which is the case client-minted ids exist for.
   *
   * A create committed, its response never arrived, and the intent replayed later under a
   * **fresh** `Idempotency-Key` — a day later the original receipt is long gone, so
   * idempotency cannot answer and the conditional write is what stands between the user and a
   * duplicate. The client's documented recovery then reads its own id and finds it there.
   */
  it('refuses a replayed create and leaves exactly one activity behind', async () => {
    await post(clientTask(CLIENT_ID, 'The write that landed'));

    // A different key, as a replay after the receipt window would carry.
    const replay = await post(clientTask(CLIENT_ID, 'The replay'), {
      key: crypto.randomUUID(),
    });
    const body = await replay.json();

    expect(replay.status).toBe(409);
    expect(body.error.code).toBe('conflict');
    // The generic answer names neither owner nor entity (`data-model.md` §8).
    expect(JSON.stringify(body)).not.toContain(DEV);

    // One activity, and it is the one that landed first — the replay overwrote nothing.
    expect(await repo.getActivityMeta(CLIENT_ID)).toMatchObject({
      title: 'The write that landed',
    });
    expect(await indexRows(DEV)).toHaveLength(1);

    // And the recovery read the client would now perform succeeds on identity + ownership.
    const recovered = await get(CLIENT_ID);
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).data.activity.activityId).toBe(CLIENT_ID);
  });

  /**
   * Deleted on another device, then the offline queue replays the create.
   *
   * Without the tombstone this is a resurrection: `META` is gone, so `attribute_not_exists`
   * on its own would happily let the create through and the user would watch something they
   * deleted come back.
   */
  it('does not resurrect a deleted activity when its create replays', async () => {
    await post(clientTask(CLIENT_ID));
    expect((await del(CLIENT_ID)).status).toBe(200);

    const replay = await post(clientTask(CLIENT_ID), { key: crypto.randomUUID() });

    expect(replay.status).toBe(409);
    // Surfaced, never resurrected: no META came back and no index row was rebuilt.
    expect(await repo.getActivityMeta(CLIENT_ID)).toBeUndefined();
    expect(await indexRows(DEV)).toHaveLength(0);
  });

  it('keeps a tombstoned id at 404, so recovery surfaces rather than acknowledges', async () => {
    await post(clientTask(CLIENT_ID));
    await del(CLIENT_ID);

    /**
     * The `404` the client's collision recovery reads. It cannot distinguish this from a
     * foreign id, which is why that path parks the intent for the user rather than re-minting
     * — a fresh id would walk straight past this tombstone.
     */
    expect((await get(CLIENT_ID)).status).toBe(404);
  });

  it('writes a tombstone that outlives the automatic replay window', async () => {
    await post(clientTask(CLIENT_ID));
    const before = Date.now();
    await del(CLIENT_ID);

    const stored = await base.queryAll<Record<string, unknown>>({
      pk: keys.activityTombstone(CLIENT_ID).pk,
    });
    const tombstone = stored.find((row) => row.sk === 'TOMBSTONE');

    expect(tombstone).toMatchObject({ ownerId: DEV, entity: 'ActivityTombstone' });
    /**
     * The property the two windows share: a tombstone written at `deletedAt` expires at
     * `deletedAt + N`, and an intent created before that delete stops replaying at
     * `intentCreatedAt + N`. Since `intentCreatedAt ≤ deletedAt` for any intent that could
     * target this id, the tombstone always outlives it. Asserted against the same imported
     * constant, so tuning one without the other fails here.
     */
    const ttl = Number(tombstone?.ttl);
    expect(ttl).toBeGreaterThanOrEqual(
      Math.floor(before / 1000) + MAX_AUTOMATIC_INTENT_AGE_DAYS * 24 * 60 * 60,
    );
  });
});
