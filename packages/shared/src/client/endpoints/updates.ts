import type { z } from 'zod';
import {
  activityUpdatePage,
  deletedActivityUpdate,
  postActivityUpdateResult,
} from '../../schemas/activityUpdate.js';
import { envelope } from '../../schemas/envelope.js';
import type { HttpClient } from '../http.js';

/**
 * The plan's activity feed (`api-contract.md` §2.5, P3-19).
 *
 * A Plan converted to a Task keeps its entries as read-only history, so `getActivityUpdates`
 * still pages them while `postActivityUpdate` is rejected server-side. The client models none
 * of that: it does not check an activity's kind before posting, because the rule belongs to
 * the row's current state and only the server holds it.
 */

export const activityUpdatePageResponse = envelope(activityUpdatePage);
export const postActivityUpdateResponse = envelope(postActivityUpdateResult);
export const deletedActivityUpdateResponse = envelope(deletedActivityUpdate);

export type ActivityUpdatePage = z.infer<typeof activityUpdatePage>;
export type PostActivityUpdateResult = z.infer<typeof postActivityUpdateResult>;
export type DeletedActivityUpdate = z.infer<typeof deletedActivityUpdate>;

/**
 * `GET /v1/activities/:id/updates?cursor=` — newest first, 50 per page.
 *
 * The page carries its own `cursor` **inside `data`**, not in `meta`, which is the shape
 * `activityUpdatePage` defines and the shape Activity detail embeds for its first page. It is
 * returned untouched so a caller continues from the feed's own continuation rather than from a
 * position it inferred.
 */
export function getActivityUpdates(
  client: HttpClient,
  activityId: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<ActivityUpdatePage> {
  const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  return client
    .request({
      method: 'GET',
      path: `/v1/activities/${activityId}/updates${query}`,
      schema: activityUpdatePageResponse,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/**
 * `POST /v1/activities/:id/updates` — Plan only.
 *
 * ## The return type is the pair, and callers cannot drop half of it
 *
 * The response is `{ update, lastActivityAt }` and this function returns both. The timestamp is
 * not a convenience: `#P` sorts on `lastActivityAt`, GSI1 is eventually consistent, and a
 * client that posted and then refetched could read a projection older than the write it just
 * made — putting the row it just touched back where it was. Returning the authoritative value
 * lets P3-39 move the row immediately and treat a later, staler page as reconciliation.
 *
 * A signature that returned only the `ActivityUpdate` would make that mistake the default and
 * invisible, so the whole result is returned and the caller destructures what it needs. Merge
 * the timestamp **monotonically**: never replace a newer authoritative value with an older one
 * from an immediate refetch.
 */
export function postActivityUpdate(
  client: HttpClient,
  activityId: string,
  body: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<PostActivityUpdateResult> {
  return client
    .request({
      method: 'POST',
      path: `/v1/activities/${activityId}/updates`,
      schema: postActivityUpdateResponse,
      body: { body },
      headers: { 'Idempotency-Key': idempotencyKey },
      replayProtected: true,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/**
 * `DELETE /v1/activities/:id/updates/:updateId` — author only, and only on `kind: 'user'`.
 *
 * A system entry is the record of what happened and is undeletable; so is another author's.
 * Both answer `404`, deliberately indistinguishable from a missing row, so this function
 * cannot and does not tell them apart. Success returns the id inside the universal envelope.
 */
export function deleteActivityUpdate(
  client: HttpClient,
  activityId: string,
  updateId: string,
  signal?: AbortSignal,
): Promise<DeletedActivityUpdate> {
  return client
    .request({
      method: 'DELETE',
      path: `/v1/activities/${activityId}/updates/${updateId}`,
      schema: deletedActivityUpdateResponse,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}
