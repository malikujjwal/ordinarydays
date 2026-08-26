import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';

import type { createApp as CreateApp } from '../app.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
let createApp: typeof CreateApp;

const DEV = 'usr_local_dev';
const OWNER = 'usr_owner';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const PARENT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const KEY = '00000000-0000-4000-8000-000000000001';

const meta = (overrides: Record<string, unknown> = {}) => ({
  pk: `ACT#${ACT}`,
  sk: 'META',
  entity: 'Activity',
  activityId: ACT,
  ownerId: DEV,
  status: 'scheduled',
  objectKind: 'task',
  type: 'task',
  title: 'Buy milk',
  schedule: { date: '2026-08-11', timezone: 'UTC' },
  details: { kind: 'task' },
  participantCount: 0,
  childCount: 0,
  expenseTotalCents: 0,
  visibility: 'private',
  icsSequence: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  lastActivityAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
  schemaVersion: 1,
  ...overrides,
});

const parent = (overrides: Record<string, unknown> = {}) =>
  meta({
    pk: `ACT#${PARENT}`,
    activityId: PARENT,
    ownerId: OWNER,
    objectKind: 'plan',
    type: 'custom',
    title: 'Breakfast',
    details: { kind: 'custom' },
    ...overrides,
  });

interface SeedOptions {
  readonly activity?: Record<string, unknown>;
  readonly parent?: Record<string, unknown>;
  readonly occurrence?: Record<string, unknown>;
  readonly childParticipants?: readonly Record<string, unknown>[];
  readonly parentParticipants?: readonly Record<string, unknown>[];
}

function seed(options: SeedOptions = {}) {
  let activity = options.activity ?? meta();
  const receipts = new Map<string, Record<string, unknown>>();

  ddbMock.on(GetCommand).callsFake((input) => {
    const sk = String(input.Key?.sk ?? '');
    const pk = String(input.Key?.pk ?? '');
    if (pk.startsWith('IDEM#')) {
      const receipt = receipts.get(pk);
      return receipt === undefined ? {} : { Item: receipt };
    }
    if (sk.startsWith('OCC#')) {
      return options.occurrence === undefined ? {} : { Item: options.occurrence };
    }
    if (sk === 'META' && pk === `ACT#${PARENT}`) {
      return options.parent === undefined ? {} : { Item: options.parent };
    }
    if (sk === 'META' && pk === `ACT#${ACT}`) return { Item: activity };
    return {};
  });
  ddbMock.on(QueryCommand).callsFake((input) => {
    const pk = String(input.ExpressionAttributeValues?.[':pk'] ?? '');
    return {
      Items:
        pk === `ACT#${PARENT}`
          ? [...(options.parentParticipants ?? [])]
          : [...(options.childParticipants ?? [])],
    };
  });
  ddbMock.on(TransactWriteCommand).callsFake((input) => {
    for (const item of input.TransactItems ?? []) {
      const stored = item.Put?.Item as Record<string, unknown> | undefined;
      if (stored?.entity === 'Activity') activity = stored;
      if (stored?.entity === 'Idempotency') receipts.set(String(stored.pk), stored);
    }
    return {};
  });

  return { currentActivity: () => activity };
}

