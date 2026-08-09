import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { localToday } from '../handlers/listActivities.js';

process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';

import type { createApp as CreateApp } from '../app.js';

/** `GET /v1/activities?filter=` (P1-16). */
const ddbMock = mockClient(DynamoDBDocumentClient);

let createApp: typeof CreateApp;

const DEV = 'usr_local_dev';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';

/** An index row as `indexItem` writes it, storage attributes and all. */
const indexRow = (overrides: Record<string, unknown> = {}) => ({
  pk: `USER#${DEV}`,
  sk: `IDX#${ACT}`,
  entity: 'ActivityIndex',
  gsi1pk: `U#${DEV}#S`,
  gsi1sk: `2026-08-15T19:30#${ACT}`,
  activityId: ACT,
  type: 'task',
  title: 'Buy milk',
  status: 'scheduled',
  time: '19:30',
  isRecurring: false,
  participantAvatars: [],
  participantCount: 0,
  subtitle: 'Paris weekend',
  locationLabel: 'Home',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  schemaVersion: 1,
  ...overrides,
});

const seed = (items: Record<string, unknown>[], nextKey?: Record<string, unknown>) => {
  ddbMock.on(QueryCommand).resolves({
    Items: items as never,
    ...(nextKey === undefined ? {} : { LastEvaluatedKey: nextKey as never }),
  });
};

