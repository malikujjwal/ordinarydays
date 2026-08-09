import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { tableName } from '@od/shared/table';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLocalTable } from '../../scripts/create-local-table.js';

/**
 * `POST /v1/activities` against a real DynamoDB Local (P1-11).
 *
 * The unit suite proves the right transaction is composed. What it cannot prove is that the
 * transaction lands: that the index entry really goes in the bucket the agenda will query,
 * that a retry with the same key really returns the first response instead of creating a
 * second activity, and that a rejected body really leaves the table untouched.
 */
const ENDPOINT = process.env.DDB_ENDPOINT ?? 'http://localhost:8000';
const NAME = process.env.TABLE_NAME ?? tableName('local');

process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = NAME;
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';
process.env.DDB_ENDPOINT = ENDPOINT;
process.env.AWS_ACCESS_KEY_ID ??= 'local';
process.env.AWS_SECRET_ACCESS_KEY ??= 'localsecret';

type CreateApp = typeof import('../../src/app.js').createApp;
type Base = typeof import('../../src/repositories/base.js');
type Keys = typeof import('../../src/repositories/keys.js');
type Repo = typeof import('../../src/repositories/activityRepository.js');

let createApp: CreateApp;
let base: Base;
let keys: Keys;
let repo: Repo;

/** The id `LocalIdentityProvider` resolves, which is what the real app will read as. */
const DEV = 'usr_local_dev';
const OTHER = 'usr_int_activities_other';

const admin = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: ENDPOINT,
  credentials: { accessKeyId: 'local', secretAccessKey: 'localsecret' },
});

beforeAll(async () => {
  await createLocalTable(admin, NAME);
  createApp = (await import('../../src/app.js')).createApp;
  base = await import('../../src/repositories/base.js');
  keys = await import('../../src/repositories/keys.js');
  repo = await import('../../src/repositories/activityRepository.js');
});

afterAll(() => {
  admin.destroy();
});

/**
 * Both users' partitions start empty, so an index count is a fact rather than a guess.
 *
 * The `ACT#` partitions each request creates are left behind — they cannot be enumerated
 * without a `Scan` — but every activity id here is a fresh ULID minted by the service, so no
 * run can ever inherit another's rows. That is the property the sibling repository suite has
 * to construct by hand, and it comes free here.
 */
beforeEach(async () => {
  for (const userId of [DEV, OTHER]) {
    const rows = await base.queryAll<{ pk: string; sk: string }>({
      pk: keys.userProfile(userId).pk,
    });
    await base.deleteAll(rows.map((row) => ({ pk: row.pk, sk: row.sk })));
  }
});

const asUser = (userId?: string) =>
  userId === undefined
    ? createApp()
    : createApp({ identityProvider: { resolve: () => Promise.resolve(userId) } });

const post = (body: unknown, options: { key?: string; userId?: string } = {}) =>
  asUser(options.userId).fetch(
    new Request('http://localhost/v1/activities', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': options.key ?? crypto.randomUUID(),
      },
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
  });

  it('stores a row the next read finds', async () => {
    const { data } = await (await post(TASK)).json();

    const stored = await repo.getActivityMeta(data.activityId);

    expect(stored).toMatchObject({ activityId: data.activityId, title: 'Buy milk' });
  });

  it('writes exactly one index entry for the owner', async () => {
    await post(TASK);

    expect(await indexRows(DEV)).toHaveLength(1);
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
  it('returns the first response with 200, and creates nothing new', async () => {
    const key = crypto.randomUUID();

    const first = await post(TASK, { key });
    const firstBody = await first.json();

    const retry = await post(TASK, { key });
    const retryBody = await retry.json();

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retryBody.data.activityId).toBe(firstBody.data.activityId);
    expect(await indexRows(DEV)).toHaveLength(1);
  });

  it('is not confused by a different key, which is a different request', async () => {
    await post(TASK, { key: crypto.randomUUID() });
    await post(TASK, { key: crypto.randomUUID() });

    expect(await indexRows(DEV)).toHaveLength(2);
  });
});

