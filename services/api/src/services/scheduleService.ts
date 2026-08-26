import { differenceInWallDays, expandRecurrence } from '@od/shared/recurrence';
import type { ScheduleActivityInput, ScheduleActivityResult } from '@od/shared/schemas';
import { activity as activitySchema } from '@od/shared/schemas';
import type { Activity, ActivitySchedule, Occurrence } from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import type {
  CleanupPhase,
  CleanupRef,
  CleanupWork,
  IdempotencyReceipt,
} from '../lib/idempotency.js';
import {
  getActivityMeta,
  listParticipants,
  listScheduleCleanupBatch,
  writeSchedule,
  writeScheduleCleanupBatch,
} from '../repositories/activityRepository.js';
import type { StoredItem } from '../repositories/migrate.js';
import {
  getMoveMarker,
  get as getOccurrence,
  writeOccurrenceSchedule,
} from '../repositories/occurrenceRepository.js';
import type { TransactItem } from '../repositories/tx.js';
import { toSchedule } from './activityService.js';
import { assertActivityAccess } from './authz.js';
import {
  type CleanupPhaseExecutor,
  drainActivityCleanup,
  drainCleanup,
} from './idempotencyCleanupService.js';
import { hasUpdatesFeed, writeSystemUpdate } from './updatesService.js';

type ReceiptFor = (data: unknown, cleanupRef?: CleanupRef) => IdempotencyReceipt;

const validation = (path: string, message: string): AppError =>
  new AppError('validation_failed', message, [{ path, message }]);

const terminal = (status: Activity['status']): boolean =>
  status === 'completed' || status === 'skipped' || status === 'cancelled';

const projectActivity = (value: Activity): Activity =>
  activitySchema.parse(value) as Activity;

const exportedSchedule = (activity: Activity): unknown => {
  const schedule = activity.schedule;
  return schedule === undefined
    ? undefined
    : [schedule.date, schedule.time, schedule.endTime, schedule.timezone];
};

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function participantChange(
  row: StoredItem,
  date: string | null,
  reset: boolean,
): StoredItem {
  const next = { ...row };
  if (date === null) {
    delete next.rsvpForDate;
    return next;
  }
  if (!reset || row.rsvp === 'declined') return next;
  next.rsvp = 'pending';
  next.rsvpForDate = date;
  delete next.respondedAt;
  return next;
}

/** Half-day ties move farther from zero, which is earlier for stored negative offsets. */
export function normaliseReminderOffset(offsetMinutes: number): number {
  if (offsetMinutes === 0) return 0;
  if (offsetMinutes % 1440 === 0) return offsetMinutes;
  const days = Math.floor(Math.abs(offsetMinutes) / 1440 + 0.5);
  return days === 0 ? 0 : Math.sign(offsetMinutes) * days * 1440;
}

export const executeScheduleCleanup: CleanupPhaseExecutor = async (work, phase) => {
  const page = await listScheduleCleanupBatch(work.activityId, phase.kind, phase.cursor);
  const last = page.rows.at(-1);

  if (phase.kind === 'delete_reminders') {
    await writeScheduleCleanupBatch(work.activityId, page.rows, { deleteRows: true });
  } else if (phase.kind === 'normalise_untimed_reminders') {
    const rows = page.rows.map((row) => ({
      ...row,
      offsetMinutes: normaliseReminderOffset(Number(row.offsetMinutes)),
    }));
    await writeScheduleCleanupBatch(work.activityId, rows, {});
  } else {
    const activity = await getActivityMeta(work.activityId);
    if (activity === undefined) {
      await writeScheduleCleanupBatch(work.activityId, [], {});
    } else {
      const reset = activity.schedule !== undefined;
      const rows = page.rows.map((row) =>
        participantChange(row, activity.schedule?.date ?? null, reset),
      );
      await writeScheduleCleanupBatch(work.activityId, rows, {
        clearRsvpPending: page.complete,
      });
    }
  }

  return {
    ...(last?.sk === undefined ? {} : { cursor: String(last.sk) }),
    complete: page.complete,
  };
};

