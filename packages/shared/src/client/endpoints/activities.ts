import type { z } from 'zod';
import {
  type ActivityListQuery,
  activity,
  activityDetail,
  activityListItem,
  type CreateActivityInput,
  deletedActivity,
  type PatchActivityInput,
} from '../../schemas/activity.js';
import { envelope } from '../../schemas/envelope.js';
import type { Activity } from '../../types/activity.js';
import type { ActivityDetail } from '../../types/activityDetail.js';
import type { HttpClient } from '../http.js';

/**
 * The Activity endpoint functions (`api-contract.md` §2.3).
 *
 * ## Why the input type is `CreateActivityInput` and not a looser shape
 *
 * `CreateActivityInput` is a discriminated union on `objectKind`, so **the type system will
 * not let a caller build a request without a complete, valid target pair**. There is no
 * `Partial<>`, no `type?:` and no builder that fills a default — a form store that has not
 * yet been given a target simply cannot produce a value of this type, which is the compile-
 * time half of `CLAUDE.md` rule 2. The runtime half is the schema on the server.
 *
 * Do not add an overload, a default parameter, or a helper that supplies `objectKind` or
 * `type`. The one place either is chosen is the user's tap on the chooser.
 */

export const activityResponse = envelope(activity);
export const activityDetailResponse = envelope(activityDetail);
export const deletedActivityResponse = envelope(deletedActivity);

/** A list answers with an array **and** `meta.nextCursor`, so the whole envelope is returned. */
export const activityListResponse = envelope(activityListItem.array());

/**
 * `POST /v1/activities`.
 *
 * `idempotencyKey` is **required**, not optional. Every creating `POST` carries one
 * (`api-contract.md` §1), and it is also what makes the request retryable at all — the
 * client's retry predicate looks for exactly this header. An optional parameter here would
 * mean a create that silently loses its retries and can double-write on a flaky connection.
 * The caller generates it once at `onMutate` and reuses it across retries.
 */
export function createActivity(
  client: HttpClient,
  input: CreateActivityInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<Activity> {
  return client
    .request({
      method: 'POST',
      path: '/v1/activities',
      schema: activityResponse,
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data as Activity);
}

/**
 * `GET /v1/activities/:id`.
 *
 * One request, which is one DynamoDB Query over the `ACT#<id>` partition — the detail screen
 * never fans out. `reminders` comes back already filtered to the caller by the server's
 * projection; the client does not filter and must not be written as though it might need to.
 */
export function getActivity(
  client: HttpClient,
  activityId: string,
  signal?: AbortSignal,
): Promise<ActivityDetail> {
  return client
    .request({
      method: 'GET',
      path: `/v1/activities/${activityId}`,
      schema: activityDetailResponse,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data as ActivityDetail);
}

/**
 * `PATCH /v1/activities/:id`.
 *
 * `ifMatch` is **required**, not optional, and it carries the activity's `updatedAt`.
 *
 * That is the whole optimistic-concurrency story and it only works if every caller sends it.
 * An optional parameter would mean a `PATCH` that silently wins every race — the last writer
 * overwriting an edit it never saw — and the failure is invisible: both writes return 200 and
 * one person's change is simply gone. Making it a required positional argument means a caller
 * that has not got a version cannot construct the call at all.
 *
 * A mismatch is `409 conflict`, which the caller handles per `activities.md` §6.1: refetch,
 * re-apply non-overlapping fields, name the ones that were dropped.
 */
export function patchActivity(
  client: HttpClient,
  activityId: string,
  input: PatchActivityInput,
  ifMatch: string,
  signal?: AbortSignal,
): Promise<Activity> {
  return client
    .request({
      method: 'PATCH',
      path: `/v1/activities/${activityId}`,
      schema: activityResponse,
      body: input,
      headers: { 'If-Match': ifMatch },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data as Activity);
}

/**
 * `DELETE /v1/activities/:id`.
 *
 * Owner only, and **safe to call twice**: the removal batches rather than transacting, so a
 * partial failure is finished by a retry and the second call answers `404` because there is
 * nothing left. A caller retrying its own delete should read that `404` as success; one that
 * did not initiate a delete should not.
 *
 * **Prep tasks survive.** Their `parentActivityId` is cleared server-side and they become
 * ordinary tasks, so a caller must invalidate its task lists as well as the plan it deleted —
 * rows it did not ask about have changed.
 */
export function deleteActivity(
  client: HttpClient,
  activityId: string,
  signal?: AbortSignal,
): Promise<{ activityId: string }> {
  return client
    .request({
      method: 'DELETE',
      path: `/v1/activities/${activityId}`,
      schema: deletedActivityResponse,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/**
 * `POST /v1/activities/:id/duplicate`.
 *
 * Creating, so it carries an `Idempotency-Key` for the same reason `createActivity` does — a
 * retried duplicate is exactly the request where "it worked but I did not hear back" leaves
 * two identical activities and no way to tell them apart.
 *
 * The copy carries content and nothing else: no schedule, reminders, participants, expenses,
 * attachments, prep children or completion state, and its title is suffixed ` (copy)`. The
 * caller opens it in the edit state so the user can rename it before it settles
 * (`activities.md` §7.1).
 */
export function duplicateActivity(
  client: HttpClient,
  activityId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<Activity> {
  return client
    .request({
      method: 'POST',
      path: `/v1/activities/${activityId}/duplicate`,
      schema: activityResponse,
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data as Activity);
}

/**
 * `GET /v1/activities?filter=` — one flat, paginated stage.
 *
 * Returns the **envelope**, not just `data`, unlike the single-object reads above. The cursor
 * lives in `meta` and a list caller needs it, so dropping `meta` here would make paging
 * impossible; `health.ts` records that this decision belongs to each endpoint rather than to
 * the client.
 *
 * ## Page until the cursor is absent, never until a page is short
 *
 * `type` is applied by the server **after** its query, so a full page can come back nearly
 * empty — or completely empty — while `meta.nextCursor` is still set. A caller that stops on
 * a short page silently loses rows. This is the one surprising thing about the endpoint and
 * it is stated at the call site because the type cannot express it.
 */
export function listActivities(
  client: HttpClient,
  query: ActivityListQuery,
  signal?: AbortSignal,
): Promise<z.infer<typeof activityListResponse>> {
  return client.request({
    method: 'GET',
    path: `/v1/activities?${toSearchParams(query)}`,
    schema: activityListResponse,
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * The query string, with absent parameters omitted rather than serialised as `undefined`.
 *
 * `URLSearchParams` would render a missing `type` as the literal string `undefined`, which
 * the server's strict schema then rejects — a `400` whose cause is three layers from where it
 * looks like it came from.
 */
function toSearchParams(query: ActivityListQuery): string {
  const params = new URLSearchParams({ filter: query.filter });
  if (query.type !== undefined) params.set('type', query.type);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  return params.toString();
}
