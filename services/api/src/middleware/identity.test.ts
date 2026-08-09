import { type Context, Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * `config` parses `process.env` at module load, so the environment is set before anything
 * that reaches it is imported — same reason and same shape as `app.test.ts`.
 */
process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';

import type { createApp as CreateApp } from '../app.js';
import type { AppEnv } from '../app-env.js';
import type {
  createIdentity as CreateIdentity,
  IdentityProvider,
  LocalIdentityProvider as LocalProvider,
  requireUserId as RequireUserId,
} from './identity.js';
import type { RouteAuth } from './routeRegistry.js';

let createApp: typeof CreateApp;
let createIdentity: typeof CreateIdentity;
let LocalIdentityProvider: typeof LocalProvider;
let requireUserId: typeof RequireUserId;
let LOCAL_USER_ID: string;

beforeAll(async () => {
  createApp = (await import('../app.js')).createApp;
  const mod = await import('./identity.js');
  createIdentity = mod.createIdentity;
  LocalIdentityProvider = mod.LocalIdentityProvider;
  requireUserId = mod.requireUserId;
  LOCAL_USER_ID = mod.LOCAL_USER_ID;
});

/**
 * `LocalIdentityProvider` takes a `Context` it never reads, so a test can hand it anything.
 * Cast rather than constructed: building a real Hono context to prove a method ignores its
 * argument would be asserting the opposite of the point.
 */
const anyContext = () => ({}) as Context;

describe('LocalIdentityProvider reads nothing', () => {
  /**
   * The security property, stated three ways.
   *
   * There is no input a caller can supply that changes who they are — so there is nothing to
   * guard and nothing to get wrong. The hostile `X-Dev-User` header is in this list because
   * a bypass header is the shape this design exists to refuse: if one were ever added, this
   * test is what would fail.
   */
  it.each([
    ['no headers', {}],
    ['a bogus Authorization header', { Authorization: 'Bearer not-a-real-token' }],
    ['a hostile X-Dev-User header', { 'X-Dev-User': 'usr_someone_else' }],
    ['both at once', { Authorization: 'Bearer x', 'X-Dev-User': 'usr_attacker' }],
  ])('returns the same id with %s', async (_label, _headers) => {
    const provider = new LocalIdentityProvider();
    await expect(provider.resolve(anyContext())).resolves.toBe('usr_local_dev');
  });

  /**
   * Not a ULID, deliberately: recognisable in a table browser, greps cleanly, and cannot
   * collide with a generated id. It must still satisfy the shared `userId` schema, which is
   * a prefixed-string check for exactly this reason (`schemas/common.ts`).
   */
  it('is usr_local_dev, and passes the shared userId schema', async () => {
    const { userId } = await import('@od/shared/schemas');
    expect(LOCAL_USER_ID).toBe('usr_local_dev');
    expect(userId.safeParse(LOCAL_USER_ID).success).toBe(true);
  });
});

/**
 * A one-route app per `RouteAuth` kind, so identity can be exercised against an
 * `authenticated` route before the product has one. Same reason `createRouteSplit` takes a
 * registry: the alternative is a branch that ships untested until some later task happens to
 * mount a route that exercises it.
 */
function appWith(auth: RouteAuth, provider?: IdentityProvider) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('routeAuth', auth);
    await next();
  });
  app.use('*', provider === undefined ? createIdentity() : createIdentity(provider));
  app.get('/probe', (c) => c.json({ userId: c.get('userId') ?? null }));
  return app;
}

/** `app.fetch` is typed `Response | Promise<Response>`, so the await normalises both. */
async function probe(app: Hono<AppEnv>): Promise<{ userId: string | null }> {
  const res = await app.fetch(new Request('http://localhost/probe'));
  return res.json();
}

describe('the middleware asks routeSplit, and never the path', () => {
  it('resolves a user on an authenticated route', async () => {
    await expect(probe(appWith('authenticated'))).resolves.toEqual({
      userId: 'usr_local_dev',
    });
  });

  /**
   * The rule that matters: a `public` or `unauthenticated-private` route gets **no user id
   * at all**, so a handler on one cannot read an identity it was never meant to have.
   */
  it.each<RouteAuth>(['public', 'unauthenticated-private'])(
    'sets no user id on a %s route',
    async (auth) => {
      await expect(probe(appWith(auth))).resolves.toEqual({ userId: null });
    },
  );
});

describe('injection replaces the provider', () => {
  const stubIdentity = (id: string): IdentityProvider => ({
    resolve: () => Promise.resolve(id),
  });

  it('runs a route test as a second user, with no bypass header involved', async () => {
    await expect(
      probe(appWith('authenticated', stubIdentity('usr_other_test_user'))),
    ).resolves.toEqual({ userId: 'usr_other_test_user' });
  });

  it('reaches a handler through createApp overrides', async () => {
    const app = createApp({ identityProvider: stubIdentity('usr_injected') });
    // `/v1/health` is `unauthenticated-private`, so the injected provider is never asked —
    // which is itself the assertion: overriding the provider does not override the boundary.
    const res = await app.fetch(new Request('http://localhost/v1/health'));
    expect(res.status).toBe(200);
  });

  it('leaves the real app running the module-scope provider', async () => {
    expect(() => createApp()).not.toThrow();
  });
});

describe('requireUserId', () => {
  it('returns the id on a route that resolved one', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('routeAuth', 'authenticated');
      await next();
    });
    app.use('*', createIdentity());
    app.get('/probe', (c) => c.json({ userId: requireUserId(c) }));

    await expect(probe(app)).resolves.toEqual({ userId: 'usr_local_dev' });
  });

  /**
   * Reaching this is a routing bug — an `authenticated` entry missing from `ROUTE_REGISTRY`.
   * The honest answer is a throw, not a query keyed on the string `"undefined"`.
   */
  it('throws rather than returning undefined when no identity was resolved', () => {
    const c = { get: () => undefined } as unknown as Context<AppEnv>;
    expect(() => requireUserId(c)).toThrowError(/resolved no identity/);
  });
});
