import { isDeepStrictEqual } from 'node:util';
import {
  blockerMessage,
  type ChangeResult,
  type ChangeTarget,
  changeActivityKind,
} from '@od/shared';
import { MAX_TITLE_LEN } from '@od/shared/constants';
import { expandRecurrence, toUtcInstant } from '@od/shared/recurrence';
import type {
  ActivityListQuery,
  CreateActivityInput,
  PatchActivityInput,
} from '@od/shared/schemas';
import {
  recurrence as recurrenceSchema,
  reminderInputsForSchedule,
} from '@od/shared/schemas';
import type {
  Activity,
  ActivityDetail,
  ActivityFilter,
  ActivityListItem,
  ActivitySchedule,
  ActivityStatus,
  Gsi1Bucket,
  Recurrence,
  RecurrenceSegment,
  Reminder,
} from '@od/shared/types';
import { formatInTimeZone } from 'date-fns-tz';
import { AppError } from '../lib/errors.js';
import type { IdempotencyReceipt } from '../lib/idempotency.js';
import type { Logger } from '../lib/logger.js';
import {
  deleteActivity as deleteActivityRows,
  getActivityMeta,
  getActivityPartition,
  listByBucket as listBucket,
  newActivityId,
  newReminderId,
  createActivity as putActivity,
  patchActivity as putPatch,
} from '../repositories/activityRepository.js';
import type { StoredItem } from '../repositories/migrate.js';
import { assertActivityAccess, assertPatchableFields } from './authz.js';

/**
 * The activity rules that must not live in a handler or a repository (P1-10).
 *
 * A rule in a handler is a rule the next endpoint re-derives slightly differently; a rule in
 * a repository is a rule that cannot be tested without a database. Both failure modes are
 * visible in the list below: `status` is derived identically for `POST` and `PATCH`, and the
 * reminder filter has to be provably correct before Phase 6 makes it load-bearing.
 *
 * **No AWS SDK type crosses into this layer and it knows nothing about HTTP.** Everything
 * here takes and returns domain values; the handler turns them into a response and the
 * repository turns them into items.
 */

/** Phase 1 rejects sharing rather than dropping it silently (P1-11). */
const SHARING_SOON = 'Sharing is coming soon.';

/**
 * Two levels: a plan, and its prep tasks (`plans-and-lists.md` §3). A third is refused rather
 * than flattened, because flattening would silently reparent somebody's task.
 */
const NESTING_CAP =
  'A prep task cannot have its own prep task. Add it to the plan instead.';

/**
 * The status a write produces (rule 1).
 *
 * **`status` is server-derived, with exactly one exception.** A client may say `cancelled`
 * and nothing else: `completed` and `skipped` come only from the Phase 2 completion
 * endpoints, and letting a client patch either would make "done" a claim rather than a
 * record. Everything else falls out of whether a date is committed — which is the whole
 * scheduling model, since a date changes an activity's scheduling state and not its identity
 * (`data-model.md` §1).
 *
 * Pure, and shared by `POST` (P1-11) and `PATCH` (P1-13) so the two cannot disagree about
 * what clearing a date means.
 */
export function deriveStatus(
  schedule: { date?: string } | undefined,
  requested?: ActivityStatus,
): ActivityStatus {
  if (requested === 'cancelled') return 'cancelled';
  return schedule?.date === undefined ? 'saved' : 'scheduled';
}

/**
 * The wall-clock half of a schedule, as a **client** may send it.
 *
 * Spelled out rather than `Pick`ed from `ActivitySchedule` because of
 * `exactOptionalPropertyTypes`: a Zod-inferred optional is `string | undefined` and a domain
 * optional is `string?`, and those are different types on purpose — "absent" and "explicitly
 * undefined" are the same thing to a user and different things to `Object.entries`. This is
 * the input shape, so it accepts both; {@link toSchedule} is where the two converge.
 */
export interface WallClockSchedule {
  date: string;
  time?: string | undefined;
  endTime?: string | undefined;
  timezone: string;
}

/**
 * The absolute instants behind a wall-clock schedule (rule 3).
 *
 * `date` + `time` + `timezone` are the stored truth and this is **derived**, recomputed on
 * every schedule write and never authoritative over the three fields it came from
 * (`data-model.md` §4.1). A user who moves to another zone keeps "6 PM" meaning 6 PM; the
 * instant is what the reminder scheduler and the `.ics` export need, and it is regenerated
 * rather than migrated.
 *
 * **Absent for an all-day activity**, deliberately. A date with no time has no instant — any
 * instant this returned would be an invention (midnight? 9am? whose 9am?), and
 * `notifications.md` gives the user an `allDayReminderHour` precisely because the product
 * makes that choice visibly rather than in a derivation.
 *
 * `fromZonedTime` reads the zone's real offset for that date, so a time on the far side of a
 * DST boundary converts with the offset in force **then** rather than the one in force today.
 * That is the single reason this is `date-fns-tz` and not arithmetic on a UTC millisecond
 * count (`tech-stack.md`, `data-model.md` §6).
 */
export function deriveScheduleInstants(
  schedule: WallClockSchedule,
): Pick<ActivitySchedule, 'scheduledAtUtc' | 'endAtUtc'> {
  if (schedule.time === undefined) return {};

  return {
    scheduledAtUtc: toUtcInstant(schedule.date, schedule.time, schedule.timezone),
    ...(schedule.endTime === undefined
      ? {}
      : {
          endAtUtc: toUtcInstant(schedule.date, schedule.endTime, schedule.timezone),
        }),
  };
}

/**
 * The stored schedule: the caller's wall-clock fields plus the derived instants.
 *
 * Built field by field rather than spread, so an optional the client sent as an explicit
 * `undefined` is **omitted** rather than stored as a null attribute — DynamoDB would keep it,
 * and every later reader would have to tell "no time" from "a time that is null".
 */
