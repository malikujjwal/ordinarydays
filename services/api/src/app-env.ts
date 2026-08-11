import type { Logger } from './lib/logger.js';
import type { RouteAuth } from './middleware/routeRegistry.js';

/**
 * The typed context every middleware and handler shares.
 *
 * `userId` is set by the `identity` middleware at position 8 (P1-01), and **only on routes
 * whose `routeAuth` is `authenticated`**. It stays optional for that reason: a `public` or
 * `unauthenticated-private` route genuinely has no user, so a handler that reads it directly
 * is a type error rather than an `undefined` that silently becomes a key. Handlers that need
 * it call `requireUserId(c)` from `middleware/identity.ts`, which throws instead.
 */
export interface AppEnv {
  Variables: {
    requestId: string;
    logger: Logger;
    /**
     * Set by `routeSplit` (position 7) for every request that reaches a route, and read by
     * `identity` (position 8) to decide whether to resolve a user.
     *
     * Not optional: `routeSplit` sets it on every path it lets through, and a route that
     * reached `identity` without one would be a route whose auth requirement nobody
     * declared. Typing it as required is what makes that a compile error rather than a
     * silently unauthenticated endpoint.
     */
    routeAuth: RouteAuth;
    userId?: string;
    /** Set by idempotency before a mutating POST reaches its handler. */
    idempotencyKey?: string;
    idempotencyRoute?: string;
    idempotencyNowMs?: number;
  };
}
