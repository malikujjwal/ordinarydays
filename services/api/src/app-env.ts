import type { Logger } from './lib/logger.js';
import type { RouteAuth } from './middleware/routeRegistry.js';

/**
 * The typed context every middleware and handler shares.
 *
 * `userId` is declared here but is **not set by anything yet** — the `identity` middleware
 * is P1-01. It is typed as optional so that a handler reading it before that middleware
 * exists is a type error rather than an `undefined` that silently becomes a key.
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
  };
}
