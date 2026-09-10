import { isDeepStrictEqual } from 'node:util';
import {
  assertNever,
  blockerMessage,
  type ChangeResult,
  type ChangeTarget,
  changeActivityKind,
} from '@od/shared';
import { MAX_PREP_TASKS_PER_PLAN, MAX_TITLE_LEN } from '@od/shared/constants';
import { expandRecurrence, toUtcInstant } from '@od/shared/recurrence';
import type {
  ActivityListQuery,
  ConvertRecurrenceInput,
  CreateActivityInput,
  PatchActivityInput,
} from '@od/shared/schemas';
import {
  activityChild as activityChildSchema,
  activity as activitySchema,
  occurrence as occurrenceSchema,
  recurrence as recurrenceSchema,
  reminderInputsForSchedule,
} from '@od/shared/schemas';
import type {
  Activity,
  ActivityChild,
  ActivityDetail,
  ActivityDetails,
  ActivityDetailTarget,
  ActivityFilter,
  ActivityListItem,
  ActivitySchedule,
  ActivityStatus,
  Gsi1Bucket,
  ListItemActivityLink,
  MealIngredient,
  OccurrenceDetailProjection,
  Recurrence,
  RecurrenceSegment,
  Reminder,
  SourceListSummary,
} from '@od/shared/types';
import { formatInTimeZone } from 'date-fns-tz';
import { AppError } from '../lib/errors.js';
import type { IdempotencyReceipt } from '../lib/idempotency.js';
import type { Logger } from '../lib/logger.js';
import {
  ActivityIdUnavailableError,
  CoverAttachmentUnavailableError,
  deleteActivity as deleteActivityRows,
  detachChildFromParent,
  getActivityIndex,
  getActivityMeta,
  getActivityPartition,
  getActivityPartitionStrong,
  listByBucket as listBucket,
  listParticipants,
  listPrepTaskPointers,
  listStoredPrepTaskPointers,
  markActivityDeleting,
  materializePrepTaskPointers,
  newActivityId,
  newReminderId,
  ParentUnavailableError,
  PendingAttachmentsUnavailableError,
  type PrepTaskPointer,
  createActivity as putActivity,
  patchActivity as putPatch,
  StaleViewerLinkError,
} from '../repositories/activityRepository.js';
import { listActivityUpdates } from '../repositories/activityUpdateRepository.js';
import {
  listAttachments,
  stageActivityAttachmentDeletion,
  toStoredAttachment,
} from '../repositories/attachmentRepository.js';
import {
  batchGetDetailHydration,
  clearSourceActivity,
  findViewerLinksTo,
  listSourceListIds,
} from '../repositories/listRepository.js';
import type { StoredItem } from '../repositories/migrate.js';
import {
  countCompleted,
  get as getOccurrence,
} from '../repositories/occurrenceRepository.js';
import { listForUser as listRemindersForUser } from '../repositories/reminderRepository.js';
import {
  assertAttachmentsConfirmable,
  assertCoverIsLinked,
  confirmAttachments,
  drainActivityAttachmentDeletions,
  drainPendingUploads,
  unconfirmableAttachments,
} from './attachmentService.js';
import {
  assertActivityAccess,
  assertActivityReadAccessFromMeta,
  assertPatchableFields,
} from './authz.js';

type ParsedActivity = ReturnType<typeof activitySchema.parse>;
type ParsedOccurrence = ReturnType<typeof occurrenceSchema.parse>;

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
/**
 * Exported from P3-13: the bridge refuses `selected_people` with the **same** copy, so the
 * two paths cannot drift into telling a user two different things about one missing feature.
 */
export const SHARING_SOON = 'Sharing is coming soon.';

/**
 * Two levels: a plan, and its prep tasks (`plans-and-lists.md` §3). A third is refused rather
 * than flattened, because flattening would silently reparent somebody's task.
 */
const NESTING_CAP =
  'A prep task cannot have its own prep task. Add it to the plan instead.';

/**
 * A prep task is a **task** — the first line of `plans-and-lists.md` §3 and of §P3-18.
 *
 * Not a stylistic preference about what belongs under a plan. `parentActivityId` sits on the
 * shape shared by both `objectKind` arms, so nothing in the schema stopped a Plan being
 * created with a parent, and such a row is a contradiction the rest of the model then acts
 * on: it takes a `SUB#` pointer and a slot against the 50-cap, renders in a PREP section that
 * `plans-and-lists.md` §3 describes as tasks, and would be offered to P3-44's `Complete all`
 * — which completes children in bulk while plan completion is owner-only and global
 * (`activities.md` §5.1). Phase 6 makes it worse rather than better: prep authority is
 * inherited from the parent's participants, so an attached Plan would hand a participant
 * completion rights over a Plan that is not theirs.
 */
const CHILD_MUST_BE_TASK = 'Only a task can be a prep task.';

/**
 * The other end of the same relationship: a prep task hangs off a **Plan**.
 *
 * `plans-and-lists.md` §3 opens with "`parentActivityId` set to the plan" and caps the count
 * "per Plan"; §P3-18 says "A Plan has at most 50 prep tasks". A Task parent contradicts all
 * three, and produces a row no screen can render: the PREP section belongs to plan detail
 * (§P3-38), and Task detail (`today-and-tasks.md` §5.6) has no PREP section at all — it shows
 * a `Related plan` row and nothing else. So a child under a Task is invisible, uncountable
 * against a per-Plan cap, and unreachable by the drill-down that `3 of 5 done` promises.
 *
 * See the PR description for the one sentence in §3 that reads the other way; it is amended
 * in the same change rather than silently outvoted.
 */
const PARENT_MUST_BE_PLAN = 'A prep task belongs to a plan.';

/**
 * The prep-task kind rule, on whatever write is producing the attached state.
 *
 * Separate from {@link assertCanParent} because the two do not fire together. Attaching is a
 * *relationship* change and is checked when the parent moves; this is a check on the
 * **child**, and a `PATCH` that converts an already-attached task into a Plan changes no
 * parent at all — it reaches the attached-Plan state by the one door a reparenting check
 * never opens.
 */
function assertChildMayBeAttached(kind: Pick<Activity, 'objectKind' | 'type'>): void {
  if (kind.objectKind !== 'task' || kind.type !== 'task') {
    throw parentFailure(CHILD_MUST_BE_TASK);
  }
}

/**
 * A Plan holds at most {@link MAX_PREP_TASKS_PER_PLAN} prep tasks
 * (`plans-and-lists.md` §3, amended 2026-08-23).
 *
 * The bound is not tidiness: it is what lets plan detail read the complete PREP section and
 * its exact done/open counts in one page, so the `3 of 5 done` a user taps is a real ratio
 * rather than the first fifty of an unknown number.
 */
const PREP_TASKS_FULL = 'Plan has too many prep tasks.';

/** A task that already has prep tasks cannot become one — that is the third level again. */
const NESTING_CAP_HAS_CHILDREN =
  'This task has its own prep tasks. Move them first, or add it to the plan directly.';

/** An activity cannot be its own prep task. */
const SELF_PARENT = 'A task cannot be its own prep task.';

