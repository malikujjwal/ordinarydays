import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app-env.js';
import { markWarm, readColdStart } from '../lib/coldStart.js';
import { logger as rootLogger } from '../lib/logger.js';

/**
 * Chain entry 2. Binds a child logger to the request and logs one line on completion.
 *
 * Wraps everything so the recorded duration includes all downstream work, including time
 * spent in middleware that later throws. It sits *after* `requestId` because the child
 * logger is bound to it, and *before* `errorHandler` so a handled error is still timed.
 *
 * One line per request, not one on entry and one on exit: two lines double the CloudWatch
 * ingestion bill for the same information, and the 5 GB/month free allowance is the whole
 * logging budget (`cost-model.md` §2.12).
 */
export const requestLogger = createMiddleware<AppEnv>(async (c, next) => {
  const child = rootLogger.child({ requestId: c.get('requestId') });
  c.set('logger', child);

  const startedAt = Date.now();
  const coldStart = readColdStart();
  try {
    await next();
  } finally {
    const durationMs = Date.now() - startedAt;
    const status = c.res.status;
    const matched = c.req.matchedRoutes?.find((route) => route.method !== 'ALL');
    // The path, never the URL: a query string can carry user content, and `req.headers` is
    // in the redaction list precisely because it carries the bearer token. `route` is the
    // canonical Hono pattern when one resolved; otherwise method + path still names the call.
    const line = {
      method: c.req.method,
      path: c.req.path,
      route:
        matched === undefined
          ? `${c.req.method} ${c.req.path}`
          : `${matched.method} ${matched.path}`,
      status,
      durationMs,
      coldStart,
      userId: c.get('userId'),
    };
    if (status >= 500) child.error(line, 'request failed');
    else if (status >= 400) child.warn(line, 'request rejected');
    else child.info(line, 'request completed');
    markWarm();
  }
});
