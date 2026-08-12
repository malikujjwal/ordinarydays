import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';

import type { AppEnv } from '../app-env.js';
import { IdempotencyRaceError } from '../lib/idempotency.js';
import type { RouteEntry } from './routeRegistry.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const KEY = '6f9619ff-8b86-d011-b42d-00c04fc964ff';
const USER = 'usr_local_dev';
const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);

let createIdempotency: typeof import('./idempotency.js')['createIdempotency'];
let errorHandler: typeof import('./errorHandler.js')['errorHandler'];

const REGISTRY: readonly RouteEntry[] = [
  { method: 'POST', pattern: '/v1/things', auth: 'authenticated', mutates: true },
  {
    method: 'POST',
    pattern: '/v1/capture/parse',
    auth: 'authenticated',
    mutates: false,
  },
];

function buildApp(options: {
  handler?: () => Response;
  replayReads?: number;
  drainCleanup?: (ref: {
    activityId: string;
    userId: string;
    idempotencyKey: string;
  }) => Promise<void>;
}) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('requestId', 'req_test');
    c.set('routeAuth', 'authenticated');
    c.set('userId', USER);
    await next();
  });
  app.use(
    '*',
    createIdempotency({
      registry: REGISTRY,
      now: () => NOW,
      ...(options.replayReads === undefined ? {} : { replayReads: options.replayReads }),
      wait: async () => {},
      ...(options.drainCleanup === undefined
        ? {}
        : { drainCleanup: options.drainCleanup }),
    }),
  );
  app.post(
    '/v1/things',
    () =>
      options.handler?.() ??
      new Response('{"data":{"id":"act_1"}}', {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  app.post('/v1/capture/parse', (c) => c.json({ data: 'draft' }));
  return app;
}

const post = (app: Hono<AppEnv>, path: string, key?: string) =>
  app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: key === undefined ? {} : { 'Idempotency-Key': key },
    }),
  );

beforeAll(async () => {
  const [idempotencyModule, errorModule] = await Promise.all([
    import('./idempotency.js'),
    import('./errorHandler.js'),
  ]);
  createIdempotency = idempotencyModule.createIdempotency;
  errorHandler = errorModule.errorHandler;
});

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(GetCommand).resolves({});
});

describe('mutating POST classification', () => {
  it('requires a UUID key on a mutating POST', async () => {
    const res = await post(buildApp({}), '/v1/things');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
  });

  it('explicitly permits a read-only POST stub without a key', async () => {
    expect((await post(buildApp({}), '/v1/capture/parse')).status).toBe(200);
  });
});

describe('replay', () => {
  it('returns the original stored status and body unchanged, including 201', async () => {
    const stored = '{"data":{"id":"act_1"},"meta":{"requestId":"req_original"}}';
    ddbMock.on(GetCommand).resolves({ Item: { body: stored, status: 201 } });
    const handler = vi.fn(() => new Response('fresh', { status: 201 }));

    const res = await post(buildApp({ handler }), '/v1/things', KEY);

    expect(res.status).toBe(201);
    expect(await res.text()).toBe(stored);
    expect(handler).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input.ConsistentRead).toBe(true);
  });

  it('drains referenced cleanup before returning the stored response', async () => {
    const ref = { activityId: 'act_1', userId: USER, idempotencyKey: KEY };
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { body: '{"data":1}', status: 201, cleanupRef: ref } });
    const drainCleanup = vi.fn(async () => {});

    const res = await post(buildApp({ drainCleanup }), '/v1/things', KEY);

    expect(res.status).toBe(201);
    expect(drainCleanup).toHaveBeenCalledWith(ref);
  });

  it('returns a retryable 503 when cleanup cannot be drained', async () => {
    const ref = { activityId: 'act_1', userId: USER, idempotencyKey: KEY };
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { body: '{"data":1}', status: 201, cleanupRef: ref } });
    const res = await post(
      buildApp({
        drainCleanup: async () => {
          throw new Error('transient');
        },
      }),
      '/v1/things',
      KEY,
    );
    expect(res.status).toBe(503);
  });
});

describe('concurrent first attempts', () => {
  it('strongly reads with bounded retry after the receipt condition loses', async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({})
      .resolvesOnce({})
      .resolves({ Item: { body: '{"data":{"id":"winner"}}', status: 201 } });
    const app = buildApp({
      handler: () => {
        throw new IdempotencyRaceError();
      },
      replayReads: 3,
    });

    const res = await post(app, '/v1/things', KEY);

    const body = await res.text();
    expect({
      status: res.status,
      body,
      reads: ddbMock.commandCalls(GetCommand).length,
    }).toEqual({
      status: 201,
      body: '{"data":{"id":"winner"}}',
      reads: 3,
    });
  });

  it('returns 503 rather than inventing an in-flight record when no winner appears', async () => {
    const app = buildApp({
      handler: () => {
        throw new IdempotencyRaceError();
      },
      replayReads: 2,
    });
    expect((await post(app, '/v1/things', KEY)).status).toBe(503);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(3);
  });
});
