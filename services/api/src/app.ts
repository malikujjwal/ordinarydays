import { Hono } from 'hono';
import type { AppEnv } from './app-env.js';
import { AppError } from './lib/errors.js';
import { bodyLimitMiddleware } from './middleware/bodyLimit.js';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler } from './middleware/errorHandler.js';
import { idempotency } from './middleware/idempotency.js';
import {
  createIdentity,
  type IdentityProvider,
  identity,
} from './middleware/identity.js';
import { requestLogger } from './middleware/logger.js';
import { rateLimit } from './middleware/rateLimit.js';
import { requestId } from './middleware/requestId.js';
import { assertRegistryMatchesRoutes, routeSplit } from './middleware/routeSplit.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { health } from './routes/health.js';
import { me } from './routes/me.js';

/**
 * Builds the Hono app.
 *
 * A **function**, not a module-scope `app` constant, so a test gets a fresh instance and so
 * Phase 1 can inject a stub identity provider through `overrides` — rather than shipping a
 * bypass header that exists in production code and is one misconfiguration away from being
 * usable (P0-13, P1-01). Both `index.ts` and `local.ts` call it with no arguments.
 *
 * ## The chain, in order (`tech-stack.md` §4.2)
 *
 * Order is load-bearing, and each position is a decision:
 *
 * 1. `requestId`      — everything downstream logs it, including later failures
 * 2. `requestLogger`  — wraps everything, so the duration covers all work
 * 3. `errorHandler`   — registered as `onError`, so it catches throws from 4–12 too
 * 4. `cors`           — answers `OPTIONS` before anything can reject it
 * 5. `securityHeaders`— applies to every response, errors included
 * 6. `bodyLimit`      — before parsing, so a large body is never buffered
 * 7. `routeSplit`     — the one place public/private is decided
 *
 * 8. `identity`       — resolves the user for `authenticated` routes, and only those
 * 9. `rateLimit`      — the per-user fixed-window counter, on `authenticated` routes
 * 10. `idempotency`   — replays a stored response on creating `POST`s, after rate limiting
 *                       so a retry storm cannot write idempotency records for free
 */
export interface AppOverrides {
  /**
   * The identity provider this app runs (P1-01).
   *
   * **This is why there is no `X-Dev-User` header.** A route test that needs a second user
   * constructs an app with a stub — `createApp({ identityProvider: stubIdentity('usr_other') })`
   * — which gives tests the same capability with nothing in the production bundle to guard.
   * A header-driven bypass is shipped code that reads attacker-controlled input to decide who
   * you are, protected only by an environment check that one misconfiguration removes.
   *
   * Absent means the module-scope provider selected by `AUTH_MODE`, which is what both
   * `index.ts` and `local.ts` get by calling this with no arguments.
   */
  readonly identityProvider?: IdentityProvider;
}

export function createApp(overrides: AppOverrides = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  app.use('*', requestId);
  app.use('*', requestLogger);
  app.use('*', corsMiddleware);
  app.use('*', securityHeaders);
  app.use('*', bodyLimitMiddleware);
  app.use('*', routeSplit);
  // Position 8. After `routeSplit`, because it asks that middleware whether this route needs
  // an identity rather than deciding for itself; before anything that reads user data.
  app.use(
    '*',
    overrides.identityProvider === undefined
      ? identity
      : createIdentity(overrides.identityProvider),
  );
  // Position 9. After `identity`, because an authenticated route's counter is keyed on the
  // user it just resolved. It limits `authenticated` routes only, so `/v1/health` — which
  // every smoke test and alarm calls — reaches its handler without touching DynamoDB.
  app.use('*', rateLimit);
  // Position 10. After `rateLimit` by design, and it acts only on routes whose registry
  // entry says they create — so nothing in Phase 1 reaches its DynamoDB calls.
  app.use('*', idempotency);

  app.route('/v1/me', me);
  app.route('/v1/health', health);

  // Anything reaching here matched no route. `routeSplit` has already rejected unknown
  // prefixes; this covers a known prefix with no handler. It goes through `errorHandler`
  // like everything else, so there is exactly one place that builds an error envelope.
  app.notFound((c) => errorHandler(new AppError('not_found', 'Not found.'), c));

  // Every mounted route must have declared whether it needs an identity, and the registry
  // must not claim routes that are gone. Asserted here, at construction, so a missing line
  // fails the first test that builds an app rather than surfacing as a 501 — or worse, as an
  // unauthenticated endpoint — long after the pull request that caused it (P1-30).
  assertRegistryMatchesRoutes(app);

  return app;
}
