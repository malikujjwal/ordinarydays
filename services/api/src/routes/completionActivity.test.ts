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
  let receipt: Record<string, unknown> | undefined;

  ddbMock.on(GetCommand).callsFake((input) => {
    const sk = String(input.Key?.sk ?? '');
    const pk = String(input.Key?.pk ?? '');
    if (pk.startsWith('IDEM#')) return receipt === undefined ? {} : { Item: receipt };
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
      if (stored?.entity === 'Idempotency') receipt = stored;
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
  action: 'complete' | 'uncomplete',
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
});