export const drainScheduleCleanup = (ref: CleanupRef): Promise<void> =>
  drainCleanup(ref, executeScheduleCleanup);

function cleanupWork(
  ref: CleanupRef,
  kinds: readonly CleanupPhase['kind'][],
  now: string,
): CleanupWork {
  return {
    ...ref,
    phases: kinds.map((kind) => ({ kind, complete: false })),
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
}

function segmentTime(activity: Activity, occurrenceDate: string): string | undefined {
  const segments = activity.recurrence?.segments ?? [];
  return [...segments]
    .reverse()
    .find((segment) => segment.effectiveFrom <= occurrenceDate)?.time;
}

async function scheduleOccurrence(
  previous: Activity,
  input: ScheduleActivityInput,
  timezone: string,
  now: string,
  receiptFor: ReceiptFor,
): Promise<ScheduleActivityResult> {
  const occurrenceDate = input.occurrenceDate;
  if (occurrenceDate === undefined || previous.recurrence === undefined) {
    throw validation('occurrenceDate', 'A recurring occurrence date is required.');
  }
  if (input.date === null) {
    throw validation('date', 'A recurring occurrence cannot be unscheduled.');
  }
  if (previous.schedule === undefined || timezone !== previous.schedule.timezone) {
    throw validation('timezone', 'Occurrence rescheduling uses the series timezone.');
  }
  if (
    !expandRecurrence(
      previous.recurrence,
      occurrenceDate,
      occurrenceDate,
      previous.schedule.timezone,
    ).includes(occurrenceDate)
  ) {
    throw validation('occurrenceDate', 'The date is not emitted by this recurrence.');
  }
  if (Math.abs(differenceInWallDays(input.date, occurrenceDate)) > 60) {
    throw validation('date', 'An occurrence may move at most 60 calendar days.');
  }
  if (input.endTime !== undefined && input.endTime !== previous.schedule.endTime) {
    throw validation('endTime', 'One occurrence cannot change the series end time.');
  }

  const prior = await getOccurrence(previous.activityId, occurrenceDate);
  const baseTime = segmentTime(previous, occurrenceDate) ?? previous.schedule.time;
  const requestedTime = input.time ?? baseTime;
  const redundant = input.date === occurrenceDate && requestedTime === baseTime;
  const value: Occurrence | null = redundant
    ? null
    : {
        activityId: previous.activityId,
        date: occurrenceDate,
        status: 'rescheduled',
        ...(input.date === occurrenceDate ? {} : { overrideDate: input.date }),
        ...(requestedTime === undefined || requestedTime === baseTime
          ? {}
          : { overrideTime: requestedTime }),
      };
  const oldDestination = prior?.overrideDate;
  const newDestination = value?.overrideDate;
  const [oldMarker, newMarker] = await Promise.all([
    oldDestination === undefined
      ? Promise.resolve(null)
      : getMoveMarker(previous.activityId, oldDestination),
    newDestination === undefined || newDestination === oldDestination
      ? Promise.resolve(null)
      : getMoveMarker(previous.activityId, newDestination),
  ]);
  const result: ScheduleActivityResult = {
    activity: projectActivity(previous),
    occurrence: {
      nominalDate: occurrenceDate,
      date: input.date,
      ...(requestedTime === undefined ? {} : { time: requestedTime }),
      ...(previous.schedule.endTime === undefined
        ? {}
        : { endTime: previous.schedule.endTime }),
      status: 'scheduled',
      isSnoozed: false,
    },
  };
  const receipt = receiptFor(result);
  await writeOccurrenceSchedule({
    activityId: previous.activityId,
    sourceDate: occurrenceDate,
    value,
    ...(oldDestination === undefined ? {} : { oldDestination, oldMarker }),
    ...(newDestination === undefined
      ? {}
      : {
          newDestination,
          newMarker: newDestination === oldDestination ? oldMarker : newMarker,
        }),
    receipt,
    now,
  });
  return result;
}

export async function scheduleActivity(
  userId: string,
  activityId: string,
  input: ScheduleActivityInput,
  fallbackTimezone: string,
  now: string,
  receiptFor: ReceiptFor,
): Promise<ScheduleActivityResult> {
  await drainActivityCleanup(activityId, executeScheduleCleanup);
  const { activity: previous } = await assertActivityAccess(userId, activityId, 'owner');
  const timezone = input.timezone ?? fallbackTimezone;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(now));
  } catch {
    throw validation('timezone', 'Timezone must be a recognised IANA timezone.');
  }

  if (previous.recurrence !== undefined || input.occurrenceDate !== undefined) {
    return scheduleOccurrence(previous, input, timezone, now, receiptFor);
  }

  const participants = await listParticipants(activityId);
  const oldDate = previous.schedule?.date;
  const newSchedule =
    input.date === null
      ? undefined
      : toSchedule({
          date: input.date,
          timezone,
          ...(input.time === undefined ? {} : { time: input.time }),
          ...(input.endTime === undefined ? {} : { endTime: input.endTime }),
        });
  const dateReset = input.date !== null && input.date !== oldDate;
  const clearDate = input.date === null && oldDate !== undefined;
  const changedParticipants = participants
    .map((row) => participantChange(row, input.date, dateReset))
    .filter((row, index) => !same(row, participants[index]));
  const rsvpReset =
    dateReset && changedParticipants.some((row) => row.rsvp === 'pending');
  const normalised =
    previous.schedule?.time !== undefined &&
    newSchedule !== undefined &&
    newSchedule.time === undefined;
  const changed = !same(
    exportedSchedule(previous),
    newSchedule === undefined
      ? undefined
      : [newSchedule.date, newSchedule.time, newSchedule.endTime, newSchedule.timezone],
  );
  const next: Activity = {
    ...previous,
    ...(newSchedule === undefined ? {} : { schedule: newSchedule }),
    status: terminal(previous.status)
      ? previous.status
      : newSchedule === undefined
        ? 'saved'
        : 'scheduled',
    icsSequence: previous.icsSequence + (changed ? 1 : 0),
    updatedAt: changed ? now : previous.updatedAt,
  };
  if (newSchedule === undefined) delete (next as { schedule?: unknown }).schedule;

  /**
   * **A schedule write ends any snooze against the schedule it replaced.**
   *
   * A snooze defers *this* occurrence from the time it is currently at
   * (`today-and-tasks.md` §5.3); rescheduling replaces that time, so the deferral has nothing
   * left to defer and its glyph and `6:00 PM → 6:15 PM` affix are describing a schedule that no
   * longer exists. The occurrence path a few lines above has always got this right for free —
   * it writes a **fresh** `Occurrence` with `status: 'rescheduled'`, so the snoozed row is
   * replaced rather than merged. The one-off path spreads `...previous` and so carried
   * `snoozedUntil` across every reschedule, including a `Remove time` that left the activity
   * with no time for it to be relative to.
   *
   * Guarded on `changed` so an idempotent replay, which writes the same schedule back, does not
   * quietly answer a deferral the user still wants.
   */
  if (changed) delete (next as { snoozedUntil?: unknown }).snoozedUntil;

  const kinds: CleanupPhase['kind'][] = [];
  if (input.date === null) kinds.push('delete_reminders');
  if (normalised) kinds.push('normalise_untimed_reminders');
  const deferredParticipants =
    changedParticipants.length > 45 || (clearDate && participants.length > 45);
  if (deferredParticipants) kinds.push('reset_rsvp');

  let result: ScheduleActivityResult = {
    activity: projectActivity(next),
    ...(rsvpReset ? { rsvpReset: true } : {}),
    ...(normalised ? { reminderOffsetsNormalized: true } : {}),
  };
  const seedReceipt = receiptFor(result);
  const ref: CleanupRef = {
    activityId,
    userId: seedReceipt.userId,
    idempotencyKey: seedReceipt.key,
  };
  const work = kinds.length === 0 ? undefined : cleanupWork(ref, kinds, now);
  const receipt = receiptFor(result, work === undefined ? undefined : ref);
  const indexedUserIds = [
    previous.ownerId,
    ...participants.flatMap((row) =>
      typeof row.userId === 'string' ? [row.userId] : [],
    ),
  ];
  /**
   * **Exactly one system entry per schedule event** (§P3-19, `plans-and-lists.md` §1.4).
   *
   * The three events are distinct and mutually exclusive, which is why this is one call and
   * not three appends: a plan either gains its first date, moves to another one, or keeps its
   * date and changes its time. An unscheduling is a fourth — the plan loses its date and
   * returns to Needs a date — and it is recorded too, because "the date went away" is exactly
   * the kind of thing a participant coming back to the plan needs to see.
   *
   * A write that changes nothing (`changed === false`) writes no entry: an idempotent replay
   * must not add a row saying the date was set to what it already was. Nor does a **Task**:
   * the feed is the plan's, and Task detail has no section that could ever show one.
   */
  const systemEntry = hasUpdatesFeed(previous)
    ? scheduleSystemEntry(previous, next, changed, now)
    : undefined;

  await writeSchedule(next, {
    previous,
    indexedUserIds,
    ...(systemEntry === undefined ? {} : { extraItems: [systemEntry] }),
    ...(!deferredParticipants && changedParticipants.length > 0
      ? { participantRows: changedParticipants }
      : {}),
    idempotencyReceipt: receipt,
    idempotencyReceiptFor: (committed) => {
      result = { ...result, activity: projectActivity(committed) };
      return receiptFor(result, work === undefined ? undefined : ref);
    },
    ...(work === undefined ? {} : { cleanupWork: work }),
    ...(deferredParticipants ? { rsvpResetPending: true } : {}),
  });
  if (work !== undefined) await drainScheduleCleanup(ref);
  return result;
}