export function toSchedule(schedule: WallClockSchedule): ActivitySchedule {
  return {
    date: schedule.date,
    ...(schedule.time === undefined ? {} : { time: schedule.time }),
    ...(schedule.endTime === undefined ? {} : { endTime: schedule.endTime }),
    timezone: schedule.timezone,
    ...deriveScheduleInstants(schedule),
  };
}

/**
 * Refuses a third level of nesting, and refuses it by **loading the parent** (rule 5).
 *
 * The load is not wasted: `assertActivityAccess` is the check that a stranger cannot discover
 * an activity by guessing its id and attaching a child to it, and it returns the row the cap
 * needs. One call does both.
 *
 * `write` rather than `owner`, because a prep task is an item on a shared checklist rather
 * than a statement about the plan's outcome (`plans-and-lists.md` §3, ADR-051). Worth
 * flagging for Phase 6: `api-contract.md` §3 enumerates a participant's prep-task rights as
 * *complete, uncomplete and edit* and does not say **create**. Nothing can exercise the
 * difference until participants exist, and the shared-checklist reading is the consistent
 * one, but it should be confirmed rather than inherited from this comment.
 */
async function assertCanParent(userId: string, parentActivityId: string): Promise<void> {
  const { activity: parent } = await assertActivityAccess(
    userId,
    parentActivityId,
    'write',
  );

  if (parent.parentActivityId !== undefined) {
    throw new AppError('validation_failed', NESTING_CAP, [
      { path: 'parentActivityId', message: NESTING_CAP },
    ]);
  }
}

export interface CreateResult {
  readonly activity: Activity;
  /** The creator's own reminder rows, as written. Never anybody else's — see {@link projectDetail}. */
  readonly reminders: readonly Reminder[];
}

const RECURRENCE_NEEDS_DATE = 'Repeat needs a scheduled date.';
const RECURRENCE_CREATE_ONE = 'A new recurrence must contain exactly one segment.';
const RECURRENCE_APPEND_ONLY =
  'Recurrence history is append-only. Existing segments cannot be changed or removed.';
const EDIT_DATE_NEEDS_APPEND = 'editedFromDate requires a recurrence segment append.';

function recurrenceFailure(message: string, path = 'recurrence'): never {
  throw new AppError('validation_failed', message, [{ path, message }]);
}

function serverSegment(
  segment: RecurrenceSegment,
  effectiveFrom: string,
  timeSource: Pick<RecurrenceSegment, 'time' | 'endTime'>,
): RecurrenceSegment {
  return {
    freq: segment.freq,
    ...(segment.interval === undefined ? {} : { interval: segment.interval }),
    ...(segment.byWeekday === undefined ? {} : { byWeekday: segment.byWeekday }),
    ...(segment.byMonthDay === undefined ? {} : { byMonthDay: segment.byMonthDay }),
    ...(segment.byMonth === undefined ? {} : { byMonth: segment.byMonth }),
    ...(segment.rrule === undefined ? {} : { rrule: segment.rrule }),
    effectiveFrom,
    ...(timeSource.time === undefined ? {} : { time: timeSource.time }),
    ...(timeSource.endTime === undefined ? {} : { endTime: timeSource.endTime }),
  };
}

function validateRecurrence(candidate: Recurrence): Recurrence {
  const result = recurrenceSchema.safeParse(candidate);
  if (result.success) return result.data;

  const details = result.error.issues.map((issue) => ({
    path: ['recurrence', ...issue.path].map(String).join('.'),
    message: issue.message,
  }));
  throw new AppError(
    'validation_failed',
    details[0]?.message ?? 'The recurrence is invalid.',
    details,
  );
}

function recurrenceForCreate(
  supplied: Recurrence | undefined,
  schedule: ActivitySchedule | undefined,
): Recurrence | undefined {
  if (supplied === undefined) return undefined;
  if (schedule === undefined) recurrenceFailure(RECURRENCE_NEEDS_DATE);
  if (supplied.segments.length !== 1) recurrenceFailure(RECURRENCE_CREATE_ONE);

  const first = supplied.segments[0];
  if (first === undefined) recurrenceFailure(RECURRENCE_CREATE_ONE);
  return validateRecurrence({
    mode: supplied.mode,
    segments: [serverSegment(first, schedule.date, schedule)],
    ...(supplied.endDate === undefined ? {} : { endDate: supplied.endDate }),
    ...(supplied.count === undefined ? {} : { count: supplied.count }),
  });
}

/**
 * Creates an activity from a validated input, and returns what was stored.
 *
 * ## What this decides, and what it refuses to decide
 *
 * It derives `status`, `scheduledAtUtc`, `visibility`, the counters and the timestamps. It
 * decides **nothing** about the target: `objectKind` and `type` arrive as a valid pair from
 * the caller's explicit choice and are copied through untouched. There is no default, no
 * classification branch and no recovery path — a body that did not carry a complete pair
 * never reaches here, because the schema is a discriminated union (`CLAUDE.md` rule 2,
 * P1-11).
 *
 * `visibility` starts `private` (rule 4) and there is no argument that can change it: it
 * becomes `shared` only when a user explicitly adds a participant, which is Phase 6. It is
 * **not** derived from `participantCount` — removing the last participant leaves a plan
 * `shared`, because it was shared and that is a fact about what happened rather than a
 * count.
 *
 * `now` is a parameter, so every derived timestamp is assertable without freezing the clock
 * (`coding-standards.md` §4.3).
 */