function parentFailure(message: string): AppError {
  return new AppError('validation_failed', message, [
    { path: 'parentActivityId', message },
  ]);
}

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
async function assertCanParent(
  userId: string,
  parentActivityId: string,
  options: {
    /**
     * The kind the child will have once this write lands.
     *
     * Required rather than optional, and taken from the **resulting** state rather than the
     * stored one, so a `PATCH` that converts a prep task to a Plan and one that attaches a
     * Plan to a parent are refused by the same check. A caller that cannot say what it is
     * attaching has no business attaching it.
     */
    readonly childKind: Pick<Activity, 'objectKind' | 'type'>;
    /** The activity being attached, when it already exists. Absent on create. */
    readonly child?: Activity;
    /**
     * Leave the 50-cap refusal to the transaction (create only).
     *
     * A **client-minted** create can be a replay of one that already committed, and at a full
     * plan the two are indistinguishable from `childCount` alone: both see fifty children,
     * but one of them *is* the fiftieth. Refusing here would answer a replay "the plan is
     * full" and send the client away from the recovery its own id would have given it. The
     * transaction tells them apart in the right order — a taken id fails first and answers
     * `conflict`, a genuine 51st reaches the counter condition and answers with
     * {@link PREP_TASKS_FULL} — so the cap is deferred, never dropped.
     */
    readonly capOnly?: 'transaction';
  },
): Promise<Activity> {
  assertChildMayBeAttached(options.childKind);

  if (options.child?.activityId === parentActivityId) throw parentFailure(SELF_PARENT);

  const { activity: parent } = await assertActivityAccess(
    userId,
    parentActivityId,
    'write',
  );

  if (parent.objectKind !== 'plan') throw parentFailure(PARENT_MUST_BE_PLAN);

  if (parent.parentActivityId !== undefined) throw parentFailure(NESTING_CAP);

  /**
   * The other way to reach a third level, and the only one a `POST` cannot: attaching a task
   * that is *already* somebody's parent. A create has no children yet, so this can only come
   * from a `PATCH` — which is exactly why the cap has to be checked on both sides of the
   * relationship rather than once, at creation.
   */
  if ((options.child?.childCount ?? 0) > 0) throw parentFailure(NESTING_CAP_HAS_CHILDREN);

  if (options.capOnly !== 'transaction' && parent.childCount >= MAX_PREP_TASKS_PER_PLAN) {
    throw parentFailure(PREP_TASKS_FULL);
  }

  return parent;
}

/**
 * The answer when the parent's attach condition cancelled the write.
 *
 * One extra `GetItem`, on a path that is a genuine race rather than an ordinary request. The
 * transaction can only report *that* a condition failed, and this attach carries **three** of
 * them, so the re-read is what turns one cancellation into the right sentence:
 *
 * | Re-read finds | Which condition lost | Answer |
 * | --- | --- | --- |
 * | nothing | `attribute_exists(pk)` | `not_found` — the plan was deleted between the two |
 * | an activity that is not a Plan | `objectKind = plan` | {@link PARENT_MUST_BE_PLAN} — it was converted out from under us |
 * | a Plan | `childCount < cap` | {@link PREP_TASKS_FULL} |
 *
 * The middle row is the conversion race's losing side, and reporting it as "the plan is full"
 * — which this did before the `objectKind` condition existed to lose — sends the user to
 * delete prep tasks from a plan that has none and is no longer a plan.
 */
async function parentRejected(parentActivityId: string): Promise<AppError> {
  /**
   * **Strongly consistent, because what it finds is the answer.** A default-consistency
   * `GetItem` that has not caught up reports a deletion that never happened, or reads a
   * pre-conversion Plan and blames a cap that was never the problem.
   */
  const parent = await getActivityMeta(parentActivityId, { consistentRead: true });
  if (parent === undefined) return new AppError('not_found', 'Activity not found.');
  if (parent.objectKind !== 'plan') return parentFailure(PARENT_MUST_BE_PLAN);
  return parentFailure(PREP_TASKS_FULL);
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
const TERMINAL_CANNOT_RECUR = 'Reverse the completion before making this repeat.';
const RECURRENCE_REMOVAL_NEEDS_TARGET =
  'Does not repeat requires a selected occurrence through the recurrence conversion action.';

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

/**
 * Exported from P3-13, so the bridge derives its stored recurrence with this function rather
 * than a second copy — §P3-13 says to import the create path's derivations, not re-derive.
 */
export function recurrenceForCreate(
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

  /**
   * Refused **before** anything is written (P3-22 rule 5). Every way an id fails to be
   * confirmable is knowable without a write, so a create carrying one leaves no Activity
   * behind — see {@link assertAttachmentsConfirmable} for what this deliberately does not
   * try to roll back.
   */
  await assertAttachmentsConfirmable(userId, input.attachmentIds ?? []);

  const parent =
    input.parentActivityId === undefined
      ? undefined
      : await assertCanParent(userId, input.parentActivityId, {
          childKind: { objectKind: input.objectKind, type: input.type },
          ...(input.activityId === undefined ? {} : { capOnly: 'transaction' }),
        });

  const schedule = input.schedule === undefined ? undefined : toSchedule(input.schedule);
  const storedRecurrence = recurrenceForCreate(input.recurrence, schedule);
  const reminderInputs = reminderInputsForSchedule(schedule).parse(input.reminders ?? []);

  const activity: Activity = {
    /**
     * The client's id when it minted one, ours otherwise (Phase 2.6, ADR-055).
     *
     * The schema has already validated prefix and encoding, so nothing here trusts the shape.
     * What matters is what is **not** taken from the caller on the next two lines: ownership
     * comes from the authenticated principal and status from the schedule, exactly as before.
     * An id says which entity this is and never whose it is.
     */
    activityId: input.activityId ?? newActivityId(),
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
    /** The client's id when it minted one (P2-57). Identity only; see `reminderService`. */
    reminderId: entry.reminderId ?? newReminderId(),
    activityId: activity.activityId,
    userId,
    offsetMinutes: entry.offsetMinutes,
    channel: 'push',
  }));

  const result = { activity, reminders };
  try {
    await putActivity(userId, activity, {
      reminders: reminders.map((row) => ({
        reminderId: row.reminderId,
        offsetMinutes: row.offsetMinutes,
      })),
      /**
       * A prep task renders on Today under its parent plan's title (`today-and-tasks.md`
       * §5.5), and the index projection is where that subtitle lives. The parent is already
       * in hand from the nesting check, so the row is complete from its first write and no
       * agenda read has to go and find it.
       */
      ...(parent === undefined ? {} : { taskSubtitle: parent.title }),
      ...(input.attachmentIds === undefined
        ? {}
        : { confirmAttachmentIds: input.attachmentIds }),
      ...(receiptFor === undefined ? {} : { idempotencyReceipt: receiptFor(result) }),
    });
  } catch (error) {
    if (error instanceof ActivityIdUnavailableError) throw idUnavailable();
    if (error instanceof PendingAttachmentsUnavailableError) {
      throw unconfirmableAttachments();
    }
    if (error instanceof ParentUnavailableError && input.parentActivityId !== undefined) {
      throw await parentRejected(input.parentActivityId);
    }
    throw error;
  }

  /**
   * The confirm-and-link path, once per id, **after** the Activity exists — an attachment row
   * is keyed by the activity it belongs to, so there is no earlier moment it could run.
   *
   * The prechecked ids are the reason this is not a rollback point: everything a client can
   * get wrong was refused above, and what is left is infrastructure failing mid-way, which
   * leaves `confirming` records the drain completes against the Activity that now exists.
   */
  if ((input.attachmentIds?.length ?? 0) > 0) {
    await confirmAttachments(userId, activity.activityId, input.attachmentIds ?? [], now);
  }

  return result;
}

/**
 * The answer when a client-minted id is already taken or tombstoned (Phase 2.6).
 *
 * **Deliberately says nothing about the id's fate.** No owner, no entity, no distinction
 * between "exists" and "was deleted" — `data-model.md` §8 accepts the residual existence
 * signal in success-versus-failure and bounds it, rather than pretending copy can hide it.
 * The client's recovery is documented and does not branch on this text: it reads its own id.
 *
 * Exported because durable List creation (P3-05) answers a colliding `lst_` id with the
 * **same** metadata-free copy — one constant, so the two cannot drift into a difference a
 * client could probe.
 */
