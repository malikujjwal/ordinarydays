import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';

/**
 * `GET /v1/health` — the endpoint every smoke test and every alarm depends on, and the
 * first thing the app renders.
 *
 * **P0-13 mounts it; P0-14 fills in the payload** — `sha` from `GIT_SHA`, `stage`, and the
 * module-scope `coldStart` boolean. What is here is the minimum that makes the middleware
 * chain exercisable end to end: one route that returns the success envelope.
 *
 * It performs **no I/O**. No DynamoDB call, deliberately — a liveness signal that fails
 * because the table is throttled is not a liveness signal.
 */
export const health = new Hono<AppEnv>().get('/', (c) =>
  c.json({
    data: { status: 'ok' },
    meta: { requestId: c.get('requestId') },
  }),
);
