import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';

import type { AppEnv } from '../app-env.js';
import type { RouteEntry } from './routeRegistry.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

const KEY = '6f9619ff-8b86-d011-b42d-00c04fc964ff';
const USER = 'usr_local_dev';
const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);

/** One creating route and one that is a POST but does not create. */
const REGISTRY: readonly RouteEntry[] = [
  { method: 'POST', pattern: '/v1/things', auth: 'authenticated', creates: true },
  { method: 'POST', pattern: '/v1/things/:id/complete', auth: 'authenticated' },
];

const conditionalFailure = () => {
  const error = new Error('The conditional request failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
};

/**
 * A two-route app over a test registry, so the middleware is exercised against a creating
 * `POST` before the product mounts one — `ROUTE_REGISTRY` holds only `GET /v1/health` in
 * Phase 1. The same reason `createRouteSplit` and `createRateLimit` take parameters.
 */
async function buildApp(options: {
  userId?: string | undefined;
  handler?: (c: { json: (b: unknown, s?: 201) => Response }) => Response;
}) {
  const { createIdempotency } = await import('./idempotency.js');
  const { errorHandler } = await import('./errorHandler.js');

  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('requestId', 'req_test');
    c.set('routeAuth', 'authenticated');
    if (options.userId !== undefined) c.set('userId', options.userId);
    await next();
  });
  app.use('*', createIdempotency({ registry: REGISTRY, now: () => NOW }));

  app.post('/v1/things', (c) =>
    options.handler === undefined
      ? c.json({ data: { id: 'act_1' }, meta: { requestId: 'req_test' } }, 201)
      : options.handler(c),
  );
  app.post('/v1/things/:id/complete', (c) => c.json({ data: 'completed' }));
  return app;
}

const post = (
  app: Hono<AppEnv>,
  path: string,
  headers: Record<string, string> = { 'Idempotency-Key': KEY },
) => app.fetch(new Request(`http://localhost${path}`, { method: 'POST', headers }));

beforeEach(() => {
  ddbMock.reset();
  vi.resetModules();
});

describe('which requests need a key', () => {
  it('requires one on a creating POST, and 400s without it', async () => {
    const app = await buildApp({ userId: USER });

    const res = await post(app, '/v1/things', {});
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details[0].path).toBe('Idempotency-Key');
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  /**
   * The reason `creates` is a registry flag rather than a check on the verb: complete, skip
   * and snooze are POSTs that are naturally idempotent and carry no key
   * (`phase-02-today-and-tasks.md` P2-09). Deriving it from `POST` would 400 every one.
   */
  it('requires nothing on a POST that does not create', async () => {
    const app = await buildApp({ userId: USER });

    const res = await post(app, '/v1/things/act_1/complete', {});

    expect(res.status).toBe(200);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('rejects a key that is not a UUID, since it becomes part of a partition key', async () => {
    const app = await buildApp({ userId: USER });

    const res = await post(app, '/v1/things', { 'Idempotency-Key': 'not-a-uuid' });

    expect(res.status).toBe(400);
  });
});

describe('the reservation', () => {
  it('claims the key with attribute_not_exists before running the handler', async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    const app = await buildApp({ userId: USER });

    await post(app, '/v1/things');

    const put = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(put?.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  /**
   * Pinned by a test rather than by intent, as P1-04 requires. A bare `IDEM#<key>` would let
   * one user's client-generated key return another user's stored response — a security
   * defect, not a shorthand (`data-model.md` §3.4).
   */
  it('scopes the partition key to the caller', async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    const app = await buildApp({ userId: USER });

    await post(app, '/v1/things');

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item).toMatchObject({
      pk: `IDEM#${USER}#${KEY}`,
      sk: 'META',
    });
  });

  it('sets a 24 hour ttl from when the key was first seen', async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    const app = await buildApp({ userId: USER });

    await post(app, '/v1/things');

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item?.ttl).toBe(
      Math.floor(NOW / 1000) + 24 * 60 * 60,
    );
  });
});

describe('a repeat with the same key', () => {
  it('replays the stored body without running the handler', async () => {
    const stored = JSON.stringify({
      data: { id: 'act_1' },
      meta: { requestId: 'req_1' },
    });
    ddbMock.on(PutCommand).rejects(conditionalFailure());
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { body: stored, status: 201, userId: USER } });

    const handler = vi.fn();
    const app = await buildApp({
      userId: USER,
      handler: (c) => {
        handler();
        return c.json({ data: 'fresh' });
      },
    });

    const res = await post(app, '/v1/things');

    expect(await res.text()).toBe(stored);
    expect(handler).not.toHaveBeenCalled();
  });

  /**
   * **200, not the stored 201.** `api-contract.md` §1 and P1-11's tests both say a repeat
   * returns the stored response with `200`. P1-04's own prose says "the stored status …
   * unchanged", which would answer 201 — the outlier, and raised in the PR.
   */
  it('answers 200 even though the original was 201', async () => {
    ddbMock.on(PutCommand).rejects(conditionalFailure());
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { body: '{"data":1}', status: 201, userId: USER } });
    const app = await buildApp({ userId: USER });

    const res = await post(app, '/v1/things');

    expect(res.status).toBe(200);
  });

  /** "Identical body" means the original request id travels with it. */
  it('carries the original requestId, not this request’s', async () => {
    const stored = JSON.stringify({ data: 1, meta: { requestId: 'req_original' } });
    ddbMock.on(PutCommand).rejects(conditionalFailure());
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { body: stored, status: 201, userId: USER } });
    const app = await buildApp({ userId: USER });

    const body = await (await post(app, '/v1/things')).json();

    expect(body.meta.requestId).toBe('req_original');
  });
});

