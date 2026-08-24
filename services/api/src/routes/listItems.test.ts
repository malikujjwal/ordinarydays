import {
  BatchGetCommand,
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

/**
 * The six item routes' edge behaviour (P3-08).
 *
 * The rules that need a real list row — the caps, the two-part gates, ordered bulk, repair,
 * durable replay — are exercised against DynamoDB Local in
 * `test/integration/listItems.int.test.ts`. What is cheap and worth pinning here is what the
 * strict schemas refuse before anything is loaded, and what the registry says about each
 * route.
 */
const ddbMock = mockClient(DynamoDBDocumentClient);

let createApp: typeof CreateApp;

const DEV = 'usr_local_dev';
const LST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ITM = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X5';

const listMetaRow = (overrides: Record<string, unknown> = {}) => ({
  pk: `LIST#${LST}`,
  sk: 'META',
  entity: 'List',
  listId: LST,
  ownerId: DEV,
  behaviour: 'collection',
  templateKey: 'checklist',
  title: 'Errands',
  icon: 'check-square',
  emptyStateCopy: 'Add something to check off.',
  capabilities: { checkable: true, supportsLocation: false },
  slot: null,
  itemCount: 0,
  uncheckedCount: 0,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: '2026-08-23T00:00:00.000Z',
  ...overrides,
});

const pointerRow = (userId = DEV) => ({
  pk: `USER#${userId}`,
  sk: `LIST#${LST}`,
  entity: 'ListIndex',
  listId: LST,
  userId,
  role: 'owner',
  addedAt: '2026-08-23T00:00:00.000Z',
});

const seedGets = (rows: Record<string, unknown>[]) => {
  const byKey = new Map(rows.map((row) => [`${row.pk}|${row.sk}`, row]));
  ddbMock
    .on(GetCommand)
    .callsFake((input) => ({ Item: byKey.get(`${input.Key.pk}|${input.Key.sk}`) }));
};

beforeEach(async () => {
  ddbMock.reset();
  ddbMock.on(TransactWriteCommand).resolves({});
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  // Bulk resolves which stable ids already exist before writing a chunk.
  ddbMock.on(BatchGetCommand).resolves({ Responses: { 'od-main-local': [] } });
  seedGets([pointerRow(), listMetaRow()]);
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

const asUser = (userId: string) =>
  createApp({ identityProvider: { resolve: () => Promise.resolve(userId) } });

/**
 * Omitting `headers` mints an `Idempotency-Key` for a `POST`; passing them **replaces** that
 * default outright, which is the only way to send a creating request without one — spreading
 * an empty object over an already-added header cannot remove it.
 */
const send = (
  app: ReturnType<typeof CreateApp>,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) =>
  app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(headers ??
          (method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {})),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const post = (body: unknown, headers?: Record<string, string>) =>
  send(createApp(), 'POST', `/v1/lists/${LST}/items`, body, headers);

describe('the create body is strict at the edge', () => {
  it.each([
    ['checked', true],
    ['rank', 'a0'],
    ['itemRevision', 1],
    ['listId', LST],
    ['sourceActivityId', ACT],
    ['sourceLabel', 'Sunday dinner'],
  ])('400s the server-owned field %s before anything is loaded', async (field, value) => {
    const res = await post({ title: 'Eggs', [field]: value });

    expect(res.status).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('400s a missing title and an over-long one', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ title: '   ' })).status).toBe(400);
    expect((await post({ title: 'x'.repeat(201) })).status).toBe(400);
  });

  it('400s a malformed client-minted itemId', async () => {
    expect((await post({ itemId: 'itm_nope', title: 'Eggs' })).status).toBe(400);
  });

  it('requires an Idempotency-Key — the registry entry mutates', async () => {
    const res = await post({ title: 'Eggs' }, {});

    expect(res.status).toBe(400);
    expect((await res.json()).error.details?.[0]?.path).toBe('Idempotency-Key');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe('the bulk body is strict at the edge', () => {
  const bulk = (body: unknown) =>
    send(createApp(), 'POST', `/v1/lists/${LST}/items/bulk`, body);

  it('400s an empty batch and one over the item cap', async () => {
    expect((await bulk({ items: [] })).status).toBe(400);
    expect(
      (await bulk({ items: Array.from({ length: 501 }, () => ({ title: 'x' })) })).status,
    ).toBe(400);
  });

  /** P3-17 owns deriving provenance; the ordinary bulk route may never accept it. */
  it.each(['sourceActivityId', 'sourceLabel'])(
    '400s the provenance field %s',
    async (field) => {
      const res = await bulk({
        items: [{ title: 'Chicken', [field]: field === 'sourceLabel' ? 'Sunday' : ACT }],
      });

      expect(res.status).toBe(400);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    },
  );

  it('400s anything beside items, and requires an Idempotency-Key', async () => {
    expect((await bulk({ items: [{ title: 'Eggs' }], listId: LST })).status).toBe(400);
    const res = await send(
      createApp(),
      'POST',
      `/v1/lists/${LST}/items/bulk`,
      { items: [{ title: 'Eggs' }] },
      {},
    );
    expect(res.status).toBe(400);
  });

  it('routes bulk to its own handler rather than treating it as an item id', async () => {
    const res = await bulk({ items: [{ title: 'Eggs' }] });

    // A `404` here would mean `/items/bulk` matched `/items/:itemId`.
    expect(res.status).not.toBe(404);
  });
});

describe('the patch body is strict at the edge', () => {
  const patch = (body: unknown) =>
    send(createApp(), 'PATCH', `/v1/lists/${LST}/items/${ITM}`, body);

  it.each([
    ['rank', 'a0'],
    ['itemRevision', 2],
    ['itemId', ITM],
    ['sourceLabel', 'Sunday dinner'],
  ])('400s the server-owned field %s', async (field, value) => {
    expect((await patch({ [field]: value })).status).toBe(400);
  });

  it('needs no If-Match, unlike the Activity patch', async () => {
    seedGets([pointerRow(), listMetaRow()]);

    const res = await patch({ title: 'Free-range eggs' });

    // Whatever it answers, it is never the missing-If-Match validation failure.
    const body = res.status === 400 ? await res.json() : undefined;
    expect(body?.error?.details?.[0]?.path).not.toBe('If-Match');
  });
});

describe('who may touch items', () => {
  it('404s a stranger on every route, revealing nothing', async () => {
    // No pointer for this caller: the list may as well not exist.
    seedGets([listMetaRow()]);
    const stranger = asUser('usr_stranger');

    const attempts = [
      send(stranger, 'GET', `/v1/lists/${LST}/items`),
      send(stranger, 'GET', `/v1/lists/${LST}/items/${ITM}`),
      send(stranger, 'POST', `/v1/lists/${LST}/items`, { title: 'Eggs' }),
      send(stranger, 'POST', `/v1/lists/${LST}/items/bulk`, {
        items: [{ title: 'Eggs' }],
      }),
      send(stranger, 'PATCH', `/v1/lists/${LST}/items/${ITM}`, { title: 'Eggs' }),
      send(stranger, 'DELETE', `/v1/lists/${LST}/items/${ITM}`),
    ];

    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('not_found');
    }
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('401s when identity resolution fails', async () => {
    const { AppError } = await import('../lib/errors.js');
    const app = createApp({
      identityProvider: {
        resolve: () =>
          Promise.reject(new AppError('unauthenticated', 'Authentication required.')),
      },
    });

    const res = await send(app, 'GET', `/v1/lists/${LST}/items`);

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
  });
});

describe('the route registry', () => {
  it('classifies the two creating POSTs as mutating and nothing else', async () => {
    const { ROUTE_REGISTRY } = await import('../middleware/routeRegistry.js');
    const itemRoutes = ROUTE_REGISTRY.filter((entry) =>
      entry.pattern.startsWith('/v1/lists/:id/items'),
    );

    expect(itemRoutes).toEqual([
      { method: 'GET', pattern: '/v1/lists/:id/items', auth: 'authenticated' },
      {
        method: 'POST',
        pattern: '/v1/lists/:id/items',
        auth: 'authenticated',
        mutates: true,
      },
      {
        method: 'POST',
        pattern: '/v1/lists/:id/items/bulk',
        auth: 'authenticated',
        mutates: true,
      },
      { method: 'GET', pattern: '/v1/lists/:id/items/:itemId', auth: 'authenticated' },
      { method: 'PATCH', pattern: '/v1/lists/:id/items/:itemId', auth: 'authenticated' },
      { method: 'DELETE', pattern: '/v1/lists/:id/items/:itemId', auth: 'authenticated' },
    ]);
  });
});
