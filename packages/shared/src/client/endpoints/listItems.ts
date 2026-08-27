import type { z } from 'zod';
import { envelope } from '../../schemas/envelope.js';
import {
  type BulkCreateListItemsInput,
  type CreateListItemInput,
  listItemView,
  type PatchListItemInput,
  reversibleItemMutation,
  type ScheduleListItemInput,
  scheduledListItem,
} from '../../schemas/list.js';
import { ApiError, type HttpClient } from '../http.js';

/**
 * The ListItem endpoint functions (`api-contract.md` §2.7).
 *
 * ## No function here takes a `rank`
 *
 * Position is expressed as `afterItemId` — `null` for the front, an id for after that item,
 * absent for no reorder at all — and never as a rank. The lexo rank is server-owned; a client
 * that could send one would be allocating in a keyspace it cannot see, against a
 * `rankVersion` it does not hold, and two clients doing it would interleave. P3-03 made this a
 * rule and `endpoints.test.ts` greps this file for it, so the absence is enforced rather than
 * remembered.
 *
 * ## There is no `If-Match` on an item write
 *
 * Item writes are per-field last-write-wins (`data-model.md` §4.6). Optimistic concurrency on
 * every checkbox in a grocery list would produce constant spurious `409`s for no benefit, so
 * the internal `itemRevision` is a retry fence the server resolves, not a version the client
 * holds. Do not add one to match `patchList`; the asymmetry is the design.
 */

export const listItemResponse = envelope(listItemView);
export const listItemsResponse = envelope(listItemView.array());
export const reversibleItemMutationResponse = envelope(reversibleItemMutation);
export const scheduledListItemResponse = envelope(scheduledListItem);

/** An item page answers with an array **and** `meta.nextCursor`; the envelope carries both. */
export const listItemPageResponse = envelope(listItemView.array());

export type ListItemView = z.infer<typeof listItemView>;
export type ReversibleItemMutation = z.infer<typeof reversibleItemMutation>;
export type ScheduledListItem = z.infer<typeof scheduledListItem>;
export type ListItemPage = z.infer<typeof listItemPageResponse>;

/**
 * `POST /v1/lists/:id/items`.
 *
 * `input.itemId` is the permanent client-minted `itm_` identity, distinct from
 * `idempotencyKey` in exactly the way {@link createList}'s two ids are: the key deduplicates
 * this request, the id survives the receipt's 24-hour expiry. A retry reuses both. Neither is
 * regenerated on the way through — a wrapper that re-minted an id while retrying the same
 * durable action is how one offline create becomes two rows.
 */