describe('a concurrent duplicate', () => {
  /**
   * The loser of the conditional write finds a reservation with no body: a request with this
   * key is running right now. `409` rather than a replay of nothing, and rather than letting
   * a second handler create a duplicate.
   */
  it('409s while the first request is still in flight', async () => {
    ddbMock.on(PutCommand).rejects(conditionalFailure());
    ddbMock.on(GetCommand).resolves({ Item: { userId: USER, route: 'POST /v1/things' } });

    const handler = vi.fn();
    const app = await buildApp({
      userId: USER,
      handler: (c) => {
        handler();
        return c.json({ data: 'fresh' });
      },
    });

    const res = await post(app, '/v1/things');

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('conflict');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('only successful responses are stored', () => {
  it('stores the body and status on success', async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    const app = await buildApp({ userId: USER });

    await post(app, '/v1/things');

    const update = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(update?.ExpressionAttributeValues?.[':status']).toBe(201);
    expect(String(update?.ExpressionAttributeValues?.[':body'])).toContain('act_1');
  });

  /**
   * Without the release, a 500 would hold the key for 24 hours and the client's retry — the
   * entire reason it sent a key — would come back 409 until tomorrow.
   */
  it('releases the key when the handler throws, so the retry is not blocked', async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});
    const app = await buildApp({
      userId: USER,
      handler: () => {
        throw new Error('handler exploded');
      },
    });

    const res = await post(app, '/v1/things');

    expect(res.status).toBe(500);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('releases the key when the handler returns a 4xx without throwing', async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});
    const app = await buildApp({
      userId: USER,
      handler: (c) => c.json({ error: 'nope' }, 422 as 201),
    });

    await post(app, '/v1/things');

    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe('the response still reaches the caller', () => {
  /** `clone()` before reading: consuming the body would send an empty one. */
  it('does not consume the body it stores', async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    const app = await buildApp({ userId: USER });

    const res = await post(app, '/v1/things');
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.id).toBe('act_1');
  });
});

describe('a route with no resolved user', () => {
  it('writes no record rather than keying one under a shared fallback', async () => {
    ddbMock.on(PutCommand).resolves({});
    const app = await buildApp({ userId: undefined });

    await post(app, '/v1/things');

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});
