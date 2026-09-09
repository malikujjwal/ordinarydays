import type { HealthData } from '@od/shared/schemas';
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import { readColdStart } from '../lib/coldStart.js';
import { config } from '../lib/config.js';

/**
 * `GET /v1/health` (`api-contract.md` §2.1a) — the endpoint every smoke test and every
 * alarm depends on, and the first thing the app renders.
 *
 * Unauthenticated by exception in `routeSplit`, which is the single place that decision is
 * made. It still runs the **whole** middleware chain: `requestId`, the logger, the error
 * handler, CORS, security headers and the body limit all apply. That is deliberate — an
 * endpoint that bypassed the chain would be testing a pipeline nothing else uses.
 *
 * **It performs no I/O.** No DynamoDB call, no S3 call, nothing. A liveness signal that
 * fails because the table is throttled is not a liveness signal; it is a second thing to
 * debug at the moment you can least afford one.
 *
 * `Cache-Control: no-store` comes from `securityHeaders` and matters here more than
 * anywhere: a cached health response makes a reload look successful when it was not.
 */

export const health = new Hono<AppEnv>().get('/', (c) => {
  const data: HealthData = {
    status: 'ok',
    sha: config.GIT_SHA,
    stage: config.STAGE,
    coldStart: readColdStart(),
  };

  // Typed against the shared schema rather than parsed against it: the compiler already
  // guarantees the shape, and this is the hottest, most latency-sensitive path in the
  // service. The round trip is checked at runtime in the tests instead, where it costs
  // nothing in production.
  return c.json({ data, meta: { requestId: c.get('requestId') } });
});
