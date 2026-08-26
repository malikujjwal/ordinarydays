import { zValidator } from '@hono/zod-validator';
import { plansQuery } from '@od/shared/schemas';
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import { getPlansHandler, PLANS_PATH } from '../handlers/plans.js';

/**
 * `/v1/plans` — the Plans tab (`api-contract.md` §2.2a, §P3-20).
 *
 * One route, four modes. Registered in `ROUTE_REGISTRY`; app construction throws otherwise.
 * Nothing here mutates, so no `Idempotency-Key` and — deliberately — **no `ETag`**: the
 * contract specifies no conditional-request behaviour for this endpoint, and adding caching
 * nobody asked for would make a stage's freshness a property of a header rather than of the
 * read. Said out loud because the helper exists and reaching for it would look like diligence.
 */

/**
 * The **strict discriminated union** on `mode`, with the explicit failure hook `me.ts`
 * records: `zValidator`'s default answers in its own shape, which is not the contract envelope
 * and never reaches `errorHandler`, so a client would get a `400` with no `error.code`.
 *
 * Strictness is the whole point of the union. A `past_window` parameter sent with
 * `mode=upcoming_window` is a named `400`, not a silently ignored field that launches streams
 * the caller never asked for and pays for three stages while scrolling one.
 */
const validateQuery = zValidator('query', plansQuery, (result) => {
  if (!result.success) throw result.error;
});

export const plans = new Hono<AppEnv>().get(PLANS_PATH, validateQuery, (c) =>
  /**
   * `new Date()` at the edge, as `activities.ts` does: `coding-standards.md` §4.3 keeps the
   * implicit clock out of anything that has to be testable, so the route reads the real one
   * and hands it down. Here it decides the viewer's today, which is the boundary between two
   * of the three stages.
   */
  getPlansHandler(c, c.req.valid('query'), new Date().toISOString()),
);
