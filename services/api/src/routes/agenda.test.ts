import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
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

const request = (
  app: ReturnType<typeof CreateApp>,
  query: string,
  headers: Record<string, string> = {},
) =>
  app.fetch(
    new Request(`http://localhost/v1/agenda?${query}`, {
      headers: { 'X-Request-Id': 'req_agenda_test', ...headers },
    }),
  );

const query = (from = '2026-08-01', to = '2026-08-01', extra = '') =>
  `from=${from}&to=${to}&tz=America%2FNew_York${extra}`;

const ACTIVITY_ID = 'act_01J0000000000000000000000A';
const VERSION = '2026-08-01T12:00:00.000Z';
const activityRow = (status = 'scheduled') => ({
  pk: `ACT#${ACTIVITY_ID}`,
  sk: 'META',
  entity: 'Activity',
  activityId: ACTIVITY_ID,
  ownerId: 'usr_local_dev',
  objectKind: 'task',
  type: 'task',
  title: 'Canonical series',
  status,
  schedule: { date: '2026-08-01', time: '09:00', timezone: 'America/New_York' },
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
  createdAt: VERSION,
  updatedAt: VERSION,
  lastActivityAt: VERSION,
  schemaVersion: 1,
});

const targetedRequest = (app: ReturnType<typeof CreateApp>) =>
  app.fetch(
    new Request(`http://localhost/v1/agenda/activities/${ACTIVITY_ID}?${query()}`, {
      headers: { 'X-Request-Id': 'req_targeted_agenda' },
    }),
  );

beforeEach(async () => {
  ddbMock.reset();
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

describe('GET /v1/agenda', () => {
  it('returns a complete empty day in the standard envelope without storage fields', async () => {
    const res = await request(createApp(), query());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      data: {
        days: [{ date: '2026-08-01', schedule: [], anytime: [], earlier: [] }],
        warnings: [],
        projectionVersions: [],
      },
      meta: { requestId: 'req_agenda_test' },
    });
    expect(JSON.stringify(body)).not.toContain('gsi1pk');
  });

  it('accepts an inclusive 62-day window', async () => {
    const res = await request(createApp(), query('2026-08-01', '2026-10-01'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.days).toHaveLength(62);
    expect(body.data.days.at(-1)?.date).toBe('2026-10-01');
  });

  it("accepts Today's one-request include combination", async () => {
    const res = await request(
      createApp(),
      query('2026-08-06', '2026-08-07', '&include=anytime_unscheduled,overdue,reminders'),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.days).toHaveLength(2);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(4);
  });

  it('400s a 63-day window before agenda reads', async () => {
    const res = await request(createApp(), query('2026-08-01', '2026-10-02'));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(JSON.stringify(body.error.details)).toContain('to');
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it.each([
    ['a reversed window', 'from=2026-08-02&to=2026-08-01&tz=UTC'],
    ['an unknown include token', query(undefined, undefined, '&include=unknown')],
    [
      'a duplicate include token',
      query(undefined, undefined, '&include=overdue,overdue'),
    ],
    ['an unknown parameter', query(undefined, undefined, '&page=today')],
  ])('400s %s', async (_case, value) => {
    const res = await request(createApp(), value);

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('400s a structurally valid timezone Node does not support', async () => {
    const res = await request(
      createApp(),
      'from=2026-08-01&to=2026-08-01&tz=Not%2FAZone',
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.details).toEqual([
      { path: 'tz', message: 'Expected a supported IANA timezone' },
    ]);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('returns 401 when identity resolution fails', async () => {
    const { AppError } = await import('../lib/errors.js');
    const app = createApp({
      identityProvider: {
        resolve: () =>
          Promise.reject(new AppError('unauthenticated', 'Authentication required.')),
      },
    });

    const res = await request(app, query());

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('sets a private 60-second cache policy and a strong ETag', async () => {
    const res = await request(createApp(), query());

    expect(res.headers.get('Cache-Control')).toBe('private, max-age=60');
    expect(res.headers.get('ETag')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
  });

  it('ETag ignores requestId', async () => {
    const first = await request(createApp(), query(), {
      'X-Request-Id': 'req_first',
    });
    const etag = first.headers.get('ETag');

    const second = await request(createApp(), query(), {
      'X-Request-Id': 'req_second',
      'If-None-Match': String(etag),
    });

    expect((await first.json()).meta.requestId).toBe('req_first');
    expect(second.headers.get('ETag')).toBe(etag);
    expect(second.headers.get('X-Request-Id')).toBe('req_second');
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  it.each([
    ['a weak current validator', (etag: string) => `W/${etag}`],
    ['a validator list containing the current one', (etag: string) => `"stale", ${etag}`],
    ['the wildcard', () => '*'],
  ])('returns 304 for %s', async (_case, header) => {
    const first = await request(createApp(), query());
    const etag = String(first.headers.get('ETag'));
    const second = await request(createApp(), query(), {
      'If-None-Match': header(etag),
    });

    expect(second.status).toBe(304);
    expect(second.headers.get('Cache-Control')).toBe('private, max-age=60');
  });
});

describe('GET /v1/agenda/activities/:id', () => {
  it('bypasses GSI discovery with one strongly consistent partition read', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        activityRow(),
        {
          pk: `ACT#${ACTIVITY_ID}`,
          sk: 'OCC#2026-08-01',
          entity: 'Occurrence',
          activityId: ACTIVITY_ID,
          date: '2026-08-01',
          status: 'completed',
          completedAt: '2026-08-01T14:00:00.000Z',
          schemaVersion: 1,
        },
      ],
    });

    const res = await targetedRequest(createApp());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(body.data).toMatchObject({
      activityId: ACTIVITY_ID,
      activityVersion: VERSION,
      rows: [
        {
          date: '2026-08-01',
          item: {
            activityId: ACTIVITY_ID,
            occurrenceDate: '2026-08-01',
            status: 'completed_occurrence',
          },
        },
      ],
    });
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]?.input).toMatchObject({
      ConsistentRead: true,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeValues: { ':pk': `ACT#${ACTIVITY_ID}` },
    });
    expect(calls[0]?.args[0]?.input.IndexName).toBeUndefined();
  });

  it('returns authoritative zero rows with the META version', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [activityRow('cancelled')] });

    const res = await targetedRequest(createApp());

    expect((await res.json()).data).toEqual({
      activityId: ACTIVITY_ID,
      activityVersion: VERSION,
      rows: [],
    });
  });
});
