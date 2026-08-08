import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app-env.js';

/** Bounded so a hostile header cannot bloat every log line it appears in. */
const MAX_INBOUND_LENGTH = 128;
const SAFE = /^[A-Za-z0-9_.:-]+$/;

/**
 * Chain entry 1. Reads `X-Request-Id` or generates one, puts it on the context and echoes
 * it on the response.
 *
 * First, because everything downstream logs it — including failures inside later
 * middleware. An inbound value is honoured so a client can correlate a retry with its
 * original, but it is validated first: it is echoed back in a header and written into every
 * log line, so an unbounded or control-character value is a log-injection vector.
 */
/**
 * Exported so it can be tested directly. It has to be: a header value containing a newline
 * cannot be put on a `Request` at all — `undici` rejects it — so the through-the-app test
 * would only prove that `undici` validates headers. Under the Lambda adapter the headers
 * come from an API Gateway event rather than from `undici`, which is exactly where this
 * check earns its place.
 */
export function resolveRequestId(inbound: string | undefined): string {
  if (
    inbound !== undefined &&
    inbound.length > 0 &&
    inbound.length <= MAX_INBOUND_LENGTH &&
    SAFE.test(inbound)
  ) {
    return inbound;
  }
  return `req_${randomUUID().replaceAll('-', '')}`;
}

export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const id = resolveRequestId(c.req.header('X-Request-Id'));

  c.set('requestId', id);
  c.header('X-Request-Id', id);
  await next();
});