export async function createActivity(
  userId: string,
  input: CreateActivityInput,
  now: string,
  receiptFor?: (result: CreateResult) => IdempotencyReceipt,
): Promise<CreateResult> {
  if (input.objectKind === 'plan' && (input.participants?.length ?? 0) > 0) {
    throw new AppError('validation_failed', SHARING_SOON, [
      { path: 'participants', message: SHARING_SOON },
    ]);
  }

  if (input.parentActivityId !== undefined) {
    await assertCanParent(userId, input.parentActivityId);
  }

  const schedule = input.schedule === undefined ? undefined : toSchedule(input.schedule);
  const storedRecurrence = recurrenceForCreate(input.recurrence, schedule);
  const reminderInputs = reminderInputsForSchedule(schedule).parse(input.reminders ?? []);

  const activity: Activity = {
    activityId: newActivityId(),
    ownerId: userId,
    status: deriveStatus(input.schedule),
    objectKind: input.objectKind,
    type: input.type,
    title: input.title,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(schedule === undefined ? {} : { schedule }),
    ...(storedRecurrence === undefined ? {} : { recurrence: storedRecurrence }),
    ...(input.location === undefined ? {} : { location: input.location }),
    ...(input.parentActivityId === undefined
      ? {}
      : { parentActivityId: input.parentActivityId }),
    ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
    /**
     * `details` mirrors `type` and the schema has already refused any pair that disagrees.
     * An omitted `details` becomes the empty variant for the chosen type rather than being
     * left absent, because `Activity.details` is required — every later reader can switch on
     * `details.kind` without first asking whether there is one.
     */
    details: input.details ?? { kind: input.type },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: now,
    lastActivityAt: now,
    updatedAt: now,
    schemaVersion: 1,
  } as Activity;

  /**
   * Reminders belong to the **creator alone**, and there is no path in this phase or any
   * later one by which one user's create writes a reminder for another — a joiner's comes
   * from their own saved default at join time (P6-13, ADR-047).
   */
  const reminders: Reminder[] = reminderInputs.map((entry) => ({
    reminderId: newReminderId(),
    activityId: activity.activityId,
    userId,
    offsetMinutes: entry.offsetMinutes,
    channel: 'push',
  }));

  const result = { activity, reminders };
  await putActivity(userId, activity, {
    reminders: reminders.map((row) => ({
      reminderId: row.reminderId,
      offsetMinutes: row.offsetMinutes,
    })),
    ...(receiptFor === undefined ? {} : { idempotencyReceipt: receiptFor(result) }),
  });

  return result;
}

/** The stale-edit answer, and the one place its copy lives. */
const STALE = 'This changed while you were editing it. Review the update.';

/**
 * The `409` a stale `If-Match` produces, **carrying the current `updatedAt`**.
 *
 * P1-13 requires the current value in the body so the client can refetch and re-apply rather
 * than guess. It travels in `details[]` — the envelope's only structured slot — as the field
 * name and its value, which keeps the closed error shape intact rather than adding a key to
 * it that every other error would then lack.
 */
function staleEdit(currentUpdatedAt: string): AppError {
  return new AppError('conflict', STALE, [
    { path: 'updatedAt', message: currentUpdatedAt },
  ]);
}

/**
 * Applies a kind change, or returns the activity's current target unchanged.
 *
 * The mapping itself is `changeActivityKind` in `packages/shared` (P1-17) — the same function
 * the client runs to render the "this will remove" confirmation **before** calling, which is
 * the whole reason it is not implemented here. Two implementations would mean a user
 * confirming the loss of one set of fields and losing another.
 *
 * A blocked conversion is `409` naming what must go first, and **nothing is written**: the
 * conversion "never deletes coordinated data as a side effect" (`activities.md` §6.3 point 3).
 *
 * The dropped payload is logged at `info` with the activity id, the old target and the old
 * `details`, so a support request can recover it from the logs inside the retention window.
 * It is not restorable through the UI (§6.3 point 7).
 */
function applyKindChange(
  current: Activity,
  patch: PatchActivityInput,
  log: Logger | undefined,
): ChangeResult | undefined {
  if (patch.objectKind === undefined || patch.type === undefined) return undefined;

  const change = changeActivityKind(current, {
    objectKind: patch.objectKind,
    type: patch.type,
  } as ChangeTarget);

  if (change.blockers.length > 0) {
    throw new AppError(
      'conflict',
      blockerMessage(change.blockers) ?? STALE,
      change.blockers.map((blocker) => ({
        path: blocker.section,
        message: blocker.label,
      })),
    );
  }

  if (change.dropped.length > 0) {
    /**
     * The **old `details` object itself**, not a summary of it. A support request asking
     * "what was the episode number" can only be answered from the payload, and this is the
     * only place it survives. `details` is type-specific user content and is redacted from
     * ordinary request logging; this line is the deliberate exception §6.3 point 7 asks for,
     * and it is why the event code is greppable.
     */
    log?.info(
      {
        event: KIND_CHANGED,
        activityId: current.activityId,
        from: { objectKind: current.objectKind, type: current.type },
        to: { objectKind: change.objectKind, type: change.type },
        droppedDetails: current.details,
        dropped: change.dropped.map((field) => field.key),
      },
      'activity kind changed; the dropped details payload is in this line and nowhere else',
    );
  }

  return change;
}

/** A stable event code a Log Insights query can filter on (`definition-of-done.md` §8 rule 2). */
const KIND_CHANGED = 'activity_kind_changed';

function seriesLevel(supplied: Recurrence, segments: RecurrenceSegment[]): Recurrence {
  return {
    mode: supplied.mode,
    segments,
    ...(supplied.endDate === undefined ? {} : { endDate: supplied.endDate }),
    ...(supplied.count === undefined ? {} : { count: supplied.count }),
  };
}

