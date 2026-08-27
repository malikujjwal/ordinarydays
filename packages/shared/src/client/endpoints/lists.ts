import type { z } from 'zod';
import { envelope } from '../../schemas/envelope.js';
import {
  type ChangeListBehaviourInput,
  type CreateListInput,
  deletedList,
  listDetail,
  listSettingsMutation,
  listUndoResult,
  listView,
  type PatchListInput,
} from '../../schemas/list.js';
import type { ListBehaviourConfirmation } from '../../types/list.js';
import { ApiError, type HttpClient } from '../http.js';

/**
 * The List endpoint functions (`api-contract.md` §2.7).
 *
 * ## The three shapes a List mutation answers with, and why none of them is interchangeable
 *
 * A **settings** change answers with {@link listSettingsMutation} — the list, plus an Undo
 * offer when the change recorded an inverse. An **item** mutation answers with the
 * `{ affectedCount, undoToken, undoExpiresAt }` triple (see `listItems.ts`). **Undo itself**
 * answers with a discriminated outcome, never a count. Each is parsed by its own schema here
 * so a caller cannot read a field off the wrong one.
 *
 * ## What this file deliberately does not do
 *
 * It never reconstructs a row. `undoListOperation` sends a token and nothing else, because the
 * server owns the compensation and a client sending deleted contents back as authority is the
 * failure the opaque token exists to prevent (`api-contract.md` §2.7).
 */

export const listResponse = envelope(listView);
export const listDetailResponse = envelope(listDetail);
export const listSettingsResponse = envelope(listSettingsMutation);
export const listUndoResponse = envelope(listUndoResult);
export const deletedListResponse = envelope(deletedList);

/**
 * A page answers with an array **and** `meta.nextCursor`, so the whole envelope is returned —
 * the same choice `activityListResponse` makes and for the same reason: a function that
 * returned `data` alone would silently drop the only thing that says there is more.
 */
export const listPageResponse = envelope(listView.array());

export type ListView = z.infer<typeof listView>;
export type ListDetail = z.infer<typeof listDetail>;
export type ListSettingsMutation = z.infer<typeof listSettingsMutation>;
export type ListUndoResult = z.infer<typeof listUndoResult>;
export type ListPage = z.infer<typeof listPageResponse>;

/**
 * `POST /v1/lists`.
 *
 * `idempotencyKey` is **required**, for the reason `createActivity` records. `input.listId` is
 * separate from it and does a different job: the key deduplicates *this request*, while
 * `listId` is the permanent `lst_` identity the device minted before the intent entered SQLite
 * (ADR-055). A retry reuses **both** — a new id on a retry is how one durable create becomes
 * two lists.
 */
