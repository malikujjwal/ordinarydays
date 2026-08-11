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
const DEV = 'usr_local_dev';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
let createApp: typeof CreateApp;

const activity = (overrides: Record<string, unknown> = {}) => ({
  pk: `ACT#${ACT}`,
  sk: 'META',
  entity: 'Activity',
  activityId: ACT,
  ownerId: DEV,
  objectKind: 'task',
  type: 'task',
  status: 'saved',
  title: 'Call the dentist',
  participantCount: 0,
  childCount: 0,
  expenseTotalCents: 0,
  visibility: 'private',
  details: { kind: 'task' },
  icsSequence: 0,
  createdAt: '2026-08-08T10:00:00.000Z',
  lastActivityAt: '2026-08-08T10:00:00.000Z',
  updatedAt: '2026-08-08T10:00:00.000Z',
  schemaVersion: 1,
  ...overrides,
});

beforeEach(async () => {
  ddbMock.reset();
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

const post = (
  app: ReturnType<typeof CreateApp>,
  body: unknown,
  headers: Record<string, string> = { 'Idempotency-Key': crypto.randomUUID() },
) =>
  app.fetch(
    new Request(`http://localhost/v1/activities/${ACT}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );

const asUser = (userId: string) =>
  createApp({ identityProvider: { resolve: () => Promise.resolve(userId) } });

describe('POST /v1/activities/:id/schedule', () => {
  it('writes META, its sole index and receipt atomically', async () => {
    ddbMock.on(GetCommand).resolves({ Item: activity() as never });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    const res = await post(createApp(), {
      date: '2026-03-08',
      time: '02:30',
      timezone: 'America/New_York',
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.activity).toMatchObject({
      status: 'scheduled',
      icsSequence: 1,
      schedule: {
        date: '2026-03-08',
        time: '02:30',
        timezone: 'America/New_York',
        scheduledAtUtc: '2026-03-08T07:00:00.000Z',
      },
    });

    const items =
      ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
    expect(items.filter((entry) => entry.Put?.Item?.entity === 'Activity')).toHaveLength(
      1,
    );
    expect(
      items.filter((entry) => entry.Put?.Item?.entity === 'ActivityIndex'),
    ).toHaveLength(1);
    expect(
      items.filter((entry) => entry.Put?.Item?.entity === 'Idempotency'),
    ).toHaveLength(1);
  });

  it('requires the P2-38 idempotency key before reading the activity', async () => {
    const res = await post(createApp(), { date: '2026-08-12', timezone: 'UTC' }, {});
    expect(res.status).toBe(400);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('returns participant 403 and stranger 404 without a transaction', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: activity({ ownerId: 'usr_owner' }) as never,
    });
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [] })
      .resolves({
        Items: [{ entity: 'Participant', userId: 'usr_participant' }] as never,
      });

    expect(
      (await post(asUser('usr_participant'), { date: '2026-08-12', timezone: 'UTC' }))
        .status,
    ).toBe(403);

    ddbMock.resetHistory();
    ddbMock.on(GetCommand).resolves({
      Item: activity({ ownerId: 'usr_owner' }) as never,
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    expect(
      (await post(asUser('usr_stranger'), { date: '2026-08-12', timezone: 'UTC' }))
        .status,
    ).toBe(404);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
