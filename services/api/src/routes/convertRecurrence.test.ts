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
const USER = 'usr_local_dev';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const OCCURRENCE_DATE = '2026-08-14';
let createApp: typeof CreateApp;

const series = {
  pk: `ACT#${ACT}`,
  sk: 'META',
  entity: 'Activity',
  activityId: ACT,
  ownerId: USER,
  objectKind: 'task',
  type: 'task',
  status: 'scheduled',
  title: 'Daily walk',
  schedule: {
    date: '2026-08-01',
    time: '09:00',
    timezone: 'America/New_York',
    scheduledAtUtc: '2026-08-01T13:00:00.000Z',
  },
  recurrence: {
    mode: 'fixed',
    segments: [{ freq: 'daily', effectiveFrom: '2026-08-01', time: '09:00' }],
  },
  participantCount: 0,
  childCount: 0,
  expenseTotalCents: 0,
  visibility: 'private',
  details: { kind: 'task' },
  icsSequence: 0,
  createdAt: '2026-08-01T10:00:00.000Z',
  lastActivityAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-08T10:00:00.000Z',
  schemaVersion: 1,
};

const occurrence = {
  pk: `ACT#${ACT}`,
  sk: `OCC#${OCCURRENCE_DATE}`,
  entity: 'Occurrence',
  activityId: ACT,
  date: OCCURRENCE_DATE,
  status: 'rescheduled',
  overrideTime: '18:30',
  createdAt: '2026-08-10T10:00:00.000Z',
  updatedAt: '2026-08-10T10:00:00.000Z',
  schemaVersion: 1,
};

beforeEach(async () => {
  ddbMock.reset();
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

describe('POST /v1/activities/:id/recurrence/convert', () => {
  it('rewrites META and its index atomically without rewriting occurrence history', async () => {
    ddbMock.on(GetCommand).resolves({ Item: series as never });
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [series, occurrence] as never })
      .resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    const response = await createApp().fetch(
      new Request(`http://localhost/v1/activities/${ACT}/recurrence/convert`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ occurrenceDate: OCCURRENCE_DATE }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      activityId: ACT,
      schedule: { date: OCCURRENCE_DATE, time: '18:30' },
    });
    expect(body.data).not.toHaveProperty('recurrence');

    const items =
      ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
    expect(items.some((entry) => entry.Put?.Item?.entity === 'Activity')).toBe(true);
    expect(items.some((entry) => entry.Put?.Item?.entity === 'ActivityIndex')).toBe(true);
    expect(items.some((entry) => entry.Put?.Item?.entity === 'Occurrence')).toBe(false);
    expect(
      items.some((entry) => entry.Delete?.Key?.sk === `OCC#${OCCURRENCE_DATE}`),
    ).toBe(false);
    expect(
      items.some(
        (entry) =>
          entry.ConditionCheck?.Key?.sk === `OCC#${OCCURRENCE_DATE}` &&
          entry.ConditionCheck.ConditionExpression === '#updatedAt = :expected',
      ),
    ).toBe(true);
  });
});
