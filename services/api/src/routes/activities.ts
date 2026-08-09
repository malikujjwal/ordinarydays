import { zValidator } from '@hono/zod-validator';
import { createActivityInput, patchActivityInput } from '@od/shared/schemas';
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import { createActivityHandler } from '../handlers/createActivity.js';
import {
  DELETE_ACTIVITY_PATH,
  deleteActivityHandler,
} from '../handlers/deleteActivity.js';
import {
  DUPLICATE_ACTIVITY_PATH,
  duplicateActivityHandler,
} from '../handlers/duplicateActivity.js';
import { GET_ACTIVITY_PATH, getActivityHandler } from '../handlers/getActivity.js';
import { PATCH_ACTIVITY_PATH, patchActivityHandler } from '../handlers/patchActivity.js';

/**
 * `/v1/activities` (`api-contract.md` §2.3).
 *
 * Five routes in this phase: the create (P1-11), the detail read (P1-12), the partial update
 * (P1-13), the delete (P1-14) and the duplicate (P1-15). The list
 * query is P1-16; the scheduling, completion and occurrence routes are Phase 2. Each is
 * absent rather than stubbed, so `routeSplit`'s `not_implemented` answers for it — the honest
 * response for a path that is in the contract but not in this build.
 *
 * Every entry is registered in `ROUTE_REGISTRY`; app construction throws otherwise (P1-30).
 * Only the `POST` `creates`, so only it takes an `Idempotency-Key` — `PATCH` is guarded by
 * `If-Match` instead, which is a stronger promise: a retry of the *same* edit succeeds once
 * and then `409`s, rather than being replayed from a stored response.
 */

/**
 * `zValidator` with an explicit failure hook that **throws**, for the reason `me.ts` records:
 * its default is to answer with its own body, which is not the contract envelope and never
 * reaches `errorHandler`, so a client would get a `400` with no `error.code` and no
 * `requestId`.
 *
 * **This is the line that enforces explicit intent on the wire.** `createActivityInput` is a
 * discriminated union on `objectKind` with `strictObject` arms, so three different mistakes
 * all become a `400` naming the field rather than a save that quietly did something else:
 * a body with no target at all, a body with half a target, and a Task carrying participants.
 * Nothing downstream has to defend against any of them (`CLAUDE.md` rule 2).
 *
 * It is also what refuses `listId`, `listItemId` and `fromListItem` on this endpoint: they
 * are not in the schema, and only `POST /v1/lists/:id/items/:itemId/schedule` may establish
 * that relationship, after list access has been checked (`api-contract.md` §2.3).
 */
const validateCreate = zValidator('json', createActivityInput, (result) => {
  if (!result.success) throw result.error;
});

/**
 * Same hook, same reason. The patch schema is **strict** and validates `objectKind` and
 * `type` as a pair, so `objectKind` alone is a `400` naming it rather than a server that
 * picks a type — the rule stated in `api-contract.md` §2.3 and enforced here rather than
 * downstream.
 */
const validatePatch = zValidator('json', patchActivityInput, (result) => {
  if (!result.success) throw result.error;
});

export const activities = new Hono<AppEnv>()
  .post('/', validateCreate, (c) =>
    /**
     * `new Date()` at the edge. `coding-standards.md` §4.3 bans implicit-now inside pure
     * logic and anything that has to be testable; the route is the boundary, so this is
     * where the real clock is read and handed down as a value.
     */
    createActivityHandler(c, c.req.valid('json'), new Date().toISOString()),
  )
  /**
   * The path parameter is not validated against the `act_` ULID schema, for the reason
   * `deleteDevice` records: a malformed id resolves to no activity and already answers
   * `404`, and checking it first would turn one user-visible fact — "there is no such
   * activity for you" — into two different statuses.
   */
  .get(GET_ACTIVITY_PATH, getActivityHandler)
  .patch(PATCH_ACTIVITY_PATH, validatePatch, (c) =>
    patchActivityHandler(c, c.req.valid('json'), new Date().toISOString()),
  )
  /**
   * No `If-Match`. A delete is not an edit racing another edit: the thing either exists and
   * goes, or it does not and the answer is `404`. Requiring a version would make a retry of a
   * delete that half-succeeded fail on a row that is already gone, which is the opposite of
   * the idempotence P1-14 asks for.
   */
  .delete(DELETE_ACTIVITY_PATH, deleteActivityHandler)
  /**
   * Mounted after `/:id`, and the order does not matter to Hono — `/:id/duplicate` has more
   * segments, so it cannot be shadowed by the bare `/:id` routes above. Kept last to match
   * the order `api-contract.md` §2.3 lists them in.
   */
  .post(DUPLICATE_ACTIVITY_PATH, duplicateActivityHandler);
