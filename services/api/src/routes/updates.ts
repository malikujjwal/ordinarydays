import { zValidator } from '@hono/zod-validator';
import { postActivityUpdateInput } from '@od/shared/schemas';
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import {
  deleteUpdateHandler,
  listUpdatesHandler,
  postUpdateHandler,
  UPDATE_PATH,
  UPDATES_PATH,
} from '../handlers/updates.js';

/**
 * The plan's activity feed, mounted under `/v1/activities` (`api-contract.md` §2.5, P3-19).
 *
 * Its own router rather than three more routes in `activities.ts`, because the feed is a
 * sub-resource with its own service and its own paging rule; the mount point is what keeps the
 * paths in the contract's shape.
 *
 * Every entry is registered in `ROUTE_REGISTRY`; app construction throws otherwise. Only the
 * `POST` mutates, so only it takes an `Idempotency-Key`.
 */

/**
 * The **strict** post body, with the explicit failure hook `me.ts` records: `zValidator`'s
 * default answers with its own shape, which is not the contract envelope and never reaches
 * `errorHandler`, so a client would get a `400` with no `error.code` and no `requestId`.
 *
 * Strictness is the endpoint's promise. `kind`, `authorUserId` and `createdAt` are
 * server-authored, and a permissive body would drop them silently — letting a caller believe
 * it had posted a system entry, attributed a note to someone else, or backdated a row into the
 * middle of a feed that sorts on exactly that field.
 */
const validatePost = zValidator('json', postActivityUpdateInput, (result) => {
  if (!result.success) throw result.error;
});

export const updates = new Hono<AppEnv>()
  .get(UPDATES_PATH, listUpdatesHandler)
  .post(UPDATES_PATH, validatePost, (c) =>
    /**
     * `new Date()` at the edge, as `activities.ts` does: `coding-standards.md` §4.3 bans an
     * implicit clock inside anything that has to be testable, so the route reads the real one
     * and hands it down as a value. Here it is load-bearing twice over — it becomes both the
     * entry's `createdAt` and the seed its id is minted from, and those two must agree.
     */
    postUpdateHandler(c, c.req.valid('json'), new Date().toISOString()),
  )
  /**
   * The ids are not validated against their ULID schemas, for the reason `activities.ts`
   * records: a malformed id resolves to no row and already answers `404`, and checking first
   * would split one user-visible fact — "there is no such entry for you" — into two statuses.
   */
  .delete(UPDATE_PATH, deleteUpdateHandler);