function recurrenceForPatch(
  current: Activity,
  patch: PatchActivityInput,
  schedule: ActivitySchedule | undefined,
  now: string,
): Recurrence | null | undefined {
  if (patch.recurrence === undefined) {
    if (patch.editedFromDate !== undefined) {
      recurrenceFailure(EDIT_DATE_NEEDS_APPEND, 'editedFromDate');
    }
    return undefined;
  }
  if (patch.recurrence === null) {
    if (patch.editedFromDate !== undefined) {
      recurrenceFailure(EDIT_DATE_NEEDS_APPEND, 'editedFromDate');
    }
    return null;
  }
  if (schedule === undefined) recurrenceFailure(RECURRENCE_NEEDS_DATE);

  const supplied = patch.recurrence;
  const stored = current.recurrence;
  if (stored === undefined) {
    if (patch.editedFromDate !== undefined) {
      recurrenceFailure(
        'editedFromDate can only target an occurrence of an existing series.',
        'editedFromDate',
      );
    }
    if (supplied.segments.length !== 1) recurrenceFailure(RECURRENCE_CREATE_ONE);
    const first = supplied.segments[0];
    if (first === undefined) recurrenceFailure(RECURRENCE_CREATE_ONE);
    return validateRecurrence(
      seriesLevel(supplied, [serverSegment(first, schedule.date, schedule)]),
    );
  }

  const oldCount = stored.segments.length;
  if (supplied.segments.length < oldCount || supplied.segments.length > oldCount + 1) {
    recurrenceFailure(RECURRENCE_APPEND_ONLY);
  }
  for (const [index, oldSegment] of stored.segments.entries()) {
    if (!isDeepStrictEqual(supplied.segments[index], oldSegment)) {
      recurrenceFailure(RECURRENCE_APPEND_ONLY, `recurrence.segments.${index}`);
    }
  }

  if (supplied.segments.length === oldCount) {
    if (patch.editedFromDate !== undefined) {
      recurrenceFailure(EDIT_DATE_NEEDS_APPEND, 'editedFromDate');
    }
    return validateRecurrence(seriesLevel(supplied, stored.segments));
  }

  const incoming = supplied.segments[oldCount];
  if (incoming === undefined) recurrenceFailure(RECURRENCE_APPEND_ONLY);
  const anchor =
    patch.editedFromDate ??
    formatInTimeZone(new Date(now), schedule.timezone, 'yyyy-MM-dd');

  if (
    patch.editedFromDate !== undefined &&
    !expandRecurrence(
      stored,
      patch.editedFromDate,
      patch.editedFromDate,
      schedule.timezone,
    ).includes(patch.editedFromDate)
  ) {
    recurrenceFailure(
      'editedFromDate must be an occurrence emitted by the current active rule.',
      'editedFromDate',
    );
  }

  return validateRecurrence(
    seriesLevel(supplied, [
      ...stored.segments,
      // P2-26's all-future reschedule carries the new active time on the appended segment.
      // Existing history stays byte-identical; the active schedule mirror is updated below.
      serverSegment(incoming, anchor, {
        ...((incoming.time ?? schedule.time) === undefined
          ? {}
          : { time: incoming.time ?? schedule.time }),
        ...((incoming.endTime ?? schedule.endTime) === undefined
          ? {}
          : { endTime: incoming.endTime ?? schedule.endTime }),
      }),
    ]),
  );
}

/**
 * Applies a validated patch, behind `PATCH /v1/activities/:id` (P1-13).
 *
 * ## `If-Match` is checked twice, and both are load-bearing
 *
 * The **first** check compares the header against the row `assertActivityAccess` just read,
 * so an ordinary stale edit answers `409` before anything is composed. The **second** is the
 * repository's conditional write, which is what makes the guarantee real: between this
 * service reading and writing, another request can land, and only the condition on the item
 * itself closes that window. A read-then-write with no condition would pass the first check
 * and silently overwrite — which is exactly the failure P1-13 says not to build.
 *
 * When the conditional write is the one that fails, the value read here is by definition no
 * longer current, so the row is re-read to report a value that actually is. One extra
 * `GetItem`, on a path that is a genuine race rather than an ordinary stale tab.
 *
 * ## What a patch may not touch
 *
 * `status`, `completedAt` and `outcome` survive a kind change untouched (§6.3 point 8) — an
 * an attended `event` that becomes another kind stays completed with
 * `outcome: 'attended'`. They are carried from the current row rather than recomputed,
 * except that clearing the schedule returns a non-terminal activity to `saved`.
 *
 * `ownerId`, `activityId`, the counters and `createdAt` are not in the input schema at all,
 * so there is nothing here to defend against.
 */
export async function patchActivity(
  userId: string,
  activityId: string,
  patch: PatchActivityInput,
  ifMatch: string,
  now: string,
  log?: Logger,
): Promise<Activity> {
  const access = await assertActivityAccess(userId, activityId, 'write');
  assertPatchableFields(access, patch);

  const current = access.activity;
  if (current.updatedAt !== ifMatch) throw staleEdit(String(current.updatedAt));

  const change = applyKindChange(current, patch, log);
  const next = merge(current, patch, change, now);
  const parent =
    next.parentActivityId !== undefined
      ? await getActivityMeta(next.parentActivityId)
      : undefined;
  const updatesExistingChildPointer =
    current.parentActivityId !== undefined &&
    current.parentActivityId === next.parentActivityId &&
    current.title !== next.title;

  try {
    await putPatch(userId, next, ifMatch, {
      previous: current,
      ...(parent === undefined ? {} : { taskSubtitle: parent.title }),
      ...(updatesExistingChildPointer ? { updateChildPointer: true } : {}),
    });
  } catch (error) {
    if (error instanceof AppError && error.code === 'conflict') {
      const fresh = await getActivityMeta(activityId);
      throw staleEdit(String(fresh?.updatedAt ?? current.updatedAt));
    }
    throw error;
  }

  /**
   * **Projected on the way out, not on the way in.**
   *
   * `current` is the row the repository read, so it carries `pk`, `sk`, `entity` and every
   * storage attribute — and `merge` spreads it, so `next` carries them too. That is right for
   * the *write*: those attributes must survive a patch, including fields this projection
   * deliberately withholds from clients (`listId`, `listItemId` — see {@link toActivity}).
   * Writing the projection instead would quietly delete them.
   *
   * It is wrong for the *response*, which is why the same allow-list `GET` uses runs here.
   * Caught by a route test asserting the body has no `pk`, which the first version failed.
   */
  return toActivity(next as unknown as StoredItem);
}