export function createList(
  client: HttpClient,
  input: CreateListInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ListView> {
  return client
    .request({
      method: 'POST',
      path: '/v1/lists',
      schema: listResponse,
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/**
 * `GET /v1/lists?cursor=`.
 *
 * Returns the envelope, not the array. The endpoint **does not filter by `archived`**, and a
 * page filtered empty by the client may still carry `nextCursor` — so a caller that took the
 * array alone could render `No lists yet` over a cursor it never followed. P3-25's auto-drain
 * rule is only expressible because this returns `meta`.
 */
export function getLists(
  client: HttpClient,
  cursor?: string,
  signal?: AbortSignal,
): Promise<ListPage> {
  const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  return client.request({
    method: 'GET',
    path: `/v1/lists${query}`,
    schema: listPageResponse,
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * `GET /v1/lists/:id`.
 *
 * `includeItems` asks for the fenced first item page **and its cursor**, which is returned
 * inside `data` rather than `meta` because it is bound to the META `rankVersion` this response
 * read, not to the request. It is passed through untouched: no caller may assume the first 50
 * items are the whole list, and a function that dropped the cursor would make that assumption
 * unavoidable.
 *
 * A repair or behaviour-migration fence answers `503` with `Retry-After: 1`. That surfaces as
 * an ordinary retryable `ApiError` — the transport already retries it — and is deliberately not
 * special-cased here: the client's job is to carry it, not to interpret a server fence.
 */
export function getList(
  client: HttpClient,
  listId: string,
  options: { includeItems?: boolean } = {},
  signal?: AbortSignal,
): Promise<ListDetail> {
  const query = options.includeItems === true ? '?includeItems=true' : '';
  return client
    .request({
      method: 'GET',
      path: `/v1/lists/${listId}${query}`,
      schema: listDetailResponse,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/**
 * `PATCH /v1/lists/:id` — title, capabilities, slot and archived.
 *
 * **`behaviour` is not among them, by type.** {@link PatchListInput} is strict and has no
 * `behaviour` key, so a caller cannot express the change here at all; it goes through
 * {@link changeListBehaviour}, which is replay-protected because it is a gated resumable item
 * migration rather than one conditional write. `templateKey` is absent for a different reason —
 * it is immutable provenance.
 *
 * `ifMatch` is **required** and carries the `updatedAt` the client read. An optional parameter
 * would mean a patch that silently wins every race, and the server answers `validation_failed`
 * when it is missing — so an optional one here would only move the failure later.
 *
 * The `undoToken` is present only when the change recorded an inverse: a rename alone returns
 * none, because renaming a list has no undo row in `interaction-contract.md` §4.1. That is why
 * the result is a union rather than a shape with two optional fields.
 */
export function patchList(
  client: HttpClient,
  listId: string,
  patch: PatchListInput,
  ifMatch: string,
  signal?: AbortSignal,
): Promise<ListSettingsMutation> {
  return client
    .request({
      method: 'PATCH',
      path: `/v1/lists/${listId}`,
      schema: listSettingsResponse,
      body: patch,
      headers: { 'If-Match': ifMatch },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/**
 * `POST /v1/lists/:id/behaviour` — the replay-protected behaviour change.
 *
 * Both headers are required and neither is decoration. `If-Match` is the concurrency check
 * every settings write carries; `Idempotency-Key` **identifies the migration**, so a replay
 * resumes its own work rather than starting a second one over the same items.
 *
 * ## The 409 is a value, not a failure
 *
 * A destructive transition that would actually lose something answers `409` carrying
 * `{ confirmation: { fromBehaviour, toBehaviour, itemVersion, itemCount, fields } }`, having
 * started no migration and written no receipt. `interaction-contract.md` §5.3 renders that as
 * the §1a.1 dialog rather than an error toast, and the confirmed call **echoes the whole
 * object back** under a newly minted key.
 *
 * The echo is why the confirmation must be surfaced rather than re-derived: `itemVersion` is
 * the server's basis for the preview, and a client that rebuilt the object from a paginated
 * cache would be confirming a count it measured itself against a version it never saw.
 * `?confirmDataLoss` no longer exists — it was an ambient permission to destroy whatever
 * happened to be there when the request landed.
 *
 * The error is rethrown untouched; {@link behaviourConfirmationFrom} reads the typed value off
 * it. Swallowing the `ApiError` to return the confirmation would make a refusal look like a
 * success to every caller that did not check.
 */
export function changeListBehaviour(
  client: HttpClient,
  listId: string,
  input: ChangeListBehaviourInput,
  ifMatch: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ListSettingsMutation> {
  return client
    .request({
      method: 'POST',
      path: `/v1/lists/${listId}/behaviour`,
      schema: listSettingsResponse,
      body: input,
      headers: { 'If-Match': ifMatch, 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/**
 * The typed confirmation a destructive behaviour `409` carries, or `undefined` for any other
 * error.
 *
 * A named reader rather than `error.confirmation` at every call site: the field is only
 * meaningful on a `409` from this one route, and the status check belongs with the field it
 * qualifies. A caller that read the property directly off an arbitrary `ApiError` would be
 * writing a check that compiles everywhere and is right in one place.
 *
 * The returned object is the server's, verbatim, and is what
 * {@link changeListBehaviour}'s next call must echo.
 */
export function behaviourConfirmationFrom(
  error: unknown,
): ListBehaviourConfirmation | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.status !== 409) return undefined;
  return error.confirmation;
}

/** `DELETE /v1/lists/:id`. Owner only; names what was removed, per §1's DELETE-answers-200 rule. */
export function deleteList(
  client: HttpClient,
  listId: string,
  signal?: AbortSignal,
): Promise<{ listId: string }> {
  return client
    .request({
      method: 'DELETE',
      path: `/v1/lists/${listId}`,
      schema: deletedListResponse,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/**
 * `POST /v1/lists/:id/undo` — the opaque token, and nothing else.
 *
 * ## Why the parameter is a string and not an operation
 *
 * The token is the whole request body (`api-contract.md` §2.7). The server recorded the
 * compensation when it performed the forward operation; the client never learns what will be
 * restored and never sends rows back as authority. A signature that accepted anything richer
 * would be an invitation to build the inverse client-side, which is the one thing this route
 * exists to make impossible.
 *
 * `idempotencyKey` is the **inverse's own**, not the forward operation's. An accepted Undo is a
 * durable action in its own right, ordered after the original, and may arrive long after
 * `undoExpiresAt` — that field governs whether the UI may still *offer* Undo, never whether an
 * accepted one may run.
 *
 * All three outcomes are `200` and none is an error: `expired` and `no_longer_applicable` are
 * true answers to the question asked, and are returned as data for the caller to branch on.
 */
export function undoListOperation(
  client: HttpClient,
  listId: string,
  undoToken: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ListUndoResult> {
  return client
    .request({
      method: 'POST',
      path: `/v1/lists/${listId}/undo`,
      schema: listUndoResponse,
      body: { undoToken },
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

export type { ChangeListBehaviourInput, CreateListInput, PatchListInput };
