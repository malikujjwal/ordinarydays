import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app-env.js';
import { AppError } from '../lib/errors.js';

/**
 * Chain entry 7. The single place the public/private boundary is decided
 * (`tech-stack.md` §4.2, `auth.md` §7).
 *
 * `/public/v1/*` skips authentication. Everything else under `/v1/*` requires it. A path
 * matching neither prefix is a `404` — not a `401`, because an unrecognised path should not
 * tell an unauthenticated caller whether it exists.
 *
 * **Phase 0 has no `identity` middleware**, so nothing here authenticates anything yet. It
 * cannot: a pass-through that silently authorises every request is a worse artefact than a
 * missing file, because it looks finished. Instead this middleware refuses every private
 * route it does not explicitly know about, and P1-01 replaces that refusal with the real
 * identity check.
 *
 * `/v1/health` is the one private-prefixed route that is unauthenticated by design — it is
 * what every smoke test and alarm calls, and it must answer before anything else works.
 */
const PUBLIC_PREFIX = '/public/v1/';
const PRIVATE_PREFIX = '/v1/';

/** Unauthenticated routes under the private prefix. Exhaustive, and it stays short. */
const UNAUTHENTICATED_PRIVATE_PATHS = new Set(['/v1/health']);

/**
 * Routes that exist in Phase 0. Anything else under `/v1/` is `not_implemented` rather
 * than `not_found`: the path is in the contract, the identity middleware that would guard
 * it is not built yet, and saying so is more honest than pretending it never existed.
 */
const IMPLEMENTED_PATHS = new Set(['/v1/health']);

export const routeSplit = createMiddleware<AppEnv>(async (c, next) => {
  const path = c.req.path;

  if (path.startsWith(PUBLIC_PREFIX)) {
    await next();
    return;
  }

  if (path.startsWith(PRIVATE_PREFIX)) {
    if (IMPLEMENTED_PATHS.has(path)) {
      await next();
      return;
    }
    throw new AppError(
      'not_implemented',
      'This endpoint is not available in this build.',
    );
  }

  throw new AppError('not_found', 'Not found.');
});

export const routeSplitPaths = {
  PUBLIC_PREFIX,
  PRIVATE_PREFIX,
  UNAUTHENTICATED_PRIVATE_PATHS,
  IMPLEMENTED_PATHS,
} as const;