/**
 * The one-line record of what just happened to this plan's schedule, or `undefined`.
 *
 * Copy is deliberately the plain past tense the feed reads in — `plans-and-lists.md` §2.1 row
 * 9 specifies that these entries exist and P3-39 renders them without an author, but neither
 * fixes the wording, so it is settled here and named in the PR. Dates are the stored wall
 * clock, not a localisation: the feed is a record, and a record of "8 PM" that renders as
 * "20:00" to the next reader has changed what it says.
 */
function scheduleSystemEntry(
  previous: Activity,
  next: Activity,
  changed: boolean,
  now: string,
): TransactItem | undefined {
  if (!changed) return undefined;

  const before = previous.schedule;
  const after = next.schedule;

  if (after === undefined) {
    return before === undefined
      ? undefined
      : writeSystemUpdate(previous.activityId, 'Date removed.', now);
  }

  if (before?.date === undefined) {
    return writeSystemUpdate(
      previous.activityId,
      `Date set to ${scheduleLabel(after)}.`,
      now,
    );
  }

  if (before.date !== after.date) {
    return writeSystemUpdate(
      previous.activityId,
      `Date changed to ${scheduleLabel(after)}.`,
      now,
    );
  }

  if (before.time !== after.time) {
    return writeSystemUpdate(
      previous.activityId,
      after.time === undefined ? 'Time removed.' : `Time changed to ${after.time}.`,
      now,
    );
  }

  /**
   * A change this function has no sentence for — an end time, or a timezone. Silence rather
   * than a vague "the schedule changed": an entry nobody can act on is noise in a feed whose
   * value is that every row means something.
   */
  return undefined;
}

/** `2026-08-09` or `2026-08-09 at 19:30` — the stored wall clock, unlocalised. */
function scheduleLabel(schedule: ActivitySchedule): string {
  return schedule.time === undefined
    ? schedule.date
    : `${schedule.date} at ${schedule.time}`;
}
