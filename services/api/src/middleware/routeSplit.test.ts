import { type Context, Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * `config` parses `process.env` at module load, so the environment is set before `app.ts` is
 * imported — same reason and same shape as `app.test.ts`.
 */
process.env.STAGE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';

import type { createApp as CreateApp } from '../app.js';
import type { AppEnv } from '../app-env.js';
import type {
  assertRegistryMatchesRoutes as Assert,
  createRouteSplit as CreateRouteSplit,
} from './routeSplit.js';

let createApp: typeof CreateApp;
let assertRegistryMatchesRoutes: typeof Assert;
let createRouteSplit: typeof CreateRouteSplit;

beforeAll(async () => {
  createApp = (await import('../app.js')).createApp;
  const mod = await import('./routeSplit.js');
  assertRegistryMatchesRoutes = mod.assertRegistryMatchesRoutes;
  createRouteSplit = mod.createRouteSplit;
});

const req = (path: string, init?: RequestInit) =>
  createApp().fetch(new Request(`http://localhost${path}`, init));

/**
 * The test this task exists for.
 *
 * A route mounted without its registry line is a route whose auth requirement nobody
 * declared. Left to a runtime fallback it is either a silent `501` found three tasks later
 * or — the outcome that matters — an endpoint served with no identity. This walks Hono's own
 * route table, so it cannot drift from what is actually mounted.
 */
describe('the registry covers the route table', () => {
  it('accepts the real app: every mounted route declares its auth', () => {
    expect(() => createApp()).not.toThrow();
  });

  // `/v1/plans` — a real contract path (§2.2a) that Phase 3 owns and nothing mounts. It was
  // `/v1/agenda` until P2-11 mounted and registered that, at which point this stopped
  // throwing and the assertion was about nothing.
  it('rejects a route that was mounted without a registry line, naming it', () => {
    const app = createApp();
    app.get('/v1/plans', (c) => c.json({ data: null }));

    expect(() => assertRegistryMatchesRoutes(app)).toThrowError(
      /mounted but missing from ROUTE_REGISTRY: GET \/v1\/plans/,
    );
  });

  it('rejects a stale registry line whose route is gone, naming it', () => {
    // A bare app with none of the real routes: every registry entry is therefore stale,
    // which is the shape of deleting a route and leaving its line behind.
    const empty = new Hono<AppEnv>();

    expect(() => assertRegistryMatchesRoutes(empty)).toThrowError(
      // `.*` between the label and the route, deliberately. The behaviour is that a stale
      // entry is *named*; that `GET /v1/health` happened to sort first was incidental, and
      // pinning it made this test fail the moment P1-08 registered a route that sorts ahead
      // of it — which is every route task, eventually, for a reason unrelated to what this
      // asserts.
      /in ROUTE_REGISTRY but not mounted:.*GET \/v1\/health/,
    );
  });

  it('names the file to fix in the message, not just the offending route', () => {
    const app = createApp();
    app.post('/v1/lists', (c) => c.json({ data: null }));

    expect(() => assertRegistryMatchesRoutes(app)).toThrowError(
      /services\/api\/src\/middleware\/routeSplit\.ts/,
    );
  });
});

/**
 * `routeAuth` is the whole output of this middleware — the flag `identity` (P1-01) reads to
 * decide whether to resolve a user. It is asserted against a purpose-built registry rather
 * than through `createApp`, for two reasons: the real registry has no `authenticated` route
 * until P1-07, and a middleware registered onto an already-built app composes *after* the
 * route handler, so it never observes the value.
 */
describe('routeAuth', () => {
  const probe = (registry: Parameters<typeof createRouteSplit>[0]) => {
    const app = new Hono<AppEnv>();
    app.use('*', createRouteSplit(registry));
    const echo = (c: Context<AppEnv>) => c.json({ routeAuth: c.get('routeAuth') });
    app.get('/v1/health', echo);
    app.get('/v1/activities/:id', echo);
    app.get('/public/v1/invites/:token', echo);
    return app;
  };

  const authOf = async (app: Hono<AppEnv>, path: string): Promise<string> => {
    const res = await app.fetch(new Request(`http://localhost${path}`));
    return ((await res.json()) as { routeAuth: string }).routeAuth;
  };

  it('marks /v1/health unauthenticated-private, so identity will skip it', async () => {
    const app = probe([
      { method: 'GET', pattern: '/v1/health', auth: 'unauthenticated-private' },
      { method: 'GET', pattern: '/v1/activities/:id', auth: 'authenticated' },
    ]);
    expect(await authOf(app, '/v1/health')).toBe('unauthenticated-private');
  });

  it('marks a registered private route authenticated, on its pattern not its path', async () => {
    const app = probe([
      { method: 'GET', pattern: '/v1/health', auth: 'unauthenticated-private' },
      { method: 'GET', pattern: '/v1/activities/:id', auth: 'authenticated' },
    ]);
    expect(await authOf(app, '/v1/activities/act_01J8XKQ2M4N5P6R7S8T9V0W1X2')).toBe(
      'authenticated',
    );
  });

  it('marks anything under /public/v1/ public without consulting the registry', async () => {
    const app = probe([]);
    expect(await authOf(app, '/public/v1/invites/tok_abc')).toBe('public');
  });

  /**
   * The construction-time guard makes this unreachable in the real app. It is asserted
   * anyway: if that guard is ever weakened, the fallback is the last thing standing between
   * a forgotten registry line and an endpoint served with no identity, and "fails closed" is
   * only true if something checks.
   */
  it('fails closed — an unregistered route is authenticated, never public', async () => {
    const app = probe([]);
    expect(await authOf(app, '/v1/activities/act_01J8XKQ2M4N5P6R7S8T9V0W1X2')).toBe(
      'authenticated',
    );
  });

  it('answers the real /v1/health with no credentials of any kind', async () => {
    const res = await req('/v1/health');
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe('ok');
  });

  /**
   * The case an exact-match `Set` cannot express, and the reason this task exists. The route
   * is a scratch mount rather than a real one because no parameterised route is built yet —
   * what is under test is that the registry matches on the **pattern Hono resolved** and
   * that the concrete id still binds.
   */
  it('matches a parameterised route on its pattern and binds the param', async () => {
    const app = new Hono<AppEnv>();
    let pattern: string | undefined;
    app.use('*', async (c, next) => {
      pattern = c.req.matchedRoutes?.find((r) => r.method !== 'ALL')?.path;
      await next();
    });
    app.get('/v1/activities/:id', (c) => c.json({ id: c.req.param('id') }));

    const res = await app.fetch(
      new Request('http://localhost/v1/activities/act_01J8XKQ2M4N5P6R7S8T9V0W1X2'),
    );

    expect(pattern).toBe('/v1/activities/:id');
    expect((await res.json()).id).toBe('act_01J8XKQ2M4N5P6R7S8T9V0W1X2');
  });
});

describe('the public/private boundary', () => {
  it('returns 404 — never 401 — for an unknown prefix, so the API cannot be enumerated', async () => {
    const res = await req('/nope');
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('returns 501 for a contract path this build has not mounted', async () => {
    const res = await req('/v1/plans');
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe('not_implemented');
  });

  /**
   * A public route is decided by prefix, not by a registry lookup. Nothing is mounted under
   * `/public/v1/` until Phase 6, so this asserts the branch is taken — the request reaches
   * routing rather than being rejected at the boundary, and comes back as Hono's own
   * not-found rather than as `not_implemented`.
   */
  it('lets /public/v1/* through the boundary without a registry entry', async () => {
    const res = await req('/public/v1/invites/tok_abc');
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });
});