beforeEach(async () => {
  ddbMock.reset();
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

const asUser = (userId: string) =>
  createApp({ identityProvider: { resolve: () => Promise.resolve(userId) } });

function post(
  app: ReturnType<typeof CreateApp>,
  action: 'complete' | 'uncomplete' | 'skip',
  body: unknown,
  key = KEY,
) {
  return app.fetch(
    new Request(`http://localhost/v1/activities/${ACT}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body),
    }),
  );
}

function transactionItems() {
  return (
    ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0]?.input.TransactItems ?? []
  );
}

describe('one-off completion transaction and replay', () => {
  it.each([
    ['task', 'task', { kind: 'task' }, 'done'],
    ['meal', 'plan', { kind: 'meal' }, 'had_it'],
    ['watch', 'plan', { kind: 'watch', mediaTitle: 'Severance' }, 'watched'],
    ['event', 'plan', { kind: 'event' }, 'attended'],
    ['custom', 'plan', { kind: 'custom' }, 'done'],
  ] as const)(
    'defaults %s completion outcome',
    async (type, objectKind, details, outcome) => {
      seed({ activity: meta({ type, objectKind, details }) });

      const body = await (await post(createApp(), 'complete', {})).json();

      expect(body.data.outcome).toBe(outcome);
      expect(body.data.activity.status).toBe('completed');
    },
  );

  it.each([
    ['task', 'task', { kind: 'task' }, 'didnt_happen'],
    ['event', 'plan', { kind: 'event' }, 'didnt_go'],
  ] as const)(
    'maps the negative %s outcome to skipped',
    async (type, objectKind, details, outcome) => {
      seed({ activity: meta({ type, objectKind, details }) });

      const body = await (await post(createApp(), 'complete', { outcome })).json();

      expect(body.data.activity).toMatchObject({ status: 'skipped', outcome });
      expect(body.data.activity).not.toHaveProperty('completedAt');
    },
  );

  it('rejects an outcome that does not belong to the activity type', async () => {
    seed();

    const response = await post(createApp(), 'complete', { outcome: 'attended' });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatchObject({
      code: 'validation_failed',
      details: [{ path: 'outcome' }],
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('updates META and every direct index with the receipt in one transaction', async () => {
    seed({ childParticipants: [{ userId: 'usr_participant' }] });

    const response = await post(createApp(), 'complete', {});
    const body = await response.json();
    const items = transactionItems();

    expect(response.status).toBe(200);
    expect(body.data.activity).toMatchObject({
      status: 'completed',
      outcome: 'done',
    });
    /**
     * **No feed row**, because this fixture is a Task. The feed is the plan's; Task detail has
     * no section that could show one, so writing history here would be storage nothing can
     * reach (P3-19 review).
     */
    expect(items.map((item) => item.Put?.Item?.entity ?? Object.keys(item)[0])).toEqual([
      'Activity',
      'ActivityIndex',
      'ActivityIndex',
      'Idempotency',
    ]);
    expect(
      items
        .filter((item) => item.Put?.Item?.entity === 'ActivityIndex')
        .map((item) => item.Put?.Item?.status),
    ).toEqual(['completed', 'completed']);
  });

  /**
   * The plan case: the feed's entry joins the **same** transaction. A completion that
   * committed while its feed row failed would leave the two disagreeing, and agreeing with
   * the plan is the feed's only job.
   */
  it('writes the feed entry in the completion transaction, for a plan', async () => {
    seed({
      activity: meta({
        objectKind: 'plan',
        type: 'event',
        details: { kind: 'event' },
      }),
    });

    expect((await post(createApp(), 'complete', {})).status).toBe(200);

    const entries = transactionItems().filter(
      (item) => item.Put?.Item?.entity === 'ActivityUpdate',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.Put?.Item).toMatchObject({ kind: 'system' });
    expect(entries[0]?.Put?.Item).not.toHaveProperty('authorUserId');
  });

  it('replays the original bytes and performs only one domain transaction', async () => {
    seed();
    const app = createApp();

    const first = await post(app, 'complete', {});
    const firstBody = await first.text();
    const replay = await post(app, 'complete', {});

    expect(await replay.text()).toBe(firstBody);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('uncomplete restores scheduled and clears completion fields atomically', async () => {
    seed({
      activity: meta({
        status: 'skipped',
        outcome: 'didnt_happen',
        completedAt: '2026-08-10T12:00:00.000Z',
      }),
    });

    const body = await (await post(createApp(), 'uncomplete', {})).json();
    const stored = transactionItems().find(
      (item) => item.Put?.Item?.entity === 'Activity',
    )?.Put?.Item;

    expect(body.data.activity.status).toBe('scheduled');
    expect(stored).not.toHaveProperty('completedAt');
    expect(stored).not.toHaveProperty('outcome');
  });

  it('leaves cancelled activities unchanged and commits only the receipt', async () => {
    const cancelled = meta({ status: 'cancelled' });
    const state = seed({ activity: cancelled });

    const body = await (await post(createApp(), 'complete', {})).json();

    expect(body.data.activity.status).toBe('cancelled');
    expect(state.currentActivity()).toEqual(cancelled);
    expect(transactionItems()).toHaveLength(1);
    expect(transactionItems()[0]?.Put?.Item?.entity).toBe('Idempotency');
  });

  it('treats an already completed activity as a successful no-op', async () => {
    const completed = meta({
      status: 'completed',
      outcome: 'done',
      completedAt: '2026-08-10T12:00:00.000Z',
    });
    const state = seed({ activity: completed });

    const response = await post(createApp(), 'complete', {});

    expect(response.status).toBe(200);
    expect(state.currentActivity()).toEqual(completed);
    expect(transactionItems()).toHaveLength(1);
    expect(transactionItems()[0]?.Put?.Item?.entity).toBe('Idempotency');
  });

  it('uncomplete restores saved when the activity has no schedule', async () => {
    const withoutSchedule: Record<string, unknown> = meta({
      status: 'completed',
      outcome: 'done',
    });
    delete withoutSchedule.schedule;
    seed({ activity: withoutSchedule });

    const body = await (await post(createApp(), 'uncomplete', {})).json();

    expect(body.data.activity.status).toBe('saved');
  });
});

describe('recurring occurrence isolation', () => {
  it('writes exactly OCC plus receipt and leaves META byte-identical', async () => {
    const series = meta({
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
      },
    });
    const state = seed({ activity: series });
    const before = JSON.stringify(state.currentActivity());

    const body = await (
      await post(createApp(), 'complete', { occurrenceDate: '2026-08-11' })
    ).json();
    const items = transactionItems();

    expect(body.data.occurrence).toMatchObject({
      activityId: ACT,
      date: '2026-08-11',
      status: 'completed',
    });
    expect(items).toHaveLength(2);
    expect(items[0]?.Put?.Item).toMatchObject({
      pk: `ACT#${ACT}`,
      sk: 'OCC#2026-08-11',
      entity: 'Occurrence',
    });
    expect(items[1]?.Put?.Item?.entity).toBe('Idempotency');
    expect(JSON.stringify(state.currentActivity())).toBe(before);
  });

  it('uncomplete deletes only the nominal occurrence and attaches the receipt', async () => {
    seed({
      activity: meta({
        recurrence: {
          mode: 'fixed',
          segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
        },
      }),
      occurrence: {
        activityId: ACT,
        date: '2026-08-11',
        status: 'completed',
        completedAt: '2026-08-11T12:00:00.000Z',
      },
    });

    const body = await (
      await post(createApp(), 'uncomplete', { occurrenceDate: '2026-08-11' })
    ).json();

    expect(body.data).not.toHaveProperty('occurrence');
    expect(transactionItems()).toHaveLength(2);
    expect(transactionItems()[0]?.Delete?.Key).toEqual({
      pk: `ACT#${ACT}`,
      sk: 'OCC#2026-08-11',
    });
    expect(transactionItems()[1]?.Put?.Item?.entity).toBe('Idempotency');
  });

  it('does not erase a snooze or reschedule override', async () => {
    seed({
      activity: meta({
        recurrence: {
          mode: 'fixed',
          segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
        },
      }),
      occurrence: {
        activityId: ACT,
        date: '2026-08-11',
        status: 'snoozed',
        snoozedUntil: '18:00',
      },
    });

    const body = await (
      await post(createApp(), 'uncomplete', { occurrenceDate: '2026-08-11' })
    ).json();

    expect(body.data.occurrence).toMatchObject({ status: 'snoozed' });
    expect(transactionItems()).toHaveLength(1);
    expect(transactionItems()[0]?.Put?.Item?.entity).toBe('Idempotency');
  });

  it('keeps an already skipped occurrence internally consistent', async () => {
    seed({
      activity: meta({
        recurrence: {
          mode: 'fixed',
          segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
        },
      }),
      occurrence: {
        activityId: ACT,
        date: '2026-08-11',
        status: 'skipped',
      },
    });

    const body = await (
      await post(createApp(), 'complete', {
        occurrenceDate: '2026-08-11',
        outcome: 'done',
      })
    ).json();

    expect(body.data).toMatchObject({
      occurrence: { status: 'skipped' },
      outcome: 'didnt_happen',
    });
    expect(transactionItems()).toHaveLength(1);
  });
});