/**
 * The patched activity, built field by field.
 *
 * ## Why the explicit patch wins over the kind change
 *
 * A conversion can produce `notes`, `location` and `details` of its own — an Event's
 * description is appended to notes when leaving the kind. If the
 * same request also names one of those fields, **the request wins outright**. The client has
 * already run the same mapping to render the confirmation, so the value it sends is the
 * post-change value the user just saw and approved; applying the append on top of it would
 * duplicate the text the user is looking at.
 *
 * ## `null` clears, absent leaves alone
 *
 * The distinction `exactOptionalPropertyTypes` exists to keep. `schedule: null` is the
 * unschedule path and returns the activity to `saved`; `schedule` absent means "leave it".
 */
function merge(
  current: Activity,
  patch: PatchActivityInput,
  change: ChangeResult | undefined,
  now: string,
): Activity {
  const base = change === undefined ? current : { ...current, ...targetOf(change) };

  /**
   * Three states, and each means something different.
   *
   * Absent leaves the schedule alone. `null` unschedules entirely and returns the activity to
   * `saved`. An object replaces it — and **inside** it, `time: null` clears the time while
   * keeping the date, which is how a timed activity becomes all-day. `toSchedule` derives the
   * instants from whatever survives, so an all-day result correctly has none.
   */
  const schedule = base.schedule;
  const recurrenceUpdate = recurrenceForPatch(current, patch, schedule, now);
  const appendedSegment =
    schedule !== undefined &&
    current.recurrence !== undefined &&
    recurrenceUpdate !== undefined &&
    recurrenceUpdate !== null &&
    recurrenceUpdate.segments.length === current.recurrence.segments.length + 1
      ? recurrenceUpdate.segments.at(-1)
      : undefined;
  const activeSchedule =
    schedule === undefined || appendedSegment === undefined
      ? schedule
      : toSchedule({
          date: schedule.date,
          timezone: schedule.timezone,
          ...(appendedSegment.time === undefined ? {} : { time: appendedSegment.time }),
          ...(appendedSegment.endTime === undefined
            ? {}
            : { endTime: appendedSegment.endTime }),
        });
  const scheduleTimeChanged =
    appendedSegment !== undefined &&
    (schedule?.time !== activeSchedule?.time ||
      schedule?.endTime !== activeSchedule?.endTime);

  const next: Record<string, unknown> = {
    ...base,
    ...pick(patch, 'title', 'notes', 'details'),
    ...(recurrenceUpdate == null ? {} : { recurrence: recurrenceUpdate }),
    ...nullable(patch, 'location', 'sourceUrl', 'parentActivityId'),
    ...(activeSchedule === undefined ? {} : { schedule: activeSchedule }),
    /**
     * Re-derived rather than carried, because clearing a date is a scheduling-state change:
     * an activity with no date is `saved`. `cancelled` from the client and the two terminal
     * statuses survive, which is what `deriveStatus` already encodes.
     */
    status: terminal(base.status) ? base.status : (patch.status ?? base.status),
    icsSequence: base.icsSequence + (scheduleTimeChanged ? 1 : 0),
    updatedAt: now,
  };

  if (recurrenceUpdate === null) delete next.recurrence;
  for (const field of ['location', 'sourceUrl', 'parentActivityId'] as const) {
    if (patch[field] === null) delete next[field];
  }

  /**
   * The one cast in this function. `Activity` is a discriminated union on `objectKind`, and a
   * record built by spreading cannot be narrowed back into it structurally — but every field
   * came from an `Activity` or from a schema-validated patch, and the `objectKind`/`type`
   * pair came from `changeActivityKind`, which only produces valid pairs.
   */
  return next as unknown as Activity;
}

/** `completed` and `skipped` are Phase 2's to set and nothing here may move them. */
function terminal(status: Activity['status']): boolean {
  return status === 'completed' || status === 'skipped';
}

/** The three fields a kind change replaces. Everything else on the activity survives it. */
function targetOf(change: ChangeResult) {
  return {
    objectKind: change.objectKind,
    type: change.type,
    details: change.details,
    ...(change.notes === undefined ? {} : { notes: change.notes }),
    ...(change.location === undefined ? {} : { location: change.location }),
  };
}

/** Present, non-null keys only — so an absent optional never lands as an explicit undefined. */
function pick<K extends keyof PatchActivityInput>(
  patch: PatchActivityInput,
  ...fields: K[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = patch[field];
    if (value !== undefined && value !== null) out[field] = value;
  }
  return out;
}

/** The same, for fields whose `null` means "clear it" — the delete happens in {@link merge}. */
function nullable<K extends keyof PatchActivityInput>(
  patch: PatchActivityInput,
  ...fields: K[]
): Record<string, unknown> {
  return pick(patch, ...fields);
}

/**
 * Which bucket each stage reads, and in which direction (`api-contract.md` §2.2a).
 *
 * Transcribed from the stage table rather than derived, and **one bucket per filter** —
 * that is what lets a page be one Query with one cursor. A filter spanning two partitions
 * would need a composite cursor no document defines.
 *
 * `fromToday` splits the `#S` bucket: `after` takes today and everything later, `before`
 * takes everything earlier. The pivot is the plain date string, which sorts **before** every
 * key on that date — a `gsi1sk` is `<date>T<time>#<id>`, so `2026-08-09` precedes
 * `2026-08-09T00:00#…`. That is what makes "before today" exclude today without any date
 * arithmetic, and "from today forward" include it.
 */
