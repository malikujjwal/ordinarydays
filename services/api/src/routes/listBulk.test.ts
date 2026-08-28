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

/**
 * `clear-checked`, `uncheck-all` and `undo` at the HTTP boundary (P3-10).
 *
 * The compensation itself is proved against DynamoDB Local in
 * `test/integration/listUndo.int.test.ts` — restoring seven rows byte-identically across
 * several transactions is about what storage really does. What is proved here is the contract
 * around it: who may call, what the body may carry, and the shape of the answer for a token
 * that no longer applies.
 */
const ddbMock = mockClient(DynamoDBDocumentClient);

let createApp: typeof CreateApp;

const DEV = 'usr_local_dev';
const LST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';

const listMetaRow = (overrides: Record<string, unknown> = {}) => ({
  pk: `LIST#${LST}`,
  sk: 'META',
  entity: 'List',
  schemaVersion: 2,
  listId: LST,
  ownerId: DEV,
  templateKey: 'groceries',
  title: 'Groceries',
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  itemStateMode: { mode: 'checkbox' },
  featureConfig: {},
  slot: null,
  itemCount: 0,
  doneCount: 0,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: '2026-08-23T00:00:00.000Z',
  lastItemActivityAt: '2026-08-23T00:00:00.000Z',
  ...overrides,
});

const pointerRow = (userId = DEV, role = 'owner') => ({
  pk: `USER#${userId}`,
  sk: `LIST#${LST}`,
  entity: 'ListIndex',
  listId: LST,
  userId,
  role,
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
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

const asUser = (userId: string) =>
  createApp({ identityProvider: { resolve: () => Promise.resolve(userId) } });

const post = (
  app: ReturnType<typeof CreateApp>,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { 'Idempotency-Key': crypto.randomUUID() },
) =>
  app.fetch(
    new Request(`http://localhost/v1/lists/${LST}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

describe('the bulk actions', () => {
  it.each(['clear-checked', 'uncheck-all'])(
    '%s answers with a count and a ten-second offer',
    async (action) => {
      seedGets([pointerRow(), listMetaRow()]);

      const res = await post(createApp(), action);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.affectedCount).toBe(0);
      expect(body.data.undoToken).toEqual(expect.any(String));
      expect(
        Date.parse(body.data.undoExpiresAt) - Date.parse(new Date().toISOString()),
      ).toBeGreaterThan(8_000);
    },
  );

  /**
   * The registry classifies all three as mutating POSTs, so the shared middleware — not a
   * second receipt path — refuses a request with no key. A compensation is exactly the kind
   * of write an offline coordinator replays.
   */
  it.each(['clear-checked', 'uncheck-all'])(
    '%s requires an Idempotency-Key',
    async (action) => {
      seedGets([pointerRow(), listMetaRow()]);

      const res = await post(createApp(), action, undefined, {});
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.details[0].path).toBe('Idempotency-Key');
    },
  );

  it.each(['clear-checked', 'uncheck-all'])(
    '%s 404s a caller with no pointer',
    async (action) => {
      seedGets([listMetaRow()]);

      expect((await post(asUser('usr_stranger'), action)).status).toBe(404);
    },
  );
});

describe('the compensation endpoint', () => {
  it('requires an Idempotency-Key of its own', async () => {
    seedGets([pointerRow(), listMetaRow()]);

    const res = await post(createApp(), 'undo', { undoToken: 'op_x.secret' }, {});

    expect(res.status).toBe(400);
    expect((await res.json()).error.details[0].path).toBe('Idempotency-Key');
  });

  /**
   * "Clients must not send deleted row contents back as authority" (`api-contract.md` §2.7).
   * The server holds the snapshot; the body carries the token and nothing else.
   */
  it('400s a body carrying anything but the token', async () => {
    seedGets([pointerRow(), listMetaRow()]);

    const res = await post(createApp(), 'undo', {
      undoToken: 'op_x.secret',
      items: [{ itemId: 'itm_x', title: 'Smuggled back in' }],
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(JSON.stringify(body.error.details)).toContain('items');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('400s a missing token', async () => {
    seedGets([pointerRow(), listMetaRow()]);

    expect((await post(createApp(), 'undo', {})).status).toBe(400);
  });

  /**
   * A token that names nothing, one whose hash does not match and one past retention are all
   * `expired` — deliberately indistinguishable, so a caller learns nothing about an operation
   * they may not own. `200`, because the server was asked what happened to a compensation and
   * that is the answer.
   */
  it('answers 200 expired for a token that resolves to no operation', async () => {
    seedGets([pointerRow(), listMetaRow()]);

    const res = await post(createApp(), 'undo', { undoToken: 'op_missing.secret' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ outcome: 'expired' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('answers expired for a token with no addressable half', async () => {
    seedGets([pointerRow(), listMetaRow()]);

    const res = await post(createApp(), 'undo', { undoToken: 'no-separator-here' });

    expect((await res.json()).data).toEqual({ outcome: 'expired' });
  });

  it('404s a caller with no pointer, before it resolves anything', async () => {
    seedGets([listMetaRow()]);

    const res = await post(asUser('usr_stranger'), 'undo', {
      undoToken: 'op_x.secret',
    });

    expect(res.status).toBe(404);
  });
});

describe('the route registry', () => {
  it.each([
    '/v1/lists/:id/clear-checked',
    '/v1/lists/:id/uncheck-all',
    '/v1/lists/:id/undo',
  ])('classifies %s as a mutating POST', async (pattern) => {
    const { ROUTE_REGISTRY } = await import('../middleware/routeRegistry.js');

    expect(
      ROUTE_REGISTRY.find(
        (entry) => entry.method === 'POST' && entry.pattern === pattern,
      ),
    ).toEqual({ method: 'POST', pattern, auth: 'authenticated', mutates: true });
  });
});