describe('P2-14 skip', () => {
  it('atomically skips META and every direct index without completion fields', async () => {
    seed({
      activity: meta({
        status: 'completed',
        outcome: 'done',
        completedAt: '2026-08-10T12:00:00.000Z',
      }),
      childParticipants: [{ userId: 'usr_participant' }],
    });

    const response = await post(createApp(), 'skip', {});
    const body = await response.json();
    const items = transactionItems();

    expect(response.status).toBe(200);
    expect(body.data.activity.status).toBe('skipped');
    expect(body.data.activity).not.toHaveProperty('completedAt');
    expect(body.data.activity).not.toHaveProperty('outcome');
    expect(
      items
        .filter((item) => item.Put?.Item?.entity === 'ActivityIndex')
        .map((item) => item.Put?.Item?.status),
    ).toEqual(['skipped', 'skipped']);
  });

  it('skips then uncomplete restores scheduled with a new logical key', async () => {
    seed();
    const app = createApp();

    await post(app, 'skip', {}, KEY);
    const body = await (
      await post(app, 'uncomplete', {}, '00000000-0000-4000-8000-000000000002')
    ).json();

    expect(body.data.activity.status).toBe('scheduled');
  });

  it('overwrites a completed occurrence with one skipped row and no completedAt', async () => {
    seed({
      activity: meta({
        recurrence: {
          mode: 'fixed',
          segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
        },
      }),
      occurrence: {
        activityId: ACT,
        date: '2026-08-11',
        status: 'completed',
        completedAt: '2026-08-11T12:00:00.000Z',
      },
    });

    const body = await (
      await post(createApp(), 'skip', { occurrenceDate: '2026-08-11' })
    ).json();
    const stored = transactionItems()[0]?.Put?.Item;

    expect(body.data.occurrence).toEqual({
      activityId: ACT,
      date: '2026-08-11',
      status: 'skipped',
    });
    expect(stored).toMatchObject({
      pk: `ACT#${ACT}`,
      sk: 'OCC#2026-08-11',
      status: 'skipped',
    });
    expect(stored).not.toHaveProperty('completedAt');
  });

  it('treats an already-skipped target as a successful receipt-only no-op', async () => {
    const skipped = meta({ status: 'skipped' });
    const state = seed({ activity: skipped });

    const response = await post(createApp(), 'skip', {});

    expect(response.status).toBe(200);
    expect(state.currentActivity()).toEqual(skipped);
    expect(transactionItems()).toHaveLength(1);
    expect(transactionItems()[0]?.Put?.Item?.entity).toBe('Idempotency');
  });

  it('replays the original response and performs one domain transaction', async () => {
    seed();
    const app = createApp();

    const first = await post(app, 'skip', {});
    const firstBody = await first.text();
    const replay = await post(app, 'skip', {});

    expect(await replay.text()).toBe(firstBody);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('rejects unknown body fields and an occurrence date on a non-series', async () => {
    seed();

    const unknown = await post(createApp(), 'skip', { outcome: 'done' });
    const nonSeries = await post(
      createApp(),
      'skip',
      { occurrenceDate: '2026-08-11' },
      '00000000-0000-4000-8000-000000000002',
    );

    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error.details[0]).toMatchObject({
      path: '',
      message: expect.stringContaining('outcome'),
    });
    expect(nonSeries.status).toBe(400);
    expect((await nonSeries.json()).error.details[0].path).toBe('occurrenceDate');
  });

  it('requires authentication and an Idempotency-Key', async () => {
    seed();
    const { AppError } = await import('../lib/errors.js');
    const unauthenticated = createApp({
      identityProvider: {
        resolve: () =>
          Promise.reject(new AppError('unauthenticated', 'Sign in required.')),
      },
    });

    const noIdentity = await post(unauthenticated, 'skip', {});
    const noKey = await post(createApp(), 'skip', {}, '');

    expect(noIdentity.status).toBe(401);
    expect(noKey.status).toBe(400);
    expect((await noKey.json()).error.details[0].path).toBe('Idempotency-Key');
  });

  it('returns conflict and leaves all projected state unchanged when META moved', async () => {
    const { TransactionCanceledException } = await import('@aws-sdk/client-dynamodb');
    const original = meta();
    const state = seed({
      activity: original,
      childParticipants: [{ userId: 'usr_participant' }],
    });
    const cancellation = new TransactionCanceledException({
      $metadata: {},
      message: 'cancelled',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    ddbMock.on(TransactWriteCommand).callsFake(() => Promise.reject(cancellation));

    const response = await post(createApp(), 'skip', {});

    expect(response.status).toBe(409);
    expect(state.currentActivity()).toEqual(original);
  });
});

describe('ADR-051 completion authority', () => {
  it('returns 403 to a direct plan participant and 404 to a stranger', async () => {
    seed({
      activity: meta({
        ownerId: OWNER,
        objectKind: 'plan',
        type: 'custom',
        details: { kind: 'custom' },
      }),
      childParticipants: [{ userId: DEV }],
    });
    expect((await post(asUser(DEV), 'complete', {})).status).toBe(403);

    ddbMock.reset();
    seed({
      activity: meta({
        ownerId: OWNER,
        objectKind: 'plan',
        type: 'custom',
        details: { kind: 'custom' },
      }),
    });
    expect((await post(asUser(DEV), 'complete', {})).status).toBe(404);
  });

  it.each([
    ['parent owner', parent({ ownerId: DEV }), []],
    ['parent participant', parent(), [{ userId: DEV }]],
  ] as const)(
    'allows the %s to complete a prep task',
    async (_role, parentRow, participants) => {
      seed({
        activity: meta({ ownerId: OWNER, parentActivityId: PARENT }),
        parent: parentRow,
        parentParticipants: participants,
      });

      expect((await post(asUser(DEV), 'complete', {})).status).toBe(200);
    },
  );

  it('returns 403 to a direct child participant who is not on the parent', async () => {
    seed({
      activity: meta({ ownerId: OWNER, parentActivityId: PARENT }),
      parent: parent(),
      childParticipants: [{ userId: DEV }],
    });

    expect((await post(asUser(DEV), 'complete', {})).status).toBe(403);
  });

  it('applies the same owner-only plan policy to skip without writing', async () => {
    seed({
      activity: meta({
        ownerId: OWNER,
        objectKind: 'plan',
        type: 'custom',
        details: { kind: 'custom' },
      }),
      childParticipants: [{ userId: DEV }],
    });

    expect((await post(asUser(DEV), 'skip', {})).status).toBe(403);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);

    ddbMock.reset();
    seed({
      activity: meta({
        ownerId: OWNER,
        objectKind: 'plan',
        type: 'custom',
        details: { kind: 'custom' },
      }),
    });

    expect((await post(asUser(DEV), 'skip', {})).status).toBe(404);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('lets a parent participant skip a prep task and updates its parent pointer', async () => {
    seed({
      activity: meta({ ownerId: OWNER, parentActivityId: PARENT }),
      parent: parent(),
      parentParticipants: [{ userId: DEV }],
    });

    const response = await post(asUser(DEV), 'skip', {});
    const items = transactionItems();

    expect(response.status).toBe(200);
    expect(
      items.find((item) => item.Update)?.Update?.ExpressionAttributeValues,
    ).toMatchObject({ ':status': 'skipped' });
  });
});

/**
 * A series may not be completed or skipped as a whole.
 *
 * Without an `occurrenceDate` both paths fell through to `patchActivity` and set
 * `status: 'completed'` on `ACT#/META`. `agendaService`'s `mergeNominal` renders an occurrence
 * with no override using `entry.activity.status`, so that one write crossed off **every**
 * future occurrence — "select complete on today's occurrence and it marks the future ones
 * complete". `snooze` had refused this since it was written; these two never grew the guard.
 */
describe('a recurring activity refuses an unscoped completion', () => {
  const series = () =>
    meta({
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
      },
    });

  it.each(['complete', 'skip'] as const)(
    'rejects %s without an occurrenceDate',
    async (op) => {
      const state = seed({ activity: series() });
      const before = JSON.stringify(state.currentActivity());

      const response = await post(createApp(), op, {});

      // `validation_failed` is 400 in `lib/errors.ts`, the same as every other bad input.
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.details?.[0]?.path).toBe('occurrenceDate');
      // The series row is untouched, which is the whole point.
      expect(JSON.stringify(state.currentActivity())).toBe(before);
    },
  );

  /**
   * Uncomplete stays unscoped on purpose: it is the only route back for a series this bug
   * already completed, and guarding it would strand exactly the users who hit the bug.
   */
  it('still allows an unscoped uncomplete, the recovery path', async () => {
    seed({ activity: { ...series(), status: 'completed' } });

    const response = await post(createApp(), 'uncomplete', {});

    expect(response.status).toBe(200);
  });
});