const STAGES = {
  upcoming: { bucket: 'S', ascending: true, window: 'after' },
  past: { bucket: 'S', ascending: false, window: 'before' },
  /** Access pattern 2b: the plan being discussed floats up, not the oldest. */
  needs_date: { bucket: 'P', ascending: false, window: 'none' },
  /**
   * Newest first. §2.2a gives an order for the other three and none for this one; the
   * sibling undated bucket is newest-first, and a backlog whose oldest entries surface first
   * is the "queue to be drained" posture `decisions.md` rejects. Called out because it is a
   * choice rather than a transcription.
   */
  saved: { bucket: 'N', ascending: false, window: 'none' },
} as const satisfies Record<
  ActivityFilter,
  { bucket: Gsi1Bucket; ascending: boolean; window: 'after' | 'before' | 'none' }
>;

/** The widest bounds a `gsi1sk` can take, so a one-sided window is still a `BETWEEN`. */
const FIRST_KEY = '0000-01-01';
const LAST_KEY = '9999-12-31';

export interface ActivityPage {
  readonly items: readonly ActivityListItem[];
  readonly nextCursor?: string;
}

/**
 * A flat, paginated stage of activities, behind `GET /v1/activities?filter=` (P1-16).
 *
 * ## It reads the index, and returns what the index holds
 *
 * Every row comes from one index entry in the user's own partition, which exists precisely so
 * a feed does not have to load an activity per row. The response is that projection — see
 * {@link ActivityListItem} for why it is deliberately not `AgendaItem`.
 *
 * **Nothing is expanded here.** A recurring series is one row carrying `isRecurring`, not one
 * row per occurrence: expansion is the agenda's job and this endpoint is "not for Today" in
 * the contract's own words (`CLAUDE.md` rule 3).
 *
 * ## `type` narrows the page, not the query
 *
 * DynamoDB cannot filter a GSI on a non-key attribute without reading the page first, so
 * `type` is applied to the rows the Query returned. A page can therefore come back **shorter
 * than `limit`, or empty, while `nextCursor` is still set** — which is normal for a cursor
 * API and is why the client must page until the cursor is absent rather than until a page is
 * short. Stated here because it is the one surprising thing about this endpoint.
 *
 * `today` is a parameter, not a clock read: which activities are "upcoming" depends on the
 * caller's date, and a service that read the clock could not be tested across a boundary
 * (`coding-standards.md` §4.3).
 */