export const ID_UNAVAILABLE = 'That id is already in use. Try again.';

function idUnavailable(): AppError {
  return new AppError('conflict', ID_UNAVAILABLE);
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
 * The same `validation_failed` shape `checkDetailsMatchType` produces on create: path
 * `details.kind`, message naming the stored type. PATCH cannot run that refinement unless
 * `type` is also in the body, so a details-only mismatch has to be refused here.
 */
function detailsKindMismatch(type: string): AppError {
  const message = `details.kind must be "${type}" to match the activity type`;
  return new AppError('validation_failed', message, [{ path: 'details.kind', message }]);
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

function activityLocalDate(schedule: ActivitySchedule, now: string): string {
  return formatInTimeZone(new Date(now), schedule.timezone, 'yyyy-MM-dd');
}

function isSameDayCorrection(
  stored: Recurrence,
  supplied: Recurrence,
  localDate: string,
): boolean {
  if (supplied.segments.length !== stored.segments.length) return false;
  const storedActive = stored.segments.at(-1);
  const suppliedActive = supplied.segments.at(-1);
  if (
    storedActive === undefined ||
    suppliedActive === undefined ||
    storedActive.effectiveFrom !== localDate ||
    isDeepStrictEqual(storedActive, suppliedActive)
  ) {
    return false;
  }
  return stored.segments
    .slice(0, -1)
    .every((segment, index) => isDeepStrictEqual(segment, supplied.segments[index]));
}

function segmentTimeSource(
  segment: RecurrenceSegment,
  schedule: ActivitySchedule,
): Pick<RecurrenceSegment, 'time' | 'endTime'> {
  return {
    ...((segment.time ?? schedule.time) === undefined
      ? {}
      : { time: segment.time ?? schedule.time }),
    ...((segment.endTime ?? schedule.endTime) === undefined
      ? {}
      : { endTime: segment.endTime ?? schedule.endTime }),
  };
}

function sameDayCorrectionDate(
  current: Activity,
  patch: PatchActivityInput,
  now: string,
): string | undefined {
  if (
    current.recurrence === undefined ||
    current.schedule === undefined ||
    patch.recurrence === undefined ||
    patch.recurrence === null ||
    patch.editedFromDate !== undefined
  ) {
    return undefined;
  }
  const localDate = activityLocalDate(current.schedule, now);
  return isSameDayCorrection(current.recurrence, patch.recurrence, localDate)
    ? localDate
    : undefined;
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
    recurrenceFailure(RECURRENCE_REMOVAL_NEEDS_TARGET);
  }
  if (schedule === undefined) recurrenceFailure(RECURRENCE_NEEDS_DATE);

  const supplied = patch.recurrence;
  const stored = current.recurrence;
  if (stored === undefined) {
    /**
     * **A recurring activity never holds a terminal series status**, enforced from both
     * directions.
     *
     * `completionService` refuses to *set* one: an unscoped complete or skip on a series is
     * rejected, because an occurrence's resolution belongs on its `Occurrence` row (rule 3).
     * This is the other way in — complete a one-off, then make it repeat, and the row keeps
     * `status: 'completed'` while becoming a series. `agendaService` used to render every
     * un-overridden occurrence from that status, so the whole series showed as done; it no
     * longer does, but the row was still wrong and this is where it was created.
     *
     * `cancelled` is not terminal for this purpose — a cancelled series is legitimate and its
     * occurrences inherit the cancellation.
     */
    if (current.status === 'completed' || current.status === 'skipped') {
      recurrenceFailure(TERMINAL_CANNOT_RECUR, 'status');
    }
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

  if (supplied.segments.length === oldCount) {
    if (patch.editedFromDate !== undefined) {
      recurrenceFailure(EDIT_DATE_NEEDS_APPEND, 'editedFromDate');
    }
    const localDate = activityLocalDate(schedule, now);
    if (isSameDayCorrection(stored, supplied, localDate)) {
      const incoming = supplied.segments.at(-1);
      if (incoming === undefined) recurrenceFailure(RECURRENCE_APPEND_ONLY);
      return validateRecurrence(
        seriesLevel(supplied, [
          ...stored.segments.slice(0, -1),
          serverSegment(incoming, localDate, segmentTimeSource(incoming, schedule)),
        ]),
      );
    }
    for (const [index, oldSegment] of stored.segments.entries()) {
      if (!isDeepStrictEqual(supplied.segments[index], oldSegment)) {
        recurrenceFailure(RECURRENCE_APPEND_ONLY, `recurrence.segments.${index}`);
      }
    }
    return validateRecurrence(seriesLevel(supplied, stored.segments));
  }

  for (const [index, oldSegment] of stored.segments.entries()) {
    if (!isDeepStrictEqual(supplied.segments[index], oldSegment)) {
      recurrenceFailure(RECURRENCE_APPEND_ONLY, `recurrence.segments.${index}`);
    }
  }

  const incoming = supplied.segments[oldCount];
  if (incoming === undefined) recurrenceFailure(RECURRENCE_APPEND_ONLY);
  const anchor = patch.editedFromDate ?? activityLocalDate(schedule, now);

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
      serverSegment(incoming, anchor, segmentTimeSource(incoming, schedule)),
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

  /**
   * `Set as cover` (P3-22). Validated **against this activity's own rows** before anything is
   * merged, because the shape is all the schema can check: a client could otherwise point the
   * hero at an id it invented, or at a real attachment on somebody else's plan, and the hero
   * renders as a request for exactly that key — which is the whole of the access control on
   * media (ADR-023).
   *
   * After the `If-Match` check, so a stale edit is still reported as a stale edit rather than
   * as whatever its cover happened to name.
   */
  await assertCoverIsLinked(activityId, patch.primaryAttachmentId);

  /**
   * `patchActivityInput` only calls `checkDetailsMatchType` when `type` is present. A
   * details-only body can therefore name a `kind` that disagrees with the stored type, and
   * merge would write it. Kind-change still carries `type`, so the schema already checked
   * that path.
   */
  if (
    patch.details !== undefined &&
    patch.type === undefined &&
    patch.details.kind !== current.type
  ) {
    throw detailsKindMismatch(current.type);
  }

  const correctionDate = sameDayCorrectionDate(current, patch, now);
  const change = applyKindChange(current, patch, log);
  const next = merge(current, patch, change, now);
  const convertedListLink =
    current.objectKind === 'plan' &&
    next.objectKind === 'task' &&
    current.listId !== undefined &&
    current.listItemId !== undefined
      ? { listId: current.listId, itemId: current.listItemId }
      : undefined;
  if (current.objectKind === 'plan' && next.objectKind === 'task') {
    delete next.listId;
    delete next.listItemId;
  }
  const reparents = current.parentActivityId !== next.parentActivityId;
  /**
   * A patch that names a **new** parent goes through the same door a create does.
   *
   * It was not doing so, and both halves of that mattered: without the access check a task
   * could be attached to a stranger's activity — whose title the index projection would then
   * render as this task's subtitle on Today — and without the structural checks a `PATCH`
   * could assemble the third nesting level that `POST` refuses, by attaching a task that
   * already has prep tasks of its own.
   */
  /**
   * The kind check is **outside** that door, because it has to fire when no parent moved:
   * converting an already-attached prep task into a Plan reaches the same forbidden state
   * without touching the relationship at all.
   */
  if (next.parentActivityId !== undefined) assertChildMayBeAttached(next);
  const parent =
    next.parentActivityId === undefined
      ? undefined
      : reparents
        ? await assertCanParent(userId, next.parentActivityId, {
            childKind: next,
            child: current,
          })
        : await getActivityMeta(next.parentActivityId);

  /**
   * The pointer mirrors title, status, schedule-derived restoration state and the recurrence
   * bit, so any of them moving is a pointer rewrite in this same transaction — recurrence
   * included, per
   * `api-contract.md` §2.3, so the completion follow-up never reads a stale one. A changed
   * parent is the other shape: the repository moves the pointer and both counters.
   */
  const childPointerStale =
    !reparents &&
    current.parentActivityId !== undefined &&
    (current.title !== next.title ||
      current.status !== next.status ||
      (current.schedule !== undefined) !== (next.schedule !== undefined) ||
      (current.recurrence !== undefined) !== (next.recurrence !== undefined));

  try {
    await putPatchWithLinkLifecycle(
      userId,
      next,
      ifMatch,
      {
        previous: current,
        ...(correctionDate === undefined
          ? {}
          : { requireMissingOccurrenceDate: correctionDate }),
        ...(parent === undefined ? {} : { taskSubtitle: parent.title }),
        ...(reparents || childPointerStale ? { updateChildPointer: true } : {}),
        /**
         * A Plan → Task conversion is legal only at `childCount === 0`, and
         * {@link applyKindChange} has already refused it otherwise from the row we read.
         * That decision is about a counter `updatedAt` does not track, so it is pinned into
         * the write as well: an attach landing in between must lose here rather than have
         * its parent silently converted out from under it, leaving the child and its `SUB#`
         * pointer hanging off a Task with a `childCount` of zero.
         */
        ...(current.objectKind === 'plan' && next.objectKind === 'task'
          ? { expectedChildCount: current.childCount }
          : {}),
        ...(typeof patch.primaryAttachmentId === 'string'
          ? { coverAttachmentId: patch.primaryAttachmentId }
          : {}),
      },
      convertedListLink,
    );
  } catch (error) {
    if (error instanceof CoverAttachmentUnavailableError) {
      await assertCoverIsLinked(activityId, patch.primaryAttachmentId);
    }
    if (error instanceof ParentUnavailableError && next.parentActivityId !== undefined) {
      throw await parentRejected(next.parentActivityId);
    }
    if (error instanceof AppError && error.code === 'conflict') {
      /**
       * **Strongly consistent, and read for two different reasons.** A cancelled patch has
       * two shapes now, and `updatedAt` alone cannot tell them apart — because the second
       * shape is precisely the one `updatedAt` does not track.
       *
       * - The **version moved**: an ordinary stale edit. Report the current value so the
       *   client can refetch and re-apply.
       * - The version is **unchanged**: then `updatedAt` cannot have failed, so the pinned
       *   `childCount` did. Answering "this changed while you were editing it" alongside the
       *   very token the caller just sent is both false and un-actionable — retrying with it
       *   hits the same wall for ever. Re-run the kind change against the fresh row and
       *   answer with the blocker it actually produces: `Remove 1 prep task before changing
       *   this to a Task.`
       */
      const fresh = await getActivityMeta(activityId, { consistentRead: true });
      if (fresh !== undefined && fresh.updatedAt === ifMatch) {
        applyKindChange(fresh, patch, log);
      }
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
  return toActivity(next);
}

const VIEWER_LINK_WRITE_ATTEMPTS = 3;

/**
 * A Plan → Task conversion ends the Plan-specific relationship to its source ListItem.
 * Clearing Activity provenance and the matching viewer pointer is part of the same
 * conditional transaction as the conversion, so neither half can survive by itself.
 *
 * Pointer deletes are conditional: a viewer may have planned the item again after our read.
 * Re-reading on that condition failure preserves the newer pointer while still committing
 * the conversion. Three consecutive races surface an honest conflict with no partial write.
 */
async function putPatchWithLinkLifecycle(
  userId: string,
  next: Activity,
  expectedUpdatedAt: string,
  options: Parameters<typeof putPatch>[3],
  convertedListLink?: { readonly listId: string; readonly itemId: string },
): Promise<void> {
  if (convertedListLink === undefined) {
    await putPatch(userId, next, expectedUpdatedAt, options);
    return;
  }

  for (let attempt = 0; attempt < VIEWER_LINK_WRITE_ATTEMPTS; attempt += 1) {
    const clearViewerLinks = await findViewerLinksTo(
      convertedListLink.listId,
      convertedListLink.itemId,
      next.activityId,
    );
    try {
      await putPatch(userId, next, expectedUpdatedAt, { ...options, clearViewerLinks });
      return;
    } catch (error) {
      if (!(error instanceof StaleViewerLinkError)) throw error;
    }
  }

  throw new AppError('conflict', 'This changed while you were editing it. Try again.');
}

/**
 * Converts one explicitly selected recurring occurrence into the surviving one-off.
 * META, every user index and the idempotency receipt commit together; OCC history is read and
 * condition-checked but never rewritten.
 */
export async function convertRecurrence(
  userId: string,
  activityId: string,
  input: ConvertRecurrenceInput,
  now: string,
  receiptFor: (activity: Activity) => IdempotencyReceipt,
): Promise<Activity> {
  const { activity: current } = await assertActivityAccess(userId, activityId, 'owner');
  if (current.recurrence === undefined || current.schedule === undefined) {
    recurrenceFailure('This activity does not repeat.');
  }

  const [partition, participants] = await Promise.all([
    getActivityPartition(activityId),
    listParticipants(activityId),
  ]);
  const rawOccurrence = partition.find(
    (row) =>
      row.entity === 'Occurrence' &&
      row.activityId === activityId &&
      row.date === input.occurrenceDate,
  );
  const parsedOccurrence = occurrenceSchema.safeParse(rawOccurrence);
  const selected = projectOccurrenceDetail(
    current,
    parsedOccurrence.success ? parsedOccurrence.data : undefined,
    input.occurrenceDate,
  );

  const { recurrence: _removed, ...withoutRecurrence } = current;
  const next: Activity = {
    ...withoutRecurrence,
    schedule: toSchedule({
      date: selected.date,
      timezone: current.schedule.timezone,
      ...(selected.time === undefined ? {} : { time: selected.time }),
      ...(selected.endTime === undefined ? {} : { endTime: selected.endTime }),
    }),
    status: current.status === 'cancelled' ? 'cancelled' : 'scheduled',
    icsSequence: current.icsSequence + 1,
    updatedAt: now,
  } as Activity;

  /**
   * A converted prep task is still a prep task: its parent's pointer drops to
   * `isRecurring: false` in this same transaction (`data-model.md` §7, `api-contract.md`
   * §2.3), and its index entry is rewritten from scratch — so the parent's title has to be
   * supplied again or the conversion would quietly strip the subtitle Today renders it with.
   */
  const parent =
    next.parentActivityId === undefined
      ? undefined
      : await getActivityMeta(next.parentActivityId);

  await putPatch(userId, next, current.updatedAt, {
    previous: current,
    indexedUserIds: [
      current.ownerId,
      ...participants.flatMap((row) =>
        typeof row.userId === 'string' ? [row.userId] : [],
      ),
    ],
    ...(parent === undefined ? {} : { taskSubtitle: parent.title }),
    ...(next.parentActivityId === undefined ? {} : { updateChildPointer: true }),
    occurrenceGuard:
      rawOccurrence === undefined
        ? { date: input.occurrenceDate, kind: 'missing' }
        : {
            date: input.occurrenceDate,
            kind: 'version',
            updatedAt: String(rawOccurrence.updatedAt),
          },
    idempotencyReceipt: receiptFor(next),
  });

  return next;
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
  const activeRuleSegment =
    schedule !== undefined &&
    current.recurrence !== undefined &&
    recurrenceUpdate !== undefined &&
    recurrenceUpdate !== null &&
    !isDeepStrictEqual(
      recurrenceUpdate.segments.at(-1),
      current.recurrence.segments.at(-1),
    )
      ? recurrenceUpdate.segments.at(-1)
      : undefined;
  const activeSchedule =
    schedule === undefined || activeRuleSegment === undefined
      ? schedule
      : toSchedule({
          date: schedule.date,
          timezone: schedule.timezone,
          ...(activeRuleSegment.time === undefined
            ? {}
            : { time: activeRuleSegment.time }),
          ...(activeRuleSegment.endTime === undefined
            ? {}
            : { endTime: activeRuleSegment.endTime }),
        });
  const scheduleTimeChanged =
    activeRuleSegment !== undefined &&
    (schedule?.time !== activeSchedule?.time ||
      schedule?.endTime !== activeSchedule?.endTime);

  const next: Record<string, unknown> = {
    ...base,
    ...pick(patch, 'title', 'notes', 'details'),
    ...(patch.details === undefined
      ? {}
      : { details: withRetainedProvenance(current.details, patch.details) }),
    ...(recurrenceUpdate == null ? {} : { recurrence: recurrenceUpdate }),
    ...nullable(
      patch,
      'location',
      'sourceUrl',
      'parentActivityId',
      'primaryAttachmentId',
    ),
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
  for (const field of [
    'location',
    'sourceUrl',
    'parentActivityId',
    'primaryAttachmentId',
  ] as const) {
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
/**
 * Carries each ingredient's server-owned `addedToListId` across a `details` replacement
 * (P3-17, raised in review).
 *
 * `PATCH /v1/activities/:id` replaces `details` wholesale, and the client cannot send this
 * field back — `mealIngredientInput` rejects it, because a client able to author it could
 * fabricate the `Added` state for any well-formed `lst_` id. Both halves of that are right,
 * and together they mean **the server has to be the one that preserves it**: without this,
 * renaming an ingredient, fixing a quantity or reordering a row silently cleared every marker
 * on the meal, and the user was then offered ingredients they had already added.
 *
 * Matched by `ingredientId`, never by position — the same rule the add-to-list action
 * follows, and for the same reason. An id new to this patch is a genuinely new row with no
 * marker to inherit; a row that was removed takes its marker with it.
 */
type PatchedDetails = NonNullable<PatchActivityInput['details']>;

function withRetainedProvenance(
  current: ActivityDetails | undefined,
  next: PatchedDetails,
): PatchedDetails | ActivityDetails {
  if (next.kind !== 'meal' || next.ingredients === undefined) return next;
  if (current?.kind !== 'meal') return next;

  const addedToListIdById = new Map(
    (current.ingredients ?? []).flatMap((ingredient) =>
      ingredient.addedToListId === undefined
        ? []
        : [[ingredient.ingredientId, ingredient.addedToListId] as const],
    ),
  );
  if (addedToListIdById.size === 0) return next;

  // Rebuilt field by field rather than spread: the input ingredient's optionals are
  // `T | undefined` while the stored shape uses absence, so a spread would carry explicit
  // `undefined`s into a row `exactOptionalPropertyTypes` says must simply not have them.
  const ingredients: MealIngredient[] = next.ingredients.map((ingredient) => {
    const addedToListId = addedToListIdById.get(ingredient.ingredientId);
    return {
      ingredientId: ingredient.ingredientId,
      name: ingredient.name,
      ...(ingredient.quantity === undefined ? {} : { quantity: ingredient.quantity }),
      ...(addedToListId === undefined ? {} : { addedToListId }),
    };
  });

  return {
    kind: 'meal',
    ...(next.mealSlot === undefined ? {} : { mealSlot: next.mealSlot }),
    ingredients,
    ...(next.recipeUrl === undefined ? {} : { recipeUrl: next.recipeUrl }),
  };
}

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
 * ## What this cascade does not reach
 *
 * This list was written when none of these rows existed and has been corrected as they
 * arrived; read it as a statement about today, not about Phase 1.
 *
 * - **Viewer-link rows are cleared**, by {@link viewerLinksToClear} below — P3-15 added them
 *   and this cascade handles them.
 * - **`SOURCE_LIST#` back-links are cleared**, by {@link clearSourcedListBacklinks} below
 *   (§P3-50) — and **before** the cascade removes the projections, because those rows are the
 *   only record of which Lists point here. `data-model.md` §7 *Delete activity* and
 *   `api-contract.md` §2.3 both require the clear. This bullet twice said the opposite: first
 *   that nothing wrote these rows, then that the clear was somebody else's open work. Both
 *   were true when written and neither is now.
 * - Expense locators (Phase 7) and EventBridge schedules (Phase 5) genuinely have no rows to
 *   delete, because nothing writes them yet. **There is no settlement guard here** and
 *   `settlement_conflict` is deliberately not in the error union: a guard over rows no schema
 *   defines reads as an implemented control and is none. P7-08 owns it, and nothing before
 *   P7-08 writes an Expense (P1-14's decision note).
 */
export async function removeActivity(
  userId: string,
  activityId: string,
  now: string,
): Promise<string> {
  await assertActivityAccess(userId, activityId, 'owner');
  await markActivityDeleting(userId, activityId, now);

  /**
   * **Strongly consistent, because a delete acts on what it reads** (P3-15).
   *
   * Two decisions come out of this one read, and both are destructive. The cascade's key list
   * is built from it, so a row missing from a replica is a row never deleted; and the Plan's
   * `listId`/`listItemId` are read from it, so a META row that has not replicated yet reads
   * as a Plan with no list — and its viewer pointer survives a delete that removed the Plan
   * it names. That is the dead link the lifecycle table exists to prevent, created by the
   * delete itself.
   */
  const partition = await getActivityPartitionStrong(activityId);

  /**
   * Deleting a prep task is two partitions' work, and P1-14 only ever did one of them.
   *
   * The child's own rows and index entries go below; the pointer and the count that describe
   * it live on the **parent**, and leaving them behind gave a plan a `4 of 5 done` whose
   * fifth row no longer existed — a number the product promises is drillable, pointing at
   * nothing. Before the removal, so an interrupted delete resumes from a state where the
   * child is still authoritative rather than half-gone.
   *
   * This is the mirror image of the rule directly below it, and the two must not be confused:
   * deleting a **parent** never deletes its children, while deleting a **child** must always
   * clean up its parent's record of it.
   */
  const parentActivityId = partition.find((row) => row.sk === 'META')?.parentActivityId;
  if (typeof parentActivityId === 'string') {
    await detachChildFromParent(parentActivityId, activityId);
  }

  await releaseChildren(activityId, childIdsOf(partition), now);
  await clearSourcedListBacklinks(activityId, partition);
  for (const row of partition) {
    if (row.entity !== 'Attachment') continue;
    await stageActivityAttachmentDeletion(userId, toStoredAttachment(row), now);
  }
  // Permanent objects must be gone before META, the retry authority, is removed. Each staged
  // row is durable, so an interrupted S3 delete is discoverable on the next cascade attempt.
  await drainActivityAttachmentDeletions(userId, activityId);
  // The repository removes partition children and index pointers next, then META last. That
  // leaves this access seam present until every retryable cleanup step has succeeded.
  await deleteActivityRows(userId, activityId, {
    partition,
    now,
    ...(await viewerLinksToClear(activityId, partition)),
  });

  return activityId;
}

/**
 * Clears the `sourceActivityId` on every List this Plan sourced (P3-50).
 *
 * **Before the cascade, and that ordering is the whole design.** The `SOURCE_LIST#` rows are
 * the only record of which Lists point back here, and the cascade deletes them along with the
 * rest of the partition. Clearing first means an interrupted delete re-reads those rows and
 * finishes the job; clearing after would mean the ids are already gone and every List that
 * still needed clearing is unreachable — a dangling link nothing could ever find again, which
 * is exactly the state this exists to prevent.
 *
 * One conditional write per List rather than one transaction. They live in their own
 * partitions, `MAX_OWNED_LISTS` of them exceeds a transaction's limit, and a single re-sourced
 * List must not cancel the clear of all the others. The same shape the viewer-pointer clears
 * in `deleteActivity` already use, and bounded by the same cap, so no cursor is needed.
 *
 * Read off the partition the caller already holds: a Plan that sourced nothing does no extra
 * work and issues no writes.
 */
async function clearSourcedListBacklinks(
  activityId: string,
  partition: readonly StoredItem[],
): Promise<void> {
  for (const row of partition) {
    if (row.entity !== 'SourceList') continue;
    const listId = row.listId;
    if (typeof listId !== 'string') continue;
    await clearSourceActivity(listId, activityId);
  }
}

/** A plan's prep tasks, with the two numbers the PREP section renders. */
export interface PrepTaskCollection {
  /** Every prep task on the plan. Complete, not a page — see {@link getPrepTasks}. */
  readonly prepTasks: readonly PrepTaskPointer[];
  /** Children whose `status` is `completed`: the `3` in `3 of 5 done`. */
  readonly doneCount: number;
  /** Every other child. `doneCount + openCount` is the collection. */
  readonly openCount: number;
}

/**
 * A plan's complete prep-task collection and its **exact** done/open counts (pattern 16).
 *
 * Exact rather than "at least", and that is the point of the 50-cap: `3 of 5 done` is a
 * drill-down (`today-and-tasks.md` §5.5) and the product's rule against unexplained numbers
 * means a count the user taps has to reach the rows that produced it. One bounded page is the
 * whole collection, so counting it here needs no second read and no aggregate to drift.
 *
 * `openCount` is everything not `completed`, including a skipped or cancelled child — from
 * the section's point of view those are not done. P3-44's follow-up narrows further, to open
 * children that are also not recurring, which is what `isRecurring` on each pointer is for;
 * it is not this function's filter to apply.
 *
 * **Authorisation belongs to the caller**, as it does for `projectDetail`: both named
 * consumers reach this only after establishing that the caller may read the plan — detail
 * assembly through the partition it has already read (P3-37), completion through the action
 * context it already holds (P3-44). Re-deriving it here would be a second authoritative read
 * of a partition the caller is holding.
 */
export async function getPrepTasks(activityId: string): Promise<PrepTaskCollection> {
  const prepTasks = await listPrepTaskPointers(activityId);
  const doneCount = prepTasks.filter((row) => row.status === 'completed').length;

  return { prepTasks, doneCount, openCount: prepTasks.length - doneCount };
}

/**
 * The viewer pointers a deleted Plan must take with it — "Plan deleted → pointers to it are
 * deleted. **The ListItem survives byte-identical**" (`plans-and-lists.md` §6.3, P3-15).
 *
 * Read here rather than in the repository because the rows live in the **list's** partition,
 * which `listRepository` owns; a repository reaching across to another repository's keys is
 * the cycle `no-circular` refuses, and a service reading both is the ordinary shape.
 *
 * Only a Plan that came from a list item has any. Nothing else about the delete changes: the
 * item itself is never read, never written, and never deleted — neither side cascades into
 * the other.
 */
async function viewerLinksToClear(
  activityId: string,
  partition: readonly StoredItem[],
): Promise<{ clearViewerLinks?: ListItemActivityLink[] }> {
  /**
   * The two fields are read straight off the stored META row rather than through
   * `activityFromPartition`, and that is deliberate: parsing would make **deleting** an
   * activity fail on a row that no longer satisfies the schema. Delete is the one operation
   * that has to keep working on a damaged row — it is how a user gets rid of one — so it
   * reads the two strings it needs and ignores everything else.
   */
  const meta = partition.find((row) => row.sk === 'META');
  const listId = meta?.listId;
  const listItemId = meta?.listItemId;
  if (typeof listId !== 'string' || typeof listItemId !== 'string') return {};

  return { clearViewerLinks: await findViewerLinksTo(listId, listItemId, activityId) };
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
 * **Skipped only on authoritative absence, and only for a child that still names us.** Both
 * halves were wrong and both were destructive in the same direction — towards a child left
 * holding a `parentActivityId` that resolves to nothing:
 *
 * - the read is strongly consistent, because the pointer was committed in the *same
 *   transaction* as the child. A partition Query strong enough to see the pointer followed by
 *   a `GetItem` weak enough to miss the child is not a contradiction, it is the ordinary
 *   behaviour of a replica — and the miss was being read as "already gone" by a pass whose
 *   next act is to delete the only row that could have repaired it.
 * - a child that has since been re-parented onto **another** plan is left alone. Clearing it
 *   would silently undo that move and, worse, leave the new parent's pointer and `childCount`
 *   describing a child that no longer names it. The pointer says what was true when it was
 *   written; the child is the source of truth about who its parent is now (`data-model.md`
 *   §3.1).
 *
 * Rewriting the child through `patchActivity` also rebuilds its index entry, which is what
 * drops the **subtitle** — a prep task renders with its parent's title under it on Today, and
 * that title is about to stop existing.
 */
async function releaseChildren(
  parentActivityId: string,
  childIds: readonly string[],
  now: string,
): Promise<void> {
  for (const childId of childIds) {
    const child = await getActivityMeta(childId, { consistentRead: true });
    if (child === undefined || child.parentActivityId !== parentActivityId) continue;

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
 * ## Strong bounded detail
 *
 * Native treats this endpoint's `404` as authoritative absence, so the target Activity META,
 * exact caller grant and every projected section are strongly consistent. META is one keyed
 * read; non-owner proof is the exact caller/activity index; collections use their model-capped
 * sort-key prefixes. No user-growing Activity partition is read wholesale. Parent-inherited
 * access repeats the same META/index pair for the parent.
 *
 * `read`, so a participant may see a plan they are on and a participant of a parent may see
 * its prep task. A caller with no relationship gets `not_found`, never `403`.
 */
export async function getActivityDetail(
  userId: string,
  target: ActivityDetailTarget,
  /**
   * The request's instant, read at the edge. `coding-standards.md` §4.3 bans an implicit
   * clock in anything that has to be testable, and the drain below compares every pending
   * record against it.
   */
  now: string,
): Promise<ActivityDetail> {
  const [activity, directIndex] = await Promise.all([
    getActivityMeta(target.activityId, { consistentRead: true }),
    getActivityIndex(userId, target.activityId, { consistentRead: true }),
  ]);
  if (activity === undefined) throw new AppError('not_found', 'Activity not found.');
  const access = await assertActivityReadAccessFromMeta(userId, activity, {
    preloadedDirectIndex: directIndex ?? null,
  });
  const projectedActivity = toActivity(activity);
  /**
   * The feed's first page, from its **own bounded Query** rather than filtered out of the
   * partition above (§2.3, P3-19).
   *
   * Filtering would be wrong: no whole-partition read exists, and a page assembled in memory has no
   * cursor: `LastEvaluatedKey` comes from a Query that actually stopped at fifty, so a client
   * paging older entries needs this read to have happened.
   *
   * This also deliberately runs for a Task. An ordinary Task returns an empty collection; a
   * Plan converted to a Task returns the retained, read-only discussion history that the
   * conversion is not allowed to erase or strand.
   */
  /**
   * The PREP collection from its bounded pointers (P3-37, pattern 16), and the LISTS
   * section's id-only `SOURCE_LIST#` projections resolved through one logical bounded
   * hydration restored to stored order. Its maximum 250 keys become at most three parallel
   * physical `BatchGetItem`s — never one read per List. A List deleted since the projection
   * was written simply drops out; P3-50's clear owns the projection's lifecycle, not this
   * read.
   */
  /**
   * The bounded section reads run in one parallel dependency wave after META/authority. The **only**
   * ordering that matters is in the attachments arm: the caller's bounded pending-upload drain must land
   * before the attachments are projected (§2.3, access pattern 4, P3-22) — opening a plan is
   * when an interrupted confirmation is noticed, and the drain is what turns a verified copy
   * into the linked row this same read then returns. The drain runs for the **caller**, not
   * the owner: pending records are keyed by uploader.
   */
  const sectionsPromise = Promise.all([
    listActivityUpdates(target.activityId),
    listRemindersForUser(target.activityId, userId, { consistentRead: true }),
    listStoredPrepTaskPointers(target.activityId),
    listSourceListIds(target.activityId),
    countCompleted(target.activityId),
    target.kind === 'occurrence'
      ? getOccurrence(target.activityId, target.date, { consistentRead: true })
      : Promise.resolve(null),
    drainPendingUploads(userId, Date.parse(now)),
  ]).then(
    async ([
      feed,
      reminders,
      storedChildren,
      sourceListIds,
      completedOccurrenceCount,
      occurrence,
    ]) => {
      const legacyChildIds = storedChildren
        .filter((child) => child.restoredStatus === undefined)
        .map((child) => child.childActivityId);
      const originListId = activity.listId;
      const hydrationListIds =
        originListId === undefined || sourceListIds.includes(originListId)
          ? sourceListIds
          : [...sourceListIds, originListId];
      const parentActivityId = activity.parentActivityId;
      const hydrationActivityIds =
        parentActivityId === undefined
          ? legacyChildIds
          : [...legacyChildIds, parentActivityId];
      const [hydration, attachments] = await Promise.all([
        batchGetDetailHydration(userId, hydrationListIds, hydrationActivityIds),
        listAttachments(target.activityId),
      ]);
      return {
        feed,
        reminders,
        storedChildren,
        sourceListIds,
        completedOccurrenceCount,
        occurrence,
        hydration,
        attachments,
      };
    },
  );
  const sections = await sectionsPromise;
  const {
    feed,
    reminders,
    storedChildren,
    sourceListIds,
    completedOccurrenceCount,
    occurrence,
    hydration,
    attachments,
  } = sections;
  const mayAct = access.isOwner || access.viaParent;
  const children = materializePrepTaskPointers(
    storedChildren,
    hydration.childRestoredStatuses,
  ).map((child) =>
    activityChildSchema.parse({
      activityId: child.childActivityId,
      title: child.title,
      status: child.status,
      restoredStatus: child.restoredStatus,
      isRecurring: child.isRecurring,
    }),
  );
  const sourceLists = sourceListIds
    .map((listId) => hydration.sourceLists.get(listId))
    .filter((summary): summary is SourceListSummary => summary !== undefined);
  const parentActivityId = activity.parentActivityId;
  const parentTitle =
    parentActivityId === undefined
      ? undefined
      : hydration.activityTitles.get(parentActivityId);
  /** Hold the row when the parent META is gone or unparseable — never navigate unnamed. */
  const parent =
    parentActivityId !== undefined && parentTitle !== undefined
      ? { activityId: parentActivityId, title: parentTitle }
      : undefined;
  const originListId = activity.listId;
  const originSummary =
    originListId === undefined ? undefined : hydration.sourceLists.get(originListId);
  /**
   * `hydration.sourceLists` only contains Lists whose caller pointer was in the batch —
   * the same grant `assertListAccess(..., 'read')` uses. Missing grant or title withholds
   * the field; `toActivity` still omits `listId` / `listItemId`.
   */
  const sourceList =
    originSummary === undefined
      ? undefined
      : { listId: originSummary.listId, title: originSummary.title };

  return {
    activity: projectedActivity,
    capabilities: {
      complete: mayAct,
      skip: mayAct,
      snooze: mayAct,
    },
    reminders,
    ...(target.kind === 'occurrence'
      ? {
          occurrence: projectOccurrenceDetail(
            projectedActivity,
            occurrence ?? undefined,
            target.date,
          ),
        }
      : {}),
    completedOccurrenceCount,
    updates: feed.updates,
    ...(feed.cursor === undefined ? {} : { updatesCursor: feed.cursor }),
    attachments,
    children,
    sourceLists,
    ...(parent === undefined ? {} : { parent }),
    ...(sourceList === undefined ? {} : { sourceList }),
  };
}

/**
 * The wire PREP collection from a partition's `SUB#` pointers (P3-37): sorted by the
 * pointer's own `rank` — the ordering P3-49 depends on — tie-broken by child id, capped at
 * the model bound, with no per-child lookup.
 */
export function projectChildren(partition: readonly StoredItem[]): ActivityChild[] {
  return partition
    .filter((row) => row.entity === 'ChildPointer')
    .sort((left, right) => {
      const byRank = String(left.rank ?? '').localeCompare(String(right.rank ?? ''));
      if (byRank !== 0) return byRank;
      return String(left.childActivityId).localeCompare(String(right.childActivityId));
    })
    .map((row) => prepPointerToChild(row))
    .filter((child): child is ActivityChild => child !== undefined)
    .slice(0, MAX_PREP_TASKS_PER_PLAN);
}

/** The `SOURCE_LIST#` ids in stored order (P3-37): which Lists this Plan explicitly made. */
export function sourceListIdsOf(partition: readonly StoredItem[]): string[] {
  return partition
    .filter((row) => row.entity === 'SourceList' && typeof row.listId === 'string')
    .map((row) => String(row.listId));
}

/**
 * One `SUB#` pointer row → the wire child; a malformed pointer degrades to absence. The
 * shared `activityChild` schema is the shape's one owner ("never redefine a shape"): a new
 * status added there is accepted here on the same commit, not silently dropped by a stale
 * hand-written chain.
 */
function prepPointerToChild(row: StoredItem): ActivityChild | undefined {
  const parsed = activityChildSchema.safeParse({
    activityId: row.childActivityId,
    title: row.title,
    status: row.status,
    restoredStatus: row.restoredStatus,
    isRecurring: row.isRecurring === true,
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * Legacy pure projection helper for partition-shaped fixtures and migrations.
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
 * The live detail route uses exact bounded reads above; this remains exported only for legacy
 * compatibility tests that pin the field-level projection rules.
 */
export function projectDetail(
  partition: StoredItem[],
  userId: string,
  target: ActivityDetailTarget,
  capabilities?: ActivityDetail['capabilities'],
): ActivityDetail {
  const meta = partition.find((row) => row.sk === 'META');
  if (meta === undefined) throw new AppError('not_found', 'Activity not found.');
  const projected = toActivity(activitySchema.parse(meta));
  const ownerMayAct = projected.ownerId === userId;

  const occurrence =
    target.kind === 'occurrence'
      ? projectOccurrenceDetail(
          projected,
          (() => {
            const raw = partition.find(
              (row) =>
                row.entity === 'Occurrence' &&
                row.activityId === projected.activityId &&
                row.date === target.date,
            );
            return raw === undefined ? undefined : occurrenceSchema.parse(raw);
          })(),
          target.date,
        )
      : undefined;

  return {
    activity: projected,
    capabilities: capabilities ?? {
      complete: ownerMayAct,
      skip: ownerMayAct,
      snooze: ownerMayAct,
    },
    reminders: partition
      .filter((row) => isReminderRow(row) && row.userId === userId)
      .map(toReminder),
    ...(occurrence === undefined ? {} : { occurrence }),
    completedOccurrenceCount: partition.filter(
      (row) => row.entity === 'Occurrence' && row.status === 'completed',
    ).length,
  };
}

function projectOccurrenceDetail(
  activity: Activity,
  override: ParsedOccurrence | undefined,
  nominalDate: string,
): OccurrenceDetailProjection {
  if (
    activity.recurrence === undefined ||
    activity.schedule === undefined ||
    !expandRecurrence(
      activity.recurrence,
      nominalDate,
      nominalDate,
      activity.schedule.timezone,
    ).includes(nominalDate)
  ) {
    throw new AppError(
      'validation_failed',
      'The occurrence target is not in this series.',
      [
        {
          path: 'occurrenceDate',
          message: 'The date is not emitted by this recurrence.',
        },
      ],
    );
  }

  const segment = [...activity.recurrence.segments]
    .reverse()
    .find((candidate) => candidate.effectiveFrom <= nominalDate);

  let date = override?.overrideDate ?? nominalDate;
  let time =
    override?.snoozedUntil ??
    override?.overrideTime ??
    segment?.time ??
    activity.schedule.time;
  if (time?.includes('T') === true) {
    const instant = new Date(time);
    date = formatInTimeZone(instant, activity.schedule.timezone, 'yyyy-MM-dd');
    time = formatInTimeZone(instant, activity.schedule.timezone, 'HH:mm');
  }

  const status =
    override?.status === 'completed'
      ? ('completed_occurrence' as const)
      : override?.status === 'skipped'
        ? ('skipped_occurrence' as const)
        : activity.status === 'completed' || activity.status === 'skipped'
          ? ('scheduled' as const)
          : activity.status;
  const endTime = segment?.endTime ?? activity.schedule.endTime;

  return {
    nominalDate,
    date,
    ...(time === undefined ? {} : { time }),
    ...(endTime === undefined ? {} : { endTime }),
    status,
    isSnoozed: override?.status === 'snoozed',
    ...(override?.completedAt === undefined ? {} : { completedAt: override.completedAt }),
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

function projectStoredDetails(details: ParsedActivity['details']): ActivityDetails {
  switch (details.kind) {
    case 'task':
      return { kind: 'task' };
    case 'meal':
      return {
        kind: 'meal',
        ...(details.mealSlot === undefined ? {} : { mealSlot: details.mealSlot }),
        ...(details.ingredients === undefined
          ? {}
          : {
              ingredients: details.ingredients.map((ingredient) => ({
                ingredientId: ingredient.ingredientId,
                name: ingredient.name,
                ...(ingredient.quantity === undefined
                  ? {}
                  : { quantity: ingredient.quantity }),
                ...(ingredient.addedToListId === undefined
                  ? {}
                  : { addedToListId: ingredient.addedToListId }),
              })),
            }),
        ...(details.recipeUrl === undefined ? {} : { recipeUrl: details.recipeUrl }),
      };
    case 'watch':
      return {
        kind: 'watch',
        mediaTitle: details.mediaTitle,
        ...(details.mediaKind === undefined ? {} : { mediaKind: details.mediaKind }),
        ...(details.season === undefined ? {} : { season: details.season }),
        ...(details.episode === undefined ? {} : { episode: details.episode }),
        ...(details.episodeTitle === undefined
          ? {}
          : { episodeTitle: details.episodeTitle }),
        ...(details.service === undefined ? {} : { service: details.service }),
      };
    case 'event': {
      const reservation =
        details.reservation === undefined
          ? undefined
          : {
              ...(details.reservation.name === undefined
                ? {}
                : { name: details.reservation.name }),
              ...(details.reservation.time === undefined
                ? {}
                : { time: details.reservation.time }),
              ...(details.reservation.partySize === undefined
                ? {}
                : { partySize: details.reservation.partySize }),
              ...(details.reservation.reference === undefined
                ? {}
                : { reference: details.reservation.reference }),
            };
      return {
        kind: 'event',
        ...(details.description === undefined
          ? {}
          : { description: details.description }),
        ...(details.priceCents === undefined ? {} : { priceCents: details.priceCents }),
        ...(details.currency === undefined ? {} : { currency: details.currency }),
        ...(details.ticketUrl === undefined ? {} : { ticketUrl: details.ticketUrl }),
        ...(details.organiser === undefined ? {} : { organiser: details.organiser }),
        ...(reservation === undefined ? {} : { reservation }),
      };
    }
    case 'custom':
      return {
        kind: 'custom',
        ...(details.shortcutId === undefined ? {} : { shortcutId: details.shortcutId }),
      };
    default:
      return assertNever(details, 'ActivityDetails');
  }
}

function projectStoredSchedule(
  schedule: NonNullable<ParsedActivity['schedule']>,
): ActivitySchedule {
  return {
    date: schedule.date,
    timezone: schedule.timezone,
    ...(schedule.time === undefined ? {} : { time: schedule.time }),
    ...(schedule.endTime === undefined ? {} : { endTime: schedule.endTime }),
    ...(schedule.scheduledAtUtc === undefined
      ? {}
      : { scheduledAtUtc: schedule.scheduledAtUtc }),
    ...(schedule.endAtUtc === undefined ? {} : { endAtUtc: schedule.endAtUtc }),
  };
}

/**
 * Both projections are built **field by field, never by spreading** — the same rule as
 * `toUser` and `toDevice`. A stored row carries `pk`, `sk` and `entity`, and every future
 * storage attribute arrives on it too (`agent-playbook.md` §6.11, `data-model.md` §8).
 *
 * ## `listId` and `listItemId` are deliberately absent
 *
 * `api-contract.md` §2.3 gates the reverse link: a Plan participant outside the list
 * receives no `listId` / `listItemId`. Those fields stay off this projection. The gated
 * named link is optional `ActivityDetail.sourceList`, hydrated only after the caller
 * proves list access (the same pointer grant `assertListAccess` uses). Emitting the ids
 * here would bypass that gate. The test below fails if they are added without it.
 */
function toActivity(stored: ParsedActivity): Activity {
  const projected = {
    activityId: stored.activityId,
    ownerId: stored.ownerId,
    status: stored.status,
    title: stored.title,
    ...(stored.notes === undefined ? {} : { notes: stored.notes }),
    ...(stored.schedule === undefined
      ? {}
      : { schedule: projectStoredSchedule(stored.schedule) }),
    ...(stored.recurrence === undefined ? {} : { recurrence: stored.recurrence }),
    ...(stored.location === undefined
      ? {}
      : {
          location: {
            label: stored.location.label,
            ...(stored.location.address === undefined
              ? {}
              : { address: stored.location.address }),
            ...(stored.location.lat === undefined ? {} : { lat: stored.location.lat }),
            ...(stored.location.lng === undefined ? {} : { lng: stored.location.lng }),
            ...(stored.location.mapUrl === undefined
              ? {}
              : { mapUrl: stored.location.mapUrl }),
          },
        }),
    ...(stored.parentActivityId === undefined
      ? {}
      : { parentActivityId: stored.parentActivityId }),
    // `listId` and `listItemId` are not projected — see the note above. Phase 3.
    ...(stored.sourceUrl === undefined ? {} : { sourceUrl: stored.sourceUrl }),
    ...(stored.primaryAttachmentId === undefined
      ? {}
      : { primaryAttachmentId: stored.primaryAttachmentId }),
    details: projectStoredDetails(stored.details),
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
  };
  return stored.objectKind === 'task'
    ? { ...projected, objectKind: 'task', type: 'task' }
    : { ...projected, objectKind: 'plan', type: stored.type };
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
