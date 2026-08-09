import type { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app-env.js';
import { AppError } from '../lib/errors.js';
import { ROUTE_REGISTRY, type RouteEntry } from './routeRegistry.js';

/**
 * Chain entry 7. The single place the public/private boundary is decided
 * (`tech-stack.md` §4.2, `auth.md` §7, `phase-01-activity-core.md` P1-30).
 *
 * Phase 0 shipped this file as a hard-coded set of the one path that existed. That shape
 * could not survive Phase 1: an exact-match `Set` cannot express `/v1/activities/:id`, so
 * every parameterised route would have been unreachable by construction rather than merely
 * unregistered. P1-30 replaced it with `routeRegistry.ts`, before the first Phase 1 route
 * was written.
 *
 * The registry is a separate module because this one imports `AppEnv` and `app-env.ts`
 * imports `RouteAuth` — see the note at the top of `routeRegistry.ts`. **Adding a route
 * means editing that file, not this one.** Nothing here changes as routes are added.
 *
 * ## What this middleware does, and what it deliberately does not
 *
 * It answers **one question per route: does this request need an identity?** It sets the
 * answer on the context as `routeAuth` and calls `next()`. It does not authenticate, does
 * not authorise, does not dispatch, and does not rewrite. The `identity` middleware at
 * position 8 reads `routeAuth` and is the only thing that resolves a user
 * (`phase-01-activity-core.md` P1-01).
 *
 * ## Why it matches on Hono's resolved route and not on the raw path
 *
 * Hono has already matched the request by the time this runs, so the pattern it resolved is
 * available on the context. Re-deriving it here — a regex, a prefix table, a hand-rolled
 * segment walk — would be a second router, and two routers in one process eventually
 * disagree about a trailing slash or a URL-encoded segment. The disagreement is silent and
 * lands on the security boundary, which is the worst place available for it.
 *
 * `c.req.routePath` is **not** that value: inside a middleware registered at `'*'` it
 * returns `'/*'`, the middleware's own registration. Verified, not assumed.
 * `c.req.matchedRoutes` carries the full match — every middleware registration plus the
 * resolved handler — and the handler's `path` is the pattern this file needs.
 */

const PUBLIC_PREFIX = '/public/v1/';
const PRIVATE_PREFIX = '/v1/';

/**
 * How Hono records a middleware registration in `app.routes` and `c.req.matchedRoutes`.
 *
 * `app.use(...)` always registers as `ALL`; `app.get/post/patch/put/delete` register the
 * concrete verb. No row in `api-contract.md` §2 is `ALL`, so the method is a sound
 * discriminator — and it stays sound when a later task registers path-scoped middleware
 * (`app.use('/v1/activities/*', …)`), which a path-shape check would misread as a route.
 */
const MIDDLEWARE_METHOD = 'ALL';

const registryKey = (method: string, pattern: string) => `${method} ${pattern}`;

const indexRegistry = (registry: readonly RouteEntry[]) =>
  new Map(registry.map((entry) => [registryKey(entry.method, entry.pattern), entry]));

/**
 * The route Hono resolved for this request, or `undefined` when nothing handled it.
 *
 * `matchedRoutes` lists the middleware registrations too — this picks the one real handler
 * out of them. A method mismatch (`POST` to a `GET`-only path) resolves to nothing, which
 * is the same answer as a path that is not mounted at all; Hono does not distinguish the
 * two and this file does not invent a distinction it cannot support.
 */
function resolvedRoute(matched: readonly { method: string; path: string }[] | undefined) {
  return matched?.find((route) => route.method !== MIDDLEWARE_METHOD);
}

/**
 * Built from a registry rather than closing over the module constant, so a test can mount a
 * route of each {@link RouteAuth} kind without waiting for one to exist in the product. The
 * same reason `createApp` takes overrides: the alternative is a branch that ships untested
 * until the first route that happens to exercise it.
 *
 * Production has exactly one instance, {@link routeSplit}, over {@link ROUTE_REGISTRY}.
 */
export function createRouteSplit(registry: readonly RouteEntry[] = ROUTE_REGISTRY) {
  const byKey = indexRegistry(registry);

  return createMiddleware<AppEnv>(async (c, next) => {
    const path = c.req.path;

    // Public routes are decided by prefix, not by a registry lookup: the prefix *is* the
    // contract (`api-contract.md` §1), and a public route that fell out of the registry
    // must not silently become authenticated.
    if (path.startsWith(PUBLIC_PREFIX)) {
      c.set('routeAuth', 'public');
      await next();
      return;
    }

    const route = resolvedRoute(c.req.matchedRoutes);

    if (route !== undefined) {
      const entry = byKey.get(registryKey(route.method, route.path));
      // `assertRegistryMatchesRoutes` makes the missing case unreachable in the real app.
      // It still fails **closed**, because the cost of being wrong here is a route served
      // with no identity — the one outcome this file exists to prevent.
      c.set('routeAuth', entry?.auth ?? 'authenticated');
      await next();
      return;
    }

    // Nothing handled it. A path under a known prefix is in the contract but not in this
    // build; anything else does not exist. `not_implemented` for the first is more honest
    // than pretending it never existed, and `not_found` — never `401` — for the second is
    // what stops an unauthenticated caller enumerating the API.
    if (path.startsWith(PRIVATE_PREFIX)) {
      throw new AppError(
        'not_implemented',
        'This endpoint is not available in this build.',
      );
    }

    throw new AppError('not_found', 'Not found.');
  });
}

export const routeSplit = createRouteSplit();

/**
 * Fails app construction when the registry and the mounted routes disagree, in either
 * direction, naming every offender.
 *
 * This is the mechanism that makes "registering a route is part of adding one" true rather
 * than aspirational. It runs at construction — the same throw-at-startup shape as the
 * `AUTH_MODE` guard in `lib/config.ts` — so a missing line cannot reach a deployed
 * environment, cannot be argued with, and shows up in the first test that builds an app
 * rather than in a Playwright run three tasks later.
 *
 * Both directions matter. A **mounted route with no entry** would be served with whatever
 * the fallback decided, which is a security question nobody chose the answer to. A **stale
 * entry with no route** is a claim about a boundary that no longer exists, and it is how
 * this file starts describing an API that has moved on.
 */
export function assertRegistryMatchesRoutes(
  app: Hono<AppEnv>,
  registry: readonly RouteEntry[] = ROUTE_REGISTRY,
): void {
  const mounted = app.routes
    .filter((route) => route.method !== MIDDLEWARE_METHOD)
    .map((route) => registryKey(route.method, route.path));

  const mountedSet = new Set(mounted);
  const registered = new Set(indexRegistry(registry).keys());

  const unregistered = [...mountedSet].filter((key) => !registered.has(key)).sort();
  const stale = [...registered].filter((key) => !mountedSet.has(key)).sort();

  if (unregistered.length === 0 && stale.length === 0) return;

  const problems = [
    unregistered.length > 0
      ? `mounted but missing from ROUTE_REGISTRY: ${unregistered.join(', ')}`
      : undefined,
    stale.length > 0
      ? `in ROUTE_REGISTRY but not mounted: ${stale.join(', ')}`
      : undefined,
  ].filter((line): line is string => line !== undefined);

  throw new Error(
    `routeSplit's registry does not match the mounted routes — ${problems.join('; ')}. ` +
      'Every route states whether it needs an identity, in the same pull request that ' +
      'mounts it (services/api/src/middleware/routeSplit.ts).',
  );
}