beforeEach(async () => {
  ddbMock.reset();
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

const list = (
  app: ReturnType<typeof CreateApp>,
  query: string,
  headers: Record<string, string> = {},
) => app.fetch(new Request(`http://localhost/v1/activities?${query}`, { headers }));

/** The GSI1 query the request issued, ignoring the rate limiter's own writes. */
const sentQuery = () => ddbMock.commandCalls(QueryCommand)[0]?.args[0]?.input;

describe('a page of a stage', () => {
  it('returns the rows, projected', async () => {
    seed([indexRow()]);

    const res = await list(createApp(), 'filter=upcoming');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({
      activityId: ACT,
      type: 'task',
      title: 'Buy milk',
      status: 'scheduled',
      time: '19:30',
      isRecurring: false,
      participantCount: 0,
      locationLabel: 'Home',
      subtitle: 'Paris weekend',
    });
    expect(body.meta.requestId).toMatch(/^req_/);
  });

  it('never returns the storage or index attributes', async () => {
    seed([indexRow()]);

    const body = await (await list(createApp(), 'filter=upcoming')).json();

    for (const field of [
      'pk',
      'sk',
      'entity',
      'gsi1pk',
      'gsi1sk',
      'participantAvatars',
    ]) {
      expect(body.data[0]).not.toHaveProperty(field);
    }
  });

  it('returns a body the shared row schema accepts', async () => {
    const { activityListItem } = await import('@od/shared/schemas');
    seed([indexRow()]);

    const body = await (await list(createApp(), 'filter=upcoming')).json();

    expect(activityListItem.safeParse(body.data[0]).success).toBe(true);
  });

  it('answers an empty stage with an empty array and no cursor', async () => {
    seed([]);

    const body = await (await list(createApp(), 'filter=saved')).json();

    expect(body.data).toEqual([]);
    expect(body.meta).not.toHaveProperty('nextCursor');
  });

  it('carries nextCursor when there is another page', async () => {
    seed([indexRow()], { pk: `USER#${DEV}`, sk: `IDX#${ACT}`, gsi1pk: 'x', gsi1sk: 'y' });

    const body = await (await list(createApp(), 'filter=upcoming')).json();

    expect(typeof body.meta.nextCursor).toBe('string');
  });

  it('reads the index, not the table', async () => {
    seed([indexRow()]);

    await list(createApp(), 'filter=upcoming');

    expect(sentQuery()?.IndexName).toBeDefined();
  });
});

/**
 * Each filter reads exactly one bucket, in the direction `api-contract.md` §2.2a's stage
 * table gives. One bucket per filter is what lets a page be one Query and one cursor.
 */
describe('each filter reads its own bucket', () => {
  it.each([
    ['upcoming', 'S', true],
    ['past', 'S', false],
    ['needs_date', 'P', false],
    ['saved', 'N', false],
  ] as const)('%s reads #%s', async (filter, bucket, ascending) => {
    seed([]);

    await list(createApp(), `filter=${filter}`);

    expect(sentQuery()?.ExpressionAttributeValues?.[':pk']).toBe(`U#${DEV}#${bucket}`);
    // `ScanIndexForward` is omitted when ascending, set to false when not.
    expect(sentQuery()?.ScanIndexForward ?? true).toBe(ascending);
  });

  /**
   * **The pivot is the bare date, and that is what makes the split exact.** A `gsi1sk` is
   * `<date>T<time>#<id>`, so the string `2026-08-09` sorts before `2026-08-09T00:00#…` —
   * "before today" therefore excludes everything dated today, and "today forward" includes
   * it, with no date arithmetic anywhere.
   */
  it('splits the scheduled bucket at today', async () => {
    seed([]);
    await list(createApp(), 'filter=upcoming', { 'X-Client-Timezone': 'UTC' });
    const upcoming = sentQuery()?.ExpressionAttributeValues;

    ddbMock.reset();
    seed([]);
    await list(createApp(), 'filter=past', { 'X-Client-Timezone': 'UTC' });
    const past = sentQuery()?.ExpressionAttributeValues;

    const today = new Date().toISOString().slice(0, 10);
    expect(upcoming?.[':from']).toBe(today);
    expect(upcoming?.[':to']).toBe('9999-12-31');
    expect(past?.[':from']).toBe('0000-01-01');
    expect(past?.[':to']).toBe(today);
  });

  /** The undated stages have no window — the whole bucket is the stage. */
  it.each(['saved', 'needs_date'])('%s queries the whole bucket', async (filter) => {
    seed([]);

    await list(createApp(), `filter=${filter}`);

    expect(sentQuery()?.ExpressionAttributeValues).not.toHaveProperty(':from');
  });
});

describe('the query string', () => {
  it('400s a missing filter — there is no default stage', async () => {
    seed([]);

    const res = await list(createApp(), '');
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(JSON.stringify(body.error.details)).toContain('filter');
  });

  /** The two values P1-16 removed from the enum, and one plain typo. */
  it.each(['inbox', 'anytime', 'upcomming'])('400s filter=%s', async (filter) => {
    seed([]);

    const res = await list(createApp(), `filter=${filter}`);

    expect(res.status).toBe(400);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('400s an unknown type', async () => {
    seed([]);

    expect((await list(createApp(), 'filter=saved&type=chore')).status).toBe(400);
  });

  it.each(['0', '201', 'many'])('400s limit=%s', async (limit) => {
    seed([]);

    expect((await list(createApp(), `filter=saved&limit=${limit}`)).status).toBe(400);
  });

  it('400s a malformed cursor', async () => {
    seed([]);

    expect((await list(createApp(), 'filter=saved&cursor=not a cursor')).status).toBe(
      400,
    );
  });

  it('400s an unknown parameter rather than ignoring it', async () => {
    seed([]);

    const res = await list(createApp(), 'filter=saved&sort=title');

    expect(res.status).toBe(400);
    expect(JSON.stringify((await res.json()).error.details)).toContain('sort');
  });

  it('defaults the page size to 50', async () => {
    seed([]);

    await list(createApp(), 'filter=saved');

    expect(sentQuery()?.Limit).toBe(50);
  });

  it('passes a supplied limit through', async () => {
    seed([]);

    await list(createApp(), 'filter=saved&limit=200');

    expect(sentQuery()?.Limit).toBe(200);
  });
});

/**
 * `type` is applied to the rows the Query returned, because DynamoDB cannot filter a GSI on
 * a non-key attribute without reading them first. The consequence is the surprising part.
 */
describe('narrowing by type', () => {
  it('keeps only the matching rows', async () => {
    seed([
      indexRow({ type: 'task' }),
      indexRow({ type: 'meal', activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3' }),
    ]);

    const body = await (await list(createApp(), 'filter=saved&type=meal')).json();

    expect(body.data).toHaveLength(1);
    expect(body.data[0].type).toBe('meal');
  });

  /**
   * **A short page is not the end of the list.** A client that stops paging when a page comes
   * back short loses rows — which is why the cursor, not the page length, is the signal.
   */
  it('can return an empty page while still carrying a cursor', async () => {
    seed([indexRow({ type: 'task' })], {
      pk: `USER#${DEV}`,
      sk: `IDX#${ACT}`,
      gsi1pk: 'x',
      gsi1sk: 'y',
    });

    const body = await (await list(createApp(), 'filter=saved&type=meal')).json();

    expect(body.data).toEqual([]);
    expect(typeof body.meta.nextCursor).toBe('string');
  });
});

describe('whose activities it lists', () => {
  it('queries the partition of whoever identity resolved', async () => {
    seed([]);
    const app = createApp({
      identityProvider: { resolve: () => Promise.resolve('usr_someone_else') },
    });

    await list(app, 'filter=saved');

    expect(sentQuery()?.ExpressionAttributeValues?.[':pk']).toBe('U#usr_someone_else#N');
  });
});

/**
 * Which day "today" is decides which side of `upcoming`/`past` a row falls on. The header is
 * the documented source; UTC is the fallback, because a list a few hours out at the boundary
 * beats no list at all.
 */
describe('localToday', () => {
  const instant = new Date('2026-08-09T02:00:00.000Z');

  it('uses the caller’s zone, not the server’s', () => {
    // 02:00 UTC is still the 8th in New York.
    expect(localToday(instant, 'America/New_York')).toBe('2026-08-08');
    expect(localToday(instant, 'Asia/Tokyo')).toBe('2026-08-09');
  });

  it('falls back to UTC when the header is absent or empty', () => {
    expect(localToday(instant, undefined)).toBe('2026-08-09');
    expect(localToday(instant, '')).toBe('2026-08-09');
  });

  /** A hostile or misspelled zone must not turn a list request into a 500. */
  it('falls back to UTC on an unusable zone rather than throwing', () => {
    expect(localToday(instant, 'Not/AZone')).toBe('2026-08-09');
  });

  it('formats as ISO, whatever the host locale would prefer', () => {
    expect(localToday(instant, 'UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
