import type { z } from 'zod';
import {
  type ActivityListQuery,
  activity,
  activityCompletionResult,
  activityDetail,
  activityListItem,
  type CompleteActivityInput,
  type ConvertRecurrenceInput,
  type CreateActivityInput,
  deletedActivity,
  type PatchActivityInput,
  type SkipActivityInput,
  type UncompleteActivityInput,
} from '../../schemas/activity.js';
import { envelope } from '../../schemas/envelope.js';
import {
  type AddIngredientsToListInput,
  addIngredientsToListResult,
} from '../../schemas/list.js';
import type {
  SnoozeActivityInput,
  UnsnoozeActivityInput,
} from '../../schemas/occurrence.js';
import { deletedReminder, type ReminderInput, reminder } from '../../schemas/reminder.js';
import {
  type ScheduleActivityInput,
  type ScheduleActivityResult,
  scheduleActivityResult,
} from '../../schemas/schedule.js';
import type { Activity } from '../../types/activity.js';
import type { ActivityDetail, ActivityDetailTarget } from '../../types/activityDetail.js';
import type { Reminder } from '../../types/reminder.js';
import { ApiError, type HttpClient } from '../http.js';

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
export const activityCompletionResponse = envelope(activityCompletionResult);
const addIngredientsToListResponse = envelope(addIngredientsToListResult);
export const deletedActivityResponse = envelope(deletedActivity);
export const scheduleActivityResponse = envelope(scheduleActivityResult);
export const reminderResponse = envelope(reminder);
export const reminderListResponse = envelope(reminder.array());
export const deletedReminderResponse = envelope(deletedReminder);

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
  target: ActivityDetailTarget,
  signal?: AbortSignal,
): Promise<ActivityDetail> {
  const occurrenceQuery =
    target.kind === 'occurrence'
      ? `?occurrenceDate=${encodeURIComponent(target.date)}`
      : '';
  return client
    .request({
      method: 'GET',
      path: `/v1/activities/${target.activityId}${occurrenceQuery}`,
      schema: activityDetailResponse,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data as ActivityDetail);
}

/** `GET /v1/activities/:id/reminders` — already scoped to the signed-in user. */
export function listReminders(
  client: HttpClient,
  activityId: string,
  signal?: AbortSignal,
): Promise<Reminder[]> {
  return client
    .request({
      method: 'GET',
      path: `/v1/activities/${activityId}/reminders`,
      schema: reminderListResponse,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/** Creating a server-id reminder requires one caller-generated key reused across retries. */
export function createReminder(
  client: HttpClient,
  activityId: string,
  input: ReminderInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<Reminder> {
  return client
    .request({
      method: 'POST',
      path: `/v1/activities/${activityId}/reminders`,
      schema: reminderResponse,
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/** Deletes only the signed-in user's row; somebody else's opaque id resolves to `404`. */
export function deleteReminder(
  client: HttpClient,
  activityId: string,
  reminderId: string,
  signal?: AbortSignal,
): Promise<{ reminderId: string }> {
  return client
    .request({
      method: 'DELETE',
      path: `/v1/activities/${activityId}/reminders/${reminderId}`,
      schema: deletedReminderResponse,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/** A 404 is success only while replaying this caller's own queued reminder removal. */
export async function deleteReminderForReplay(
  client: HttpClient,
  activityId: string,
  reminderId: string,
  signal?: AbortSignal,
): Promise<{ reminderId: string }> {
  try {
    return await deleteReminder(client, activityId, reminderId, signal);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { reminderId };
    throw error;
  }
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

/** Converts one explicitly selected series occurrence into the surviving one-off. */
export function convertRecurrence(
  client: HttpClient,
  activityId: string,
  selectedDate: ConvertRecurrenceInput['occurrenceDate'],
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<Activity> {
  return client
    .request({
      method: 'POST',
      path: `/v1/activities/${activityId}/recurrence/convert`,
      schema: activityResponse,
      body: { occurrenceDate: selectedDate },
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data as Activity);
}

/**
 * Reconciles only a PATCH that this client previously enqueued.
 *
 * A lost success response leaves the persisted `If-Match` stale. On replay, a 409 is success
 * only when the freshly-read canonical Activity contains every intended value. A genuinely
 * different value remains a conflict for the sync banner to surface.
 */
export async function patchActivityForReplay(
  client: HttpClient,
  activityId: string,
  input: PatchActivityInput,
  ifMatch: string,
  signal?: AbortSignal,
): Promise<Activity> {
  try {
    return await patchActivity(client, activityId, input, ifMatch, signal);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;

    const fresh = await getActivity(client, { kind: 'activity', activityId }, signal);
    if (!activityContainsPatch(fresh.activity, input)) throw error;
    return fresh.activity;
  }
}

function activityContainsPatch(activity: Activity, input: PatchActivityInput): boolean {
  for (const field of Object.keys(input) as Array<keyof PatchActivityInput>) {
    if (field === 'editedFromDate') {
      const active = activity.recurrence?.segments.at(-1);
      if (active?.effectiveFrom !== input.editedFromDate) return false;
      continue;
    }
    if (field === 'recurrence') {
      if (input.recurrence === null) {
        if (activity.recurrence !== undefined) return false;
        continue;
      }
      if (input.recurrence === undefined) continue;
      if (!sameValue(activity.recurrence, canonicalRecurrence(activity, input)))
        return false;
      continue;
    }

    const intended = input[field];
    const actual = activity[field as keyof Activity];
    if (intended === null) {
      if (actual !== undefined) return false;
    } else if (!sameValue(actual, intended)) {
      return false;
    }
  }
  return true;
}

function canonicalRecurrence(
  activity: Activity,
  input: PatchActivityInput,
): NonNullable<PatchActivityInput['recurrence']> {
  const supplied = input.recurrence;
  if (supplied == null) throw new Error('A recurrence comparison requires recurrence.');
  const segments = supplied.segments.map((segment, index) => {
    if (index !== supplied.segments.length - 1) return segment;
    const effectiveFrom = input.editedFromDate ?? segment.effectiveFrom;
    const time = segment.time ?? activity.schedule?.time;
    const endTime = segment.endTime ?? activity.schedule?.endTime;
    return {
      ...segment,
      effectiveFrom,
      ...(time === undefined ? {} : { time }),
      ...(endTime === undefined ? {} : { endTime }),
    };
  });
  return { ...supplied, segments };
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
      return false;
    return left.every((value, index) => sameValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && sameValue(leftRecord[key], rightRecord[key]),
    )
  );
}

/** `POST /v1/activities/:id/schedule`, the only schedule write path. */
export function scheduleActivity(
  client: HttpClient,
  activityId: string,
  input: ScheduleActivityInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ScheduleActivityResult> {
  return client
    .request({
      method: 'POST',
      path: `/v1/activities/${activityId}/schedule`,
      schema: scheduleActivityResponse,
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
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

/** A 404 is success only for replay of this client's own already-requested delete. */
export async function deleteActivityForReplay(
  client: HttpClient,
  activityId: string,
  signal?: AbortSignal,
): Promise<{ activityId: string }> {
  try {
    return await deleteActivity(client, activityId, signal);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { activityId };
    throw error;
  }
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
 * Sends selected meal ingredients to a list the caller has already chosen (P3-17).
 *
 * `listId` is required and comes from the destination the user confirmed — the slot is
 * resolved client-side, before this is called, and never here.
 */
export function addIngredientsToList(
  client: HttpClient,
  activityId: string,
  input: AddIngredientsToListInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<z.infer<typeof addIngredientsToListResult>> {
  return client
    .request({
      method: 'POST',
      path: `/v1/activities/${activityId}/ingredients/add-to-list`,
      schema: addIngredientsToListResponse,
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/** Completes an activity or one recurring occurrence. Retries replay byte-for-byte. */
export function completeActivity(
  client: HttpClient,
  activityId: string,
  input: CompleteActivityInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<z.infer<typeof activityCompletionResult>> {
  return client
    .request({
      method: 'POST',
      path: `/v1/activities/${activityId}/complete`,
      schema: activityCompletionResponse,
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/** Reverses completion/skipping for an activity or one recurring occurrence. */
export function uncompleteActivity(
  client: HttpClient,
  activityId: string,
  input: UncompleteActivityInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<z.infer<typeof activityCompletionResult>> {
  return client
    .request({
      method: 'POST',
      path: `/v1/activities/${activityId}/uncomplete`,
      schema: activityCompletionResponse,
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/** Skips an activity or one recurring occurrence. Retries replay byte-for-byte. */
export function skipActivity(
  client: HttpClient,
  activityId: string,
  input: SkipActivityInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<z.infer<typeof activityCompletionResult>> {
  return client
    .request({
      method: 'POST',
      path: `/v1/activities/${activityId}/skip`,
      schema: activityCompletionResponse,
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/** Snoozes a timed activity or one recurring occurrence. */
export function snoozeActivity(
  client: HttpClient,
  activityId: string,
  input: SnoozeActivityInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<z.infer<typeof activityCompletionResult>> {
  return client
    .request({
      method: 'POST',
      path: `/v1/activities/${activityId}/snooze`,
      schema: activityCompletionResponse,
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/** Removes only snooze state; retries replay byte-for-byte. */
export function unsnoozeActivity(
  client: HttpClient,
  activityId: string,
  input: UnsnoozeActivityInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<z.infer<typeof activityCompletionResult>> {
  return client
    .request({
      method: 'POST',
      path: `/v1/activities/${activityId}/unsnooze`,
      schema: activityCompletionResponse,
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
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
