import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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
import type { RouteAuth } from './routeRegistry.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
let rateLimitModule: typeof import('./rateLimit.js');
let errorHandler: typeof import('./errorHandler.js')['errorHandler'];

/** 2026-08-09T00:00:30Z. Thirty seconds into the window, so `Retry-After` is 30. */
const MID_WINDOW = Date.UTC(2026, 7, 9, 0, 0, 30);

const conditionalFailure = () => {
  const error = new Error('The conditional request failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
};

/**
 * A one-route app per `RouteAuth` kind, so the limiter can be exercised against an
 * `authenticated` route before the product mounts one — `ROUTE_REGISTRY` holds only
 * `/v1/health` in Phase 1. Same reason `createRouteSplit` and `createIdentity` take
 * parameters: the alternative is a branch that ships untested until some later task happens
 * to mount a route that exercises it.
 */
async function appWith(options: {
  auth: RouteAuth;
  method?: 'GET' | 'POST';
  path?: string;
  userId?: string | undefined;
}) {
  const path = options.path ?? '/probe';
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('requestId', 'req_test');
    c.set('routeAuth', options.auth);
    if (options.userId !== undefined) c.set('userId', options.userId);
    await next();
  });
  app.use('*', rateLimitModule.createRateLimit({ now: () => MID_WINDOW }));

  if ((options.method ?? 'GET') === 'POST') {
    app.post(path, (c) => c.json({ data: 'ok' }));
  } else {
    app.get(path, (c) => c.json({ data: 'ok' }));
  }

  return {
    call: () =>
      app.fetch(
        new Request(`http://localhost${path}`, { method: options.method ?? 'GET' }),
      ),
  };
}

beforeAll(async () => {
  const [loadedRateLimitModule, errorModule] = await Promise.all([
    import('./rateLimit.js'),
    import('./errorHandler.js'),
  ]);
  rateLimitModule = loadedRateLimitModule;
  errorHandler = errorModule.errorHandler;
});

beforeEach(() => {
  ddbMock.reset();
});

describe('what is limited', () => {
  it('counts an authenticated request', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { call } = await appWith({ auth: 'authenticated', userId: 'usr_local_dev' });

    const res = await call();

    expect(res.status).toBe(200);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  /**
   * `/v1/health` is what every smoke test and CloudWatch alarm calls, it is absent from
   * `api-contract.md` §4's table, and it performs no I/O. A limiter that could silence the
   * liveness signal would turn a traffic spike into a false outage.
   */
  it.each<RouteAuth>(['unauthenticated-private', 'public'])(
    'writes no counter for a %s route',
    async (auth) => {
      ddbMock.on(UpdateCommand).resolves({});
      const { call } = await appWith({ auth });

      const res = await call();

      expect(res.status).toBe(200);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    },
  );

  /**
   * An `authenticated` route with no user means its `ROUTE_REGISTRY` entry is wrong.
   * Limiting it under a shared fallback subject would hide that behind a counter every
   * caller shares; `requireUserId` in the handler raises the real fault instead.
   */
  it('does not invent a subject when an authenticated route resolved no user', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { call } = await appWith({ auth: 'authenticated', userId: undefined });

    await call();

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe('over the limit', () => {
  /**
   * The 121st request in a window. The mock raises the condition failure the 120-limit
   * `ConditionExpression` produces, which is how the real table reports it.
   */
  it('answers 429 with the contract envelope', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalFailure());
    const { call } = await appWith({ auth: 'authenticated', userId: 'usr_local_dev' });

    const res = await call();
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.requestId).toBe('req_test');
  });

  it('sends Retry-After in seconds to the window end', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalFailure());
    const { call } = await appWith({ auth: 'authenticated', userId: 'usr_local_dev' });

    const res = await call();

    expect(res.headers.get('Retry-After')).toBe('30');
  });

  /**
   * The regression this guards: `errorHandler` maps a raw
   * `ConditionalCheckFailedException` to `conflict`, so letting the exception escape the
   * middleware would answer **409** — a plausible-looking status that tells a client to
   * resolve a conflict that does not exist, and never to back off.
   */
  it('is 429 and not the 409 the raw DynamoDB exception would produce', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalFailure());
    const { call } = await appWith({ auth: 'authenticated', userId: 'usr_local_dev' });

    const res = await call();

    expect(res.status).not.toBe(409);
    expect(res.status).toBe(429);
  });

  it('does not run the handler', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalFailure());
    const handler = vi.fn();

    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('requestId', 'req_test');
      c.set('routeAuth', 'authenticated');
      c.set('userId', 'usr_local_dev');
      await next();
    });
    app.use('*', rateLimitModule.createRateLimit({ now: () => MID_WINDOW }));
    app.get('/probe', (c) => {
      handler();
      return c.json({ data: 'ok' });
    });

    await app.fetch(new Request('http://localhost/probe'));

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('when DynamoDB is unavailable', () => {
  /** A limiter that takes the API down is worse than one that lets a request through. */
  it('allows the request', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('network down'));
    const { call } = await appWith({ auth: 'authenticated', userId: 'usr_local_dev' });

    const res = await call();

    expect(res.status).toBe(200);
  });
});

describe('the rules', () => {
  it('gives an authenticated route the general 120/min allowance', () => {
    expect(rateLimitModule.ruleFor('authenticated', 'GET', '/v1/activities')).toEqual({
      scope: 'general',
      limit: 120,
      windowSeconds: 60,
    });
  });

  /**
   * Neither route is mounted yet — capture is P1-18, `upload-url` is Phase 3 — but the rule
   * is asserted now because its *absence* is what would go unnoticed: a capture endpoint
   * inheriting 120/min would be 120 model calls a minute against the spend the row exists to
   * protect, and nothing about that looks wrong in a log.
   */
  it('gives POST /v1/capture/* the tighter 20/hour, protecting the model spend', () => {
    expect(rateLimitModule.ruleFor('authenticated', 'POST', '/v1/capture/parse')).toEqual(
      {
        scope: 'capture',
        limit: 20,
        windowSeconds: 3600,
      },
    );
  });

  it('gives POST /v1/attachments/upload-url 60/hour', () => {
    expect(
      rateLimitModule.ruleFor('authenticated', 'POST', '/v1/attachments/upload-url'),
    ).toEqual({
      scope: 'upload-url',
      limit: 60,
      windowSeconds: 3600,
    });
  });

  it('matches an override on the method too, so a GET falls back to the general rule', () => {
    expect(
      rateLimitModule.ruleFor('authenticated', 'GET', '/v1/capture/parse')?.scope,
    ).toBe('general');
  });

  it.each<RouteAuth>(['public', 'unauthenticated-private'])(
    'has no rule for a %s route',
    (auth) => {
      expect(rateLimitModule.ruleFor(auth, 'GET', '/probe')).toBeUndefined();
    },
  );

  /** Distinct scopes are what stop an hourly counter sharing a partition with a per-minute one. */
  it('gives every rule its own scope', () => {
    expect(new Set(rateLimitModule.SCOPES).size).toBe(rateLimitModule.SCOPES.length);
  });
});
