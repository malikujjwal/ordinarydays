import type { Logger } from './lib/logger.js';

/**
 * The typed context every middleware and handler shares.
 *
 * `userId` is declared here but is **not set by anything in Phase 0** — the `identity`
 * middleware is Phase 1 (P1-01). It is typed as optional so that a handler reading it
 * before that middleware exists is a type error rather than an `undefined` that silently
 * becomes a key.
 */
export interface AppEnv {
  Variables: {
    requestId: string;
    logger: Logger;
    userId?: string;
  };
}