export async function listActivities(
  userId: string,
  query: ActivityListQuery,
  today: string,
): Promise<ActivityPage> {
  const stage = STAGES[query.filter];

  const page = await listBucket(userId, stage.bucket, {
    ascending: stage.ascending,
    ...(stage.window === 'none'
      ? {}
      : {
          between:
            stage.window === 'after'
              ? ([today, LAST_KEY] as const)
              : ([FIRST_KEY, today] as const),
        }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    limit: query.limit ?? DEFAULT_PAGE_SIZE,
  });

  const items = page.items
    .filter((row) => query.type === undefined || row.type === query.type)
    .map(toListItem);

  return {
    items,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

/** `api-contract.md` §1: default 50, max 200. The max is enforced by the query schema. */
const DEFAULT_PAGE_SIZE = 50;

/**
 * One index row, field by field — the same rule as every other projection here. An index
 * entry carries `pk`, `sk`, `entity` and its two GSI attributes alongside the display fields,
 * and none of those belong in a response (`agent-playbook.md` §6.11).
 */
function toListItem(row: StoredItem): ActivityListItem {
  const stored = row as ActivityListItem & StoredItem;

  return {
    activityId: stored.activityId,
    type: stored.type,
    title: stored.title,
    status: stored.status,
    ...(stored.time === undefined ? {} : { time: stored.time }),
    ...(stored.endTime === undefined ? {} : { endTime: stored.endTime }),
    isRecurring: stored.isRecurring === true,
    participantCount: stored.participantCount ?? 0,
    ...(stored.locationLabel === undefined
      ? {}
      : { locationLabel: stored.locationLabel }),
    ...(stored.subtitle === undefined ? {} : { subtitle: stored.subtitle }),
  };
}

/** The suffix `activities.md` §7.1 specifies, so the copy is distinguishable at a glance. */
const COPY_SUFFIX = ' (copy)';

/**
 * `<title> (copy)`, trimmed to fit.
 *
 * A 200-character title plus the suffix is 207 and the schema's bound is 200, so the copy of
 * a maximum-length activity would be unsaveable. The base is truncated rather than the suffix
 * dropped: the suffix is what tells the user which one is the copy, and losing the tail of a
 * long title is the smaller loss. No doc covers this; it is called out here and in the commit
 * because it is a choice rather than a transcription.
 */
function copyTitle(title: string): string {
  const room = MAX_TITLE_LEN - COPY_SUFFIX.length;
  return `${title.length <= room ? title : title.slice(0, room).trimEnd()}${COPY_SUFFIX}`;
}

/**
 * Copies an activity, behind `POST /v1/activities/:id/duplicate` (P1-15).
 *
 * ## What is copied, and what deliberately is not
 *
 * `activities.md` §7.1 is exhaustive: `objectKind`, `title`, `type`, `details`, `location` and
 * `notes`. Everything else is left behind, and the two decisions there say why it is a
 * decision rather than an omission.
 *
 * **Participants are dropped** because re-inviting people is a deliberate act, and silently
 * re-inviting on duplicate would send unexpected notifications to people who were never asked.
 *
 * **Reminders, prep children and lists are dropped** (decision 2026-08-07). A reminder is an
 * offset from a schedule and the copy has no schedule, so copying them would produce a
 * reminder in a dateless state the UI itself forbids. Prep children and lists "are structure,
 * not content, and copying them would quietly multiply real to-dos and list rows, which is
 * auto-creation by another name" — the principle in `overview.md` §4.4, applied to a feature
 * that looks harmless.
 *
 * `recurrence`, `sourceUrl`, `parentActivityId` and the list pointers are not on the copy list
 * either, so they do not survive. A recurrence with no schedule would be a series with no
 * anchor; a `parentActivityId` would make the copy a second prep task on somebody's plan,
 * which is the prep-children rule arriving from the other direction.
 *
 * ## Who may duplicate
 *
 * `read`. The copy belongs to the **caller**, carries no participants and has no relationship
 * to the original, so copying something you can see costs its owner nothing. `api-contract.md`
 * §2.3 leaves this row's notes empty — unlike `DELETE`, which it marks owner-only — so this is
 * the reading rather than a transcription, and it is flagged in the pull request.
 */
export async function duplicateActivity(
  userId: string,
  activityId: string,
  now: string,
  receiptFor?: (activity: Activity) => IdempotencyReceipt,
): Promise<Activity> {
  const { activity: source } = await assertActivityAccess(userId, activityId, 'read');

  const copy: Activity = {
    activityId: newActivityId(),
    /** The **caller** owns the copy, not whoever owned the original. */
    ownerId: userId,
    /** No schedule, so `saved` — and completion state is not copied, so never terminal. */
    status: 'saved',
    objectKind: source.objectKind,
    type: source.type,
    title: copyTitle(source.title),
    ...(source.notes === undefined ? {} : { notes: source.notes }),
    ...(source.location === undefined ? {} : { location: source.location }),
    details: source.details,
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: now,
    lastActivityAt: now,
    updatedAt: now,
    schemaVersion: 1,
  } as Activity;

  // No `reminders` option: the copy has no schedule to offset one from.
  await putActivity(userId, copy, {
    ...(receiptFor === undefined ? {} : { idempotencyReceipt: receiptFor(copy) }),
  });

  return copy;
}

/**
 * Deletes an activity and everything that belongs to it, behind
 * `DELETE /v1/activities/:id` (P1-14).
 *
 * ## Owner only, and a stranger cannot tell the difference
 *
 * `owner`, so a participant reaching for it gets `403` — they can see the plan and are being
 * told they may not delete it — and anyone else gets `404`, which is also the answer for an
 * activity that never existed.
 *
 * ## What survives, and why the order matters
 *
 * **Prep tasks are not deleted.** Their `parentActivityId` is cleared and they become
 * ordinary tasks (`today-and-tasks.md` §5.5): "a user who cancels a trip may still need to
 * return the rental car", and cascade-deleting somebody's real to-dos because the container
 * went away is the data loss that ends trust in a planner.
 *
 * The children are cleared **before** the parent is removed. If a clear fails, the parent is
 * still there and the whole operation can be retried from a consistent state; the other order
 * would leave a prep task pointing at an activity that no longer exists, which nothing would
 * ever fix. Each clear is conditional on the child's own `updatedAt`, so a prep task being
 * edited at the same moment fails the delete rather than silently losing that edit — the
 * caller retries.
 *
 * ## Not atomic, and deliberately
 *
 * A partition with many participants and many updates exceeds a transaction's 100 items, so
 * the removal batches instead. A partially deleted activity is recoverable by re-running the
 * delete; a transaction that can never succeed is not (P1-14). That is why this is safe to
 * call twice — the second call finds nothing and answers `404`.
 *
 * ## What this phase cannot cascade yet
 *
 * List links (Phase 3), Expense locators (Phase 7) and EventBridge schedules (Phase 5) have
 * no rows to delete, because nothing writes them yet. **There is no settlement guard here**
 * and `settlement_conflict` is deliberately not in the error union: a guard over rows no
 * schema defines reads as an implemented control and is none. P7-08 owns it, and nothing
 * before P7-08 writes an Expense (P1-14's decision note).
 */
export async function removeActivity(
  userId: string,
  activityId: string,
  now: string,
): Promise<string> {
  await assertActivityAccess(userId, activityId, 'owner');

  const partition = await getActivityPartition(activityId);

  await releaseChildren(childIdsOf(partition), now);
  await deleteActivityRows(userId, activityId, { partition });

  return activityId;
}

/**
 * The prep tasks hanging off this plan, from the pointers already in the partition.
 *
 * Read from `SUB#` rows rather than by querying for activities with this parent, because the
 * pointers exist precisely so a plan's children come from the same single `Query` as
 * everything else (`data-model.md` §3.1) — and because there is no index that answers "every
 * activity whose `parentActivityId` is X" without a `Scan`.
 */
function childIdsOf(partition: readonly StoredItem[]): string[] {
  return partition
    .filter((row) => row.entity === 'ChildPointer')
    .map((row) => String(row.childActivityId));
}

/**
 * Clears `parentActivityId` on each prep task, so it survives as an ordinary task.
 *
 * A child that has already gone, or that has been re-parented since the pointer was written,
 * is skipped rather than treated as a failure: the pointer is a denormalised copy and this
 * runs on a retry path, so finding it stale is expected rather than exceptional.
 *
 * Rewriting the child through `patchActivity` also rebuilds its index entry, which is what
 * drops the **subtitle** — a prep task renders with its parent's title under it on Today, and
 * that title is about to stop existing.
 */
async function releaseChildren(childIds: readonly string[], now: string): Promise<void> {
  for (const childId of childIds) {
    const child = await getActivityMeta(childId);
    if (child === undefined || child.parentActivityId === undefined) continue;

    const { parentActivityId: _dropped, ...released } = child as Activity &
      Record<string, unknown>;

    await putPatch(
      child.ownerId,
      { ...released, updatedAt: now } as unknown as Activity,
      String(child.updatedAt),
      { previous: child },
    );
  }
}

/**
 * One activity and the caller's own reminders, behind `GET /v1/activities/:id` (P1-12).
 *
 * ## Two reads, deliberately
 *
 * `assertActivityAccess` does its own `GetItem` and the partition `Query` that follows
 * returns the canonical row again. One read could serve both — the `Query` already carries
 * the row the owner check needs and the participant rows the fallback needs — but taking it
 * would mean a **second implementation of the authorisation rules**, in the one place where
 * the projection is most tempting to hand-roll. P1-10 rule 2 says the check is called at the
 * top of every activity-scoped service method, and one extra `GetItem` is the price of that
 * being literally true. Two round trips, against a budget of three
 * (`definition-of-done.md` §6).
 *
 * `read`, so a participant may see a plan they are on and a participant of a parent may see
 * its prep task. A caller with no relationship gets `not_found`, never `403`.
 */
export async function getActivityDetail(
  userId: string,
  activityId: string,
): Promise<ActivityDetail> {
  await assertActivityAccess(userId, activityId, 'read');

  return projectDetail(await getActivityPartition(activityId), userId);
}

/**
 * The client-facing projection of one activity's partition — **and the caller-scoped reminder
 * filter** (rule 6).
 *
 * ## Why the filter is here and not in the repository
 *
 * A reminder row is keyed by the user it belongs to, inside the activity partition that every
 * participant is allowed to read — so the single `Query` behind plan detail returns
 * *everybody's* reminders, and a handler that returned what it read would leak them
 * (`security-privacy.md` §1 row 15). A reminder is a statement about its owner's day: how
 * long they need to get there, that they want 90 minutes' warning for this person and none
 * for anyone else.
 *
 * The repository could have filtered, and deliberately does not: access pattern 4b, the Phase
 * 5 reminder scheduler, needs **every** reminder row from the same query, and a repository
 * that had already discarded them would force a second read of a partition it just loaded. So
 * one reader filters and one does not, and the difference is stated at the layer where it is
 * a policy rather than a storage concern. A future caller that needs the unfiltered set
 * cannot reach it by accident — it must call `getActivityPartition` by name.
 *
 * (The keys are described rather than written out because `check-forbidden.mjs`'s
 * `no-key-literals` rule matches quoted key prefixes anywhere outside the repository layer,
 * comments included — and nothing here is lost by describing them.)
 *
 * There is exactly one client-facing serialiser for an activity, so there is exactly one
 * place this can be forgotten.
 */
export function projectDetail(partition: StoredItem[], userId: string): ActivityDetail {
  const meta = partition.find((row) => row.sk === 'META');
  if (meta === undefined) throw new AppError('not_found', 'Activity not found.');

  return {
    activity: toActivity(meta),
    reminders: partition
      .filter((row) => isReminderRow(row) && row.userId === userId)
      .map(toReminder),
  };
}

/**
 * A reminder row, identified by its `entity` rather than by the shape of its sort key.
 *
 * Key strings are the repository's business (`coding-standards.md`, and the
 * `no-key-literals` check greps for them outside that layer), and `entity` is on every item
 * for exactly this: identifying a row in a partition that holds several kinds.
 */
function isReminderRow(row: StoredItem): boolean {
  return row.entity === 'Reminder';
}

/**
 * Both projections are built **field by field, never by spreading** — the same rule as
 * `toUser` and `toDevice`. A stored row carries `pk`, `sk` and `entity`, and every future
 * storage attribute arrives on it too (`agent-playbook.md` §6.11, `data-model.md` §8).
 *
 * ## `listId` and `listItemId` are deliberately absent
 *
 * `api-contract.md` §2.3 gates them: they are "included only when the caller also passes
 * `assertListAccess`; a Plan participant outside the list receives no reverse link." That
 * check is Phase 3 and does not exist, so the condition for including them cannot currently
 * be met — and a field whose gate is unimplemented is omitted, not emitted.
 *
 * Nothing is lost today: no Phase 1 activity can carry either field. `POST /v1/activities`
 * rejects both, and the only endpoint permitted to set them —
 * `POST /v1/lists/:id/items/:itemId/schedule` — arrives with lists in Phase 3. Adding the
 * lines now would mean Phase 3 inherits two fields already leaving the building unchecked,
 * which is the wrong direction for a default to point. **Phase 3 adds them back with the
 * access check, not before**, and the test below fails if they are added without it.
 */
function toActivity(row: StoredItem): Activity {
  const stored = row as Activity & StoredItem;

  return {
    activityId: stored.activityId,
    ownerId: stored.ownerId,
    status: stored.status,
    objectKind: stored.objectKind,
    type: stored.type,
    title: stored.title,
    ...(stored.notes === undefined ? {} : { notes: stored.notes }),
    ...(stored.schedule === undefined ? {} : { schedule: stored.schedule }),
    ...(stored.recurrence === undefined ? {} : { recurrence: stored.recurrence }),
    ...(stored.location === undefined ? {} : { location: stored.location }),
    ...(stored.parentActivityId === undefined
      ? {}
      : { parentActivityId: stored.parentActivityId }),
    // `listId` and `listItemId` are not projected — see the note above. Phase 3.
    ...(stored.sourceUrl === undefined ? {} : { sourceUrl: stored.sourceUrl }),
    ...(stored.primaryAttachmentId === undefined
      ? {}
      : { primaryAttachmentId: stored.primaryAttachmentId }),
    details: stored.details,
    participantCount: stored.participantCount,
    childCount: stored.childCount,
    expenseTotalCents: stored.expenseTotalCents,
    visibility: stored.visibility,
    ...(stored.completedAt === undefined ? {} : { completedAt: stored.completedAt }),
    ...(stored.snoozedUntil === undefined ? {} : { snoozedUntil: stored.snoozedUntil }),
    ...(stored.outcome === undefined ? {} : { outcome: stored.outcome }),
    icsSequence: stored.icsSequence,
    createdAt: stored.createdAt,
    lastActivityAt: stored.lastActivityAt,
    updatedAt: stored.updatedAt,
    schemaVersion: stored.schemaVersion,
  } as Activity;
}

function toReminder(row: StoredItem): Reminder {
  const stored = row as Reminder & StoredItem;

  return {
    reminderId: stored.reminderId,
    activityId: stored.activityId,
    userId: stored.userId,
    offsetMinutes: stored.offsetMinutes,
    channel: stored.channel,
  };
}