export function createListItem(
  client: HttpClient,
  listId: string,
  input: CreateListItemInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ListItemView> {
  return client
    .request({
      method: 'POST',
      path: `/v1/lists/${listId}/items`,
      schema: listItemResponse,
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/**
 * `POST /v1/lists/:id/items/bulk` — one ordered sequence, one rank allocation.
 *
 * The `Idempotency-Key` matters most here. A bulk create is chunked server-side, so a replay
 * after a partial commit must resume rather than restart; every member also carries its own
 * `itemId`, which is what lets replay after the receipt expires reconcile the items that
 * landed instead of duplicating the batch.
 *
 * **The batch takes one position, on its first member** (P3-08). `afterItemId` on a later
 * member is a named `400`: the sequence draws its ranks from a single `rankVersion` read, and
 * honouring a position per member would mean an allocation each — the fan-out the single
 * sequence exists to prevent. The shape is not narrowed here, because the rule belongs to the
 * schema both sides share, not to a client-side check that the server would have to repeat.
 */
export function bulkCreateListItems(
  client: HttpClient,
  listId: string,
  input: BulkCreateListItemsInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ListItemView[]> {
  return client
    .request({
      method: 'POST',
      path: `/v1/lists/${listId}/items/bulk`,
      schema: listItemsResponse,
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/**
 * `GET /v1/lists/:id/items?cursor=`.
 *
 * Returns the envelope so `meta.nextCursor` survives. The cursor is bound to the META
 * `rankVersion` that issued it, which is why a reorder, repair or behaviour migration mid-page
 * answers `503` rather than a spliced page: no response can span one. The `503` is passed
 * through as a retryable `ApiError`; the client retains its committed projection and restarts
 * from page one, which is a caller decision and not something to bury here.
 */
export function getListItems(
  client: HttpClient,
  listId: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<ListItemPage> {
  const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  return client.request({
    method: 'GET',
    path: `/v1/lists/${listId}/items${query}`,
    schema: listItemPageResponse,
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * `GET /v1/lists/:id/items/:itemId` — the authoritative exact read.
 *
 * Its purpose is reconciliation, not display: after a durable create whose response was lost,
 * this is what says whether the row exists under the id the device minted.
 */
export function getListItem(
  client: HttpClient,
  listId: string,
  itemId: string,
  signal?: AbortSignal,
): Promise<ListItemView> {
  return client
    .request({
      method: 'GET',
      path: `/v1/lists/${listId}/items/${itemId}`,
      schema: listItemResponse,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/**
 * Reconciles a create this client previously enqueued, when its response was lost.
 *
 * The two outcomes are **not** equivalent and the return type says so (ADR-055,
 * `api-contract.md` §2.7):
 *
 * - `200` — the earlier request landed. The server representation wins wholesale, and the
 *   caller adopts it rather than re-sending.
 * - `404` — **ambiguous**, and returned as `undefined` rather than thrown. The create may
 *   never have arrived, or it may have arrived and been deleted since. The intent parks for an
 *   explicit Retry or Discard; there is no automatic re-mint, because guessing here is how a
 *   deleted row comes back to life.
 *
 * A tombstoned id answers `404` exactly as a missing one does, which is why the client cannot
 * resolve the ambiguity itself and must hand it to the user. Every other status still throws:
 * a `503` fence is a retry, not an absence.
 */
export async function getListItemForReplay(
  client: HttpClient,
  listId: string,
  itemId: string,
  signal?: AbortSignal,
): Promise<ListItemView | undefined> {
  try {
    return await getListItem(client, listId, itemId, signal);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined;
    throw error;
  }
}

/**
 * `PATCH /v1/lists/:id/items/:itemId` — fields, a position, or both together.
 *
 * A reorder and ordinary edits **land together**: the reorder re-puts the whole row at its new
 * key, so supplied fields fold into that put and the write stays the same four domain actions
 * (P3-08). There is no separate reorder function, because a second one would imply two writes
 * where the server performs one.
 *
 * `null` on `note`, `location` or `details` **clears** the field; absent leaves it alone. The
 * patch type keeps those distinguishable, and a caller that collapsed them into one optional
 * would lose the ability to remove a note at all.
 */
export function patchListItem(
  client: HttpClient,
  listId: string,
  itemId: string,
  patch: PatchListItemInput,
  signal?: AbortSignal,
): Promise<ListItemView> {
  return client
    .request({
      method: 'PATCH',
      path: `/v1/lists/${listId}/items/${itemId}`,
      schema: listItemResponse,
      body: patch,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/**
 * `DELETE /v1/lists/:id/items/:itemId`.
 *
 * Answers the reversible triple — `affectedCount` is `1` for a single delete — rather than the
 * bare id the other deletes return, because this one opens a 6-second Undo window and the
 * token is the only way back. `undoExpiresAt` is the **UI offer deadline**: stop offering at
 * that instant, while an inverse the user already accepted stays valid for the whole retention
 * window. Conflating the two is what would make an accepted offline Undo expire in transit.
 */
export function deleteListItem(
  client: HttpClient,
  listId: string,
  itemId: string,
  signal?: AbortSignal,
): Promise<ReversibleItemMutation> {
  return client
    .request({
      method: 'DELETE',
      path: `/v1/lists/${listId}/items/${itemId}`,
      schema: reversibleItemMutationResponse,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/**
 * `POST /v1/lists/:id/items/:itemId/schedule` — the optional bridge to Activities.
 *
 * ## There is no convenience overload, and there will not be one
 *
 * {@link ScheduleListItemInput} requires `activityId`, `creationTarget` and `audience`, and
 * this function sends it **exactly**. No parameter defaults any of the three. That is
 * `CLAUDE.md` rule 2 at the last point code could break it: the Plan kind and the audience are
 * the user's explicit choices, and a helper that supplied `{ mode: 'just_me' }` for a caller
 * that had not asked would be inferring intent from a call site. An omitted field fails at the
 * schema, loudly, which is the intended outcome.
 *
 * `activityId` and every `reminderId` are required here though optional on
 * `POST /v1/activities`, because this path is offline-capable: the device persists them in the
 * same SQLite transaction as the intent, so replay stays duplicate-safe after the idempotency
 * receipt expires and a reminder can be armed locally under the identity it keeps forever.
 */
export function scheduleListItem(
  client: HttpClient,
  listId: string,
  itemId: string,
  input: ScheduleListItemInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ScheduledListItem> {
  return client
    .request({
      method: 'POST',
      path: `/v1/lists/${listId}/items/${itemId}/schedule`,
      schema: scheduledListItemResponse,
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

export type {
  BulkCreateListItemsInput,
  CreateListItemInput,
  PatchListItemInput,
  ScheduleListItemInput,
};
