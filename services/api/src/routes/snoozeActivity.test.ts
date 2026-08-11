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

const USER = 'usr_local_dev';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const KEY = '00000000-0000-4000-8000-000000000001';

const meta = (overrides: Record<string, unknown> = {}) => ({
  pk: `ACT#${ACT}`,
  sk: 'META',
  entity: 'Activity',
  activityId: ACT,
  ownerId: USER,
  status: 'scheduled',
  objectKind: 'task',
  type: 'task',
  title: 'Buy milk',
  schedule: { date: '2099-01-01', time: '18:00', timezone: 'UTC' },
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

interface SeedOptions {
  readonly activity?: Record<string, unknown>;
  readonly occurrence?: Record<string, unknown>;
  readonly marker?: Record<string, unknown>;
}

function seed(options: SeedOptions = {}) {
  let activity = options.activity ?? meta();
  const rows = new Map<string, Record<string, unknown>>();
  const receipts = new Map<string, Record<string, unknown>>();
  if (options.occurrence !== undefined) {
    rows.set(String(options.occurrence.sk), options.occurrence);
  }
  if (options.marker !== undefined) rows.set(String(options.marker.sk), options.marker);

  ddbMock.on(GetCommand).callsFake((input) => {
    const pk = String(input.Key?.pk ?? '');
    const sk = String(input.Key?.sk ?? '');
    if (pk.startsWith('IDEM#')) {
      const receipt = receipts.get(`${pk}\u0000${sk}`);
      return receipt === undefined ? {} : { Item: receipt };
    }
    if (sk === 'META') return { Item: activity };
    const row = rows.get(sk);
    return row === undefined ? {} : { Item: row };
  });
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(TransactWriteCommand).callsFake((input) => {
    for (const item of input.TransactItems ?? []) {
      const stored = item.Put?.Item as Record<string, unknown> | undefined;
      if (stored?.entity === 'Activity') activity = stored;
      if (stored?.entity === 'Occurrence' || stored?.entity === 'OccurrenceMoveMarker') {
        rows.set(String(stored.sk), stored);
      }
      if (stored?.entity === 'Idempotency') {
        receipts.set(`${String(stored.pk)}\u0000${String(stored.sk)}`, stored);
      }
      const deleted = item.Delete?.Key;
      if (deleted?.sk !== undefined) rows.delete(String(deleted.sk));
    }
    return {};
  });

  return {
    activity: () => activity,
    row: (sk: string) => rows.get(sk),
  };
}

beforeEach(async () => {
  ddbMock.reset();
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

function post(
  action: 'snooze' | 'unsnooze',
  body: unknown,
  key = KEY,
): Promise<Response> {
  const app = createApp();
  return Promise.resolve(
    app.fetch(
      new Request(`http://localhost/v1/activities/${ACT}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(body),
      }),
    ),
  );
}

describe('one-off snooze storage and replay', () => {
  it('updates only META, keeps schedule-derived status, and unsnoozes cleanly', async () => {
    const state = seed();

    const snoozed = await (await post('snooze', { until: '20:00' })).json();

    expect(snoozed.data.activity).toMatchObject({
      status: 'scheduled',
      snoozedUntil: '20:00',
    });
    expect(state.row('OCC#2099-01-01')).toBeUndefined();

    const restored = await (
      await post('unsnooze', {}, '00000000-0000-4000-8000-000000000002')
    ).json();
    expect(restored.data.activity).not.toHaveProperty('snoozedUntil');
    expect(state.activity()).not.toHaveProperty('snoozedUntil');
  });

  it('replays the exact response with one committed write', async () => {
    seed();
    const app = createApp();
    const request = () =>
      app.fetch(
        new Request(`http://localhost/v1/activities/${ACT}/snooze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': KEY },
          body: JSON.stringify({ until: '20:00' }),
        }),
      );
    const first = await request();
    const firstBody = await first.text();
    const replay = await request();

    expect(await replay.text()).toBe(firstBody);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });
});

describe('recurring occurrence snooze isolation', () => {
  const recurring = () =>
    meta({
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2099-01-01' }],
      },
    });

  it('writes OCC only, leaves META byte-identical, and a second snooze overwrites it', async () => {
    const state = seed({ activity: recurring() });
    const before = JSON.stringify(state.activity());

    await post('snooze', { occurrenceDate: '2099-01-01', until: '20:00' });
    await post(
      'snooze',
      { occurrenceDate: '2099-01-01', until: '21:00' },
      '00000000-0000-4000-8000-000000000002',
    );

    expect(state.row('OCC#2099-01-01')).toMatchObject({
      status: 'snoozed',
      snoozedUntil: '21:00',
    });
    expect(JSON.stringify(state.activity())).toBe(before);
  });

  it('unsnoozes only a snoozed override and never erases completion', async () => {
    const completed = {
      pk: `ACT#${ACT}`,
      sk: 'OCC#2099-01-01',
      entity: 'Occurrence',
      activityId: ACT,
      date: '2099-01-01',
      status: 'completed',
      completedAt: '2099-01-01T18:00:00.000Z',
    };
    const state = seed({ activity: recurring(), occurrence: completed });

    const body = await (await post('unsnooze', { occurrenceDate: '2099-01-01' })).json();

    expect(body.data.occurrence.status).toBe('completed');
    expect(state.row('OCC#2099-01-01')).toEqual(completed);
  });

  it('updates a cross-day marker atomically and preserves another source on undo', async () => {
    const source = {
      pk: `ACT#${ACT}`,
      sk: 'OCC#2099-01-01',
      entity: 'Occurrence',
      activityId: ACT,
      date: '2099-01-01',
      status: 'snoozed',
      snoozedUntil: '2099-01-02T20:00:00.000Z',
    };
    const marker = {
      pk: `ACT#${ACT}`,
      sk: 'MOVE#2099-01-02',
      entity: 'OccurrenceMoveMarker',
      activityId: ACT,
      destinationDate: '2099-01-02',
      movedFrom: ['2098-12-31', '2099-01-01'],
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
      schemaVersion: 1,
    };
    const state = seed({ activity: recurring(), occurrence: source, marker });

    await post('unsnooze', { occurrenceDate: '2099-01-01' });

    expect(state.row('OCC#2099-01-01')).toBeUndefined();
    expect(state.row('MOVE#2099-01-02')?.movedFrom).toEqual(['2098-12-31']);
    const items =
      ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems;
    expect(items).toHaveLength(3);
  });

  it('moves a repeated snooze reference from the old destination to the new one', async () => {
    const source = {
      pk: `ACT#${ACT}`,
      sk: 'OCC#2099-01-01',
      entity: 'Occurrence',
      activityId: ACT,
      date: '2099-01-01',
      status: 'snoozed',
      snoozedUntil: '2099-01-02T20:00:00.000Z',
    };
    const marker = {
      pk: `ACT#${ACT}`,
      sk: 'MOVE#2099-01-02',
      entity: 'OccurrenceMoveMarker',
      activityId: ACT,
      destinationDate: '2099-01-02',
      movedFrom: ['2099-01-01'],
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
      schemaVersion: 1,
    };
    const state = seed({ activity: recurring(), occurrence: source, marker });

    await post('snooze', {
      occurrenceDate: '2099-01-01',
      until: '2099-01-03T20:00:00.000Z',
    });

    expect(state.row('MOVE#2099-01-02')).toBeUndefined();
    expect(state.row('MOVE#2099-01-03')?.movedFrom).toEqual(['2099-01-01']);
    expect(state.row('OCC#2099-01-01')?.snoozedUntil).toBe('2099-01-03T20:00:00.000Z');
  });

  it('accepts exactly 60 days, rejects 61, and rejects a past instant', async () => {
    seed({ activity: recurring() });
    expect(
      (
        await post('snooze', {
          occurrenceDate: '2099-01-01',
          until: '2099-03-02T20:00:00.000Z',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          'snooze',
          {
            occurrenceDate: '2099-01-01',
            until: '2099-03-03T20:00:00.000Z',
          },
          '00000000-0000-4000-8000-000000000002',
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          'snooze',
          { occurrenceDate: '2000-01-01', until: '2000-01-01T20:00:00.000Z' },
          '00000000-0000-4000-8000-000000000003',
        )
      ).status,
    ).toBe(400);
  });

  it('does not query the recurring GSI on a mutation', async () => {
    seed({ activity: recurring() });
    await post('snooze', { occurrenceDate: '2099-01-01', until: '20:00' });

    for (const call of ddbMock.commandCalls(QueryCommand)) {
      expect(JSON.stringify(call.args[0].input)).not.toContain('#R');
    }
  });
});
