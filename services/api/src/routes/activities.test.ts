import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';

import type { createApp as CreateApp } from '../app.js';

/** `POST /v1/activities` (P1-11). */
const ddbMock = mockClient(DynamoDBDocumentClient);

let createApp: typeof CreateApp;

const DEV = 'usr_local_dev';

beforeEach(async () => {
  ddbMock.reset();
  ddbMock.on(TransactWriteCommand).resolves({});
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

/**
 * The activity write, picked out of the transaction.
 *
 * The route is authenticated **and** creating, so `rateLimit` and `idempotency` both write
 * before the handler does — but through `UpdateCommand` and `PutCommand`, not
 * `TransactWriteCommand`, so this one is unambiguous.
 */
const transacted = () =>
  (ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0]?.input.TransactItems ??
    []) as Array<{ Put?: { Item?: Record<string, unknown> } }>;

const metaItem = () =>
  transacted().find((entry) => entry.Put?.Item?.entity === 'Activity')?.Put?.Item;

const post = (
  app: ReturnType<typeof CreateApp>,
  body: unknown,
  headers: Record<string, string> = { 'Idempotency-Key': crypto.randomUUID() },
) =>
  app.fetch(
    new Request('http://localhost/v1/activities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );

describe('creating a task', () => {
  it.each(['lastActivityAt', 'updatedAt'])(
    '400s client-supplied server-derived %s',
    async (field) => {
      const res = await post(createApp(), {
        objectKind: 'task',
        type: 'task',
        title: 'Buy milk',
        [field]: '2026-08-09T00:00:00.000Z',
      });

      expect(res.status).toBe(400);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    },
  );

  it('returns 201 with the created activity', async () => {
    const res = await post(createApp(), {
      objectKind: 'task',
      type: 'task',
      title: 'Buy milk',
    });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.activityId).toMatch(/^act_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(body.data.title).toBe('Buy milk');
    expect(body.meta.requestId).toMatch(/^req_/);
  });

  /**
   * The whole acceptance list for a minimal body, from P1-11: a `saved` activity with the
   * counters zeroed, `private`, owned by whoever identity resolved.
   */
  it('derives every server-owned field for a minimal body', async () => {
    const body = await (
      await post(createApp(), { objectKind: 'task', type: 'task', title: 'Buy milk' })
    ).json();

    expect(body.data).toMatchObject({
      status: 'saved',
      participantCount: 0,
      childCount: 0,
      expenseTotalCents: 0,
      visibility: 'private',
      ownerId: DEV,
      icsSequence: 0,
      schemaVersion: 1,
    });
  });

  it('echoes both halves of the target so the client can verify what was saved', async () => {
    const body = await (
      await post(createApp(), { objectKind: 'task', type: 'task', title: 'Buy milk' })
    ).json();

    expect(body.data.objectKind).toBe('task');
    expect(body.data.type).toBe('task');
  });

  it('is scheduled when the body carries a date', async () => {
    const body = await (
      await post(createApp(), {
        objectKind: 'task',
        type: 'task',
        title: 'Buy milk',
        schedule: { date: '2026-08-15', timezone: 'America/New_York' },
      })
    ).json();

    expect(body.data.status).toBe('scheduled');
  });

  it('never returns the storage attributes', async () => {
    const body = await (
      await post(createApp(), { objectKind: 'task', type: 'task', title: 'Buy milk' })
    ).json();

    expect(body.data).not.toHaveProperty('pk');
    expect(body.data).not.toHaveProperty('sk');
    expect(body.data).not.toHaveProperty('entity');
  });

  it('returns a body the shared activity schema accepts', async () => {
    const { activity } = await import('@od/shared/schemas');
    const body = await (
      await post(createApp(), { objectKind: 'task', type: 'task', title: 'Buy milk' })
    ).json();

    expect(activity.safeParse(body.data).success).toBe(true);
  });

  it('writes the canonical row and the owner’s index entry in one transaction', async () => {
    await post(createApp(), { objectKind: 'task', type: 'task', title: 'Buy milk' });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    expect(
      transacted()
        .map((entry) => entry.Put?.Item?.entity)
        .sort(),
    ).toEqual(['Activity', 'ActivityIndex', 'Idempotency']);
  });

  it('writes to the partition of whoever identity resolved', async () => {
    const app = createApp({
      identityProvider: { resolve: () => Promise.resolve('usr_someone_else') },
    });

    await post(app, { objectKind: 'task', type: 'task', title: 'Buy milk' });

    expect(metaItem()?.ownerId).toBe('usr_someone_else');
  });
});

/**
 * **The explicit-intent gate** (`definition-of-done.md` §3.1, `CLAUDE.md` rule 2).
 *
 * The same ambiguous title through two explicit targets lands as two different objects, and
 * a title with no target at all is refused rather than guessed at. There is no server default
 * and no classification branch anywhere in this path.
 */
describe('the target is the caller’s, never inferred', () => {
  it('400s a title-only body and writes nothing', async () => {
    const res = await post(createApp(), { title: 'Buy milk' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('400s half a target — type without objectKind — and writes nothing', async () => {
    const res = await post(createApp(), { title: 'Buy milk', type: 'task' });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('400s objectKind without type', async () => {
    const res = await post(createApp(), { title: 'Buy milk', objectKind: 'plan' });

    expect(res.status).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  /** There is no hidden `objectKind: 'plan', type: 'task'` combination. */
  it('400s an incompatible pair', async () => {
    const res = await post(createApp(), {
      title: 'Buy milk',
      objectKind: 'plan',
      type: 'task',
    });

    expect(res.status).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  /**
   * The pair of cases that proves there is no intent classifier: one title, two targets, two
   * different stored objects, and nothing about the words chose either.
   */
  it('stores one identical title as a Task or a Plan, following the caller', async () => {
    const asTask = await (
      await post(createApp(), {
        objectKind: 'task',
        type: 'task',
        title: 'Dinner with Sam',
      })
    ).json();

    ddbMock.reset();
    ddbMock.on(TransactWriteCommand).resolves({});

    const asPlan = await (
      await post(createApp(), {
        objectKind: 'plan',
        type: 'custom',
        title: 'Dinner with Sam',
      })
    ).json();

    expect(asTask.data).toMatchObject({ objectKind: 'task', type: 'task' });
    expect(asPlan.data).toMatchObject({ objectKind: 'plan', type: 'custom' });
  });

  it('400s a details.kind that disagrees with the type, pointing at the field', async () => {
    const res = await post(createApp(), {
      objectKind: 'plan',
      type: 'meal',
      title: 'Tacos',
      // A **well-formed** details object of the wrong kind, so the only thing wrong with the
      // body is the disagreement. See the case below for why that matters.
      details: { kind: 'custom' },
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.details?.[0]?.path).toBe('details.kind');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  /**
   * Two things wrong at once, and the structural one is reported.
   *
   * `{ kind: 'watch' }` is not only the wrong kind for a meal — it is also an incomplete
   * watch object, since that arm requires `mediaTitle`. Zod skips a `superRefine` when the
   * base parse has already failed, so the answer names the missing field rather than the
   * disagreement. That is the right order: the cross-field rule has nothing to compare until
   * the object it compares is valid. Written down because the obvious fixture for the case
   * above hits this instead, and the difference is not visible from the error alone.
   */
  it('reports the structural failure first when the details object is also incomplete', async () => {
    const res = await post(createApp(), {
      objectKind: 'plan',
      type: 'meal',
      title: 'Tacos',
      details: { kind: 'watch' },
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.details?.[0]?.path).toBe('details.mediaTitle');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe('what this endpoint refuses', () => {
  /** Not silently dropped: the user believes they shared it (P1-11). */
  it('400s a Plan carrying participants, with the coming-soon message', async () => {
    const res = await post(createApp(), {
      objectKind: 'plan',
      type: 'event',
      title: 'Dinner',
      participants: [{ displayName: 'Sam' }],
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.message).toBe('Sharing is coming soon.');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  /** The Task arm accepts no participants at all, so this never reaches the service. */
  it('400s a Task carrying participants', async () => {
    const res = await post(createApp(), {
      objectKind: 'task',
      type: 'task',
      title: 'Buy milk',
      participants: [{ displayName: 'Sam' }],
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
  });

  /**
   * Only `POST /v1/lists/:id/items/:itemId/schedule` may establish that relationship, after
   * list access has been checked (`api-contract.md` §2.3).
   */
  it.each(['listId', 'listItemId', 'fromListItem'])(
    '400s a body carrying %s',
    async (key) => {
      const res = await post(createApp(), {
        objectKind: 'task',
        type: 'task',
        title: 'Buy milk',
        [key]: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
      });

      expect(res.status).toBe(400);
      expect(JSON.stringify((await res.json()).error.details)).toContain(key);
    },
  );

  /** Truncating to three would save less than the user asked for, silently. */
  it('400s more than three reminders rather than truncating', async () => {
    const res = await post(createApp(), {
      objectKind: 'task',
      type: 'task',
      title: 'Buy milk',
      reminders: [
        { offsetMinutes: -5 },
        { offsetMinutes: -10 },
        { offsetMinutes: -15 },
        { offsetMinutes: -20 },
      ],
    });

    expect(res.status).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  /** Server-derived fields are never accepted from the client. */
  it.each(['status', 'ownerId', 'activityId', 'visibility', 'participantCount'])(
    '400s a client-supplied %s',
    async (field) => {
      const res = await post(createApp(), {
        objectKind: 'task',
        type: 'task',
        title: 'Buy milk',
        [field]: 'anything',
      });

      expect(res.status).toBe(400);
      expect(JSON.stringify((await res.json()).error.details)).toContain(field);
    },
  );

  it('400s an empty title', async () => {
    const res = await post(createApp(), { objectKind: 'task', type: 'task', title: '' });

    expect(res.status).toBe(400);
  });
});

describe('reminders at creation', () => {
  it('writes one row per reminder, carrying the creator’s own userId', async () => {
    await post(createApp(), {
      objectKind: 'task',
      type: 'task',
      title: 'Gym',
      schedule: { date: '2026-08-15', time: '19:30', timezone: 'UTC' },
      reminders: [{ offsetMinutes: -15 }, { offsetMinutes: -60 }],
    });

    const reminders = transacted().filter(
      (entry) => entry.Put?.Item?.entity === 'Reminder',
    );

    expect(reminders).toHaveLength(2);
    expect(reminders.every((entry) => entry.Put?.Item?.userId === DEV)).toBe(true);
  });

  it('writes them in the same transaction as the activity', async () => {
    await post(createApp(), {
      objectKind: 'task',
      type: 'task',
      title: 'Gym',
      schedule: { date: '2026-08-15', time: '19:30', timezone: 'UTC' },
      reminders: [{ offsetMinutes: -15 }],
    });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    expect(transacted()).toHaveLength(4);
  });
});

/**
 * The registry entry carries `mutates: true`, so `idempotency` requires the header. This is the
 * assertion that the flag is set: without it the middleware skips the route and the request
 * would succeed.
 */
describe('the Idempotency-Key', () => {
  it('is required', async () => {
    const res = await post(
      createApp(),
      { objectKind: 'task', type: 'task', title: 'x' },
      {},
    );

    expect(res.status).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('is rejected when it is not a UUID', async () => {
    const res = await post(
      createApp(),
      { objectKind: 'task', type: 'task', title: 'x' },
      { 'Idempotency-Key': 'not-a-uuid' },
    );

    expect(res.status).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
