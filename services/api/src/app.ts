import { Hono } from 'hono';
import type { AppEnv } from './app-env.js';
import { AppError } from './lib/errors.js';
import { bodyLimitMiddleware } from './middleware/bodyLimit.js';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/logger.js';
import { requestId } from './middleware/requestId.js';
import { routeSplit } from './middleware/routeSplit.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { health } from './routes/health.js';

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
 * **8–10 (`identity`, `rateLimit`, `idempotency`) do not exist in Phase 0.** They are
 * Phase 1, and they are absent rather than stubbed: a pass-through `identity` that sets no
 * user and blocks nothing looks like an implemented control while being none.
 */
export interface AppOverrides {
  /** Reserved for P1-01's identity provider injection. Unused in Phase 0. */
  readonly _reserved?: never;
}

export function createApp(_overrides: AppOverrides = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  app.use('*', requestId);
  app.use('*', requestLogger);
  app.use('*', corsMiddleware);
  app.use('*', securityHeaders);
  app.use('*', bodyLimitMiddleware);
  app.use('*', routeSplit);

  app.route('/v1/health', health);

  // Anything reaching here matched no route. `routeSplit` has already rejected unknown
  // prefixes; this covers a known prefix with no handler. It goes through `errorHandler`
  // like everything else, so there is exactly one place that builds an error envelope.
  app.notFound((c) => errorHandler(new AppError('not_found', 'Not found.'), c));

  return app;
}
