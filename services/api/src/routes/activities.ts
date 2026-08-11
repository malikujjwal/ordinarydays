import { zValidator } from '@hono/zod-validator';
import {
  activityListQuery,
  createActivityInput,
  patchActivityInput,
  scheduleActivityInput,
} from '@od/shared/schemas';
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
import {
  LIST_ACTIVITIES_PATH,
  listActivitiesHandler,
} from '../handlers/listActivities.js';
import { PATCH_ACTIVITY_PATH, patchActivityHandler } from '../handlers/patchActivity.js';
import {
  SCHEDULE_ACTIVITY_PATH,
  scheduleActivityHandler,
} from '../handlers/scheduleActivity.js';

/**
 * `/v1/activities` (`api-contract.md` §2.3).
 *
 * Seven routes: the complete Phase 1 activity surface plus P2-12's sole schedule write path.
 * The flat list (P1-16), create (P1-11), detail read (P1-12), partial update (P1-13), delete
 * (P1-14), duplicate (P1-15), and schedule/reschedule/unschedule (P2-12) live here.
 * Completion and the remaining occurrence routes are Phase 2, and the agenda that powers
 * Today is its own endpoint. Each is
 * absent rather than stubbed, so `routeSplit`'s `not_implemented` answers for it — the honest
 * response for a path that is in the contract but not in this build.
 *
 * Every entry is registered in `ROUTE_REGISTRY`; app construction throws otherwise (P1-30).
 * Both creating and scheduling POSTs take an `Idempotency-Key`; `PATCH` is guarded by
 * `If-Match` instead.
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

const validateSchedule = zValidator('json', scheduleActivityInput, (result) => {
  if (!result.success) throw result.error;
});

/**
 * Same hook, on the **query string** rather than the body.
 *
 * Strict, so a misspelled `filter` is a `400` naming it rather than a silent fallback to
 * whichever stage the server would have picked — and `filter` is required, because "every
 * activity, flat" is not one of the stages the product has.
 */
const validateListQuery = zValidator('query', activityListQuery, (result) => {
  if (!result.success) throw result.error;
});

export const activities = new Hono<AppEnv>()
  .get(LIST_ACTIVITIES_PATH, validateListQuery, (c) =>
    listActivitiesHandler(c, c.req.valid('query'), new Date()),
  )
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
  .post(SCHEDULE_ACTIVITY_PATH, validateSchedule, (c) =>
    scheduleActivityHandler(c, c.req.valid('json'), new Date().toISOString()),
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
