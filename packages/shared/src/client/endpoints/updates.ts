import { z } from 'zod';
import {
  activityUpdatePage,
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

/**
 * `DELETE /v1/activities/:id/updates/:updateId` answers **`204` with no body**.
 *
 * This is the one endpoint in the client that does not parse an envelope, and it is a
 * deliberate divergence from the rule the other deletes follow — `deletedDevice`,
 * `deletedAttachment` and `deletedList` all return a body precisely because `api-contract.md`
 * §1 says every response carries `{ data, meta }` and a `204` has nowhere to put one. P3-19
 * shipped the `204` anyway, reasoning that the feed's new state is a page the client already
 * has minus one row. The code is the contract, so this schema matches the code; the divergence
 * is named in the pull request rather than papered over with a shape the server never sends.
 *
 * `z.undefined()` rather than `z.void()`: the transport turns an empty body into `undefined`
 * before parsing, so this asserts the body really was empty instead of accepting anything.
 */
const noContent = z.undefined();

export type ActivityUpdatePage = z.infer<typeof activityUpdatePage>;
export type PostActivityUpdateResult = z.infer<typeof postActivityUpdateResult>;

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
 * cannot and does not tell them apart. It returns nothing because the response carries
 * nothing.
 */
export function deleteActivityUpdate(
  client: HttpClient,
  activityId: string,
  updateId: string,
  signal?: AbortSignal,
): Promise<void> {
  return client
    .request({
      method: 'DELETE',
      path: `/v1/activities/${activityId}/updates/${updateId}`,
      schema: noContent,
      ...(signal === undefined ? {} : { signal }),
    })
    .then(() => undefined);
}
