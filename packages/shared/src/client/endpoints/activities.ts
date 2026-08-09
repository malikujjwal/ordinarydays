import {
  activity,
  activityDetail,
  type CreateActivityInput,
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