describe('reminders at creation', () => {
  it('writes them into the activity’s own partition, for the creator alone', async () => {
    const { data } = await (
      await post({ ...TASK, reminders: [{ offsetMinutes: -15 }, { offsetMinutes: -60 }] })
    ).json();

    const partition = await repo.getActivityPartition(data.activityId);
    const reminders = partition.filter((row) => row.entity === 'Reminder');

    expect(reminders).toHaveLength(2);
    expect(reminders.every((row) => row.userId === DEV)).toBe(true);
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
    asUser(userId).fetch(new Request(`http://localhost/v1/activities/${id}`));

  it('returns what was written, in named collections', async () => {
    const { data } = await (await post(TASK)).json();

    const res = await read(data.activityId);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body.data).sort()).toEqual(['activity', 'reminders']);
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
      await post({ ...TASK, reminders: [{ offsetMinutes: -15 }] })
    ).json();

    const body = await (await read(data.activityId)).json();

    expect(activityDetail.safeParse(body.data).success).toBe(true);
  });

  it('returns the caller’s reminders on it', async () => {
    const { data } = await (
      await post({ ...TASK, reminders: [{ offsetMinutes: -15 }, { offsetMinutes: -60 }] })
    ).json();

    const body = await (await read(data.activityId)).json();

    expect(body.data.reminders).toHaveLength(2);
    expect(body.data.reminders.every((r: { userId: string }) => r.userId === DEV)).toBe(
      true,
    );
  });

  it('leaks no storage attribute from the real stored rows', async () => {
    const { data } = await (
      await post({ ...TASK, reminders: [{ offsetMinutes: -15 }] })
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
      await post({ ...TASK, reminders: [{ offsetMinutes: -15 }] })
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
 * the condition on `updatedAt` actually cancels a stale write, that a bucket-changing patch
 * leaves **one** index entry rather than two, and that a kind change leaves the reminder rows
 * in the partition alone.
 */
describe('patching an activity', () => {
  const patch = (
    id: string,
    body: unknown,
    options: { ifMatch?: string; userId?: string } = {},
  ) =>
    asUser(options.userId).fetch(
      new Request(`http://localhost/v1/activities/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(options.ifMatch === undefined ? {} : { 'If-Match': options.ifMatch }),
        },
        body: JSON.stringify(body),
      }),
    );

  const created = async (body: unknown = TASK) => (await (await post(body)).json()).data;

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

  /** One index entry after the move, not two — the whole-item re-put from P1-09. */
  it('moves a task to #N when the date is cleared, and leaves one index entry', async () => {
    const activity = await created({
      ...TASK,
      schedule: { date: '2026-08-15', timezone: 'America/New_York' },
    });
    expect(activity.status).toBe('scheduled');

    const body = await (
      await patch(
        activity.activityId,
        { schedule: null },
        { ifMatch: activity.updatedAt },
      )
    ).json();

    expect(body.data.status).toBe('saved');

    const rows = await indexRows(DEV);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.gsi1pk).toBe(`U#${DEV}#N`);
  });

  it('moves an undated task to #S when a date is added', async () => {
    const activity = await created();

    await patch(
      activity.activityId,
      { schedule: { date: '2026-08-15', timezone: 'UTC' } },
      { ifMatch: activity.updatedAt },
    );

    const rows = await indexRows(DEV);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.gsi1pk).toBe(`U#${DEV}#S`);
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
          schedule: { date: '2026-08-15', timezone: 'UTC' },
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
    asUser().fetch(
      new Request(`http://localhost/v1/activities/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'If-Match': ifMatch },
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
    asUser(userId).fetch(
      new Request(`http://localhost/v1/activities/${id}`, { method: 'DELETE' }),
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
          reminders: [{ offsetMinutes: -15 }, { offsetMinutes: -60 }],
        })
      ).json()
    ).data;
    expect(await repo.getActivityPartition(subject.activityId)).toHaveLength(3);

    const res = await remove(subject.activityId);

    expect(res.status).toBe(200);
    expect(await repo.getActivityPartition(subject.activityId)).toHaveLength(0);
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

/** Two users' activities are invisible to each other, before Phase 4 makes it matter. */
describe('tenant isolation', () => {
  it('gives each user their own index partition', async () => {
    await post(TASK);
    await post({ ...TASK, title: 'Their milk' }, { userId: OTHER });

    expect(await indexRows(DEV)).toHaveLength(1);
    expect(await indexRows(OTHER)).toHaveLength(1);
  });
});
