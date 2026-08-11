import { differenceInWallDays, expandRecurrence } from '@od/shared/recurrence';
import type { ScheduleActivityInput, ScheduleActivityResult } from '@od/shared/schemas';
import { activity as activitySchema } from '@od/shared/schemas';
import type { Activity, Occurrence } from '@od/shared/types';
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
import { toSchedule } from './activityService.js';
import { assertActivityAccess } from './authz.js';
import {
  type CleanupPhaseExecutor,
  drainActivityCleanup,
  drainCleanup,
} from './idempotencyCleanupService.js';

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
  const result: ScheduleActivityResult = { activity: projectActivity(previous) };
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

  const kinds: CleanupPhase['kind'][] = [];
  if (input.date === null) kinds.push('delete_reminders');
  if (normalised) kinds.push('normalise_untimed_reminders');
  const deferredParticipants =
    changedParticipants.length > 45 || (clearDate && participants.length > 45);
  if (deferredParticipants) kinds.push('reset_rsvp');

  const result: ScheduleActivityResult = {
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
  await writeSchedule(next, {
    previous,
    indexedUserIds,
    ...(!deferredParticipants && changedParticipants.length > 0
      ? { participantRows: changedParticipants }
      : {}),
    idempotencyReceipt: receipt,
    ...(work === undefined ? {} : { cleanupWork: work }),
    ...(deferredParticipants ? { rsvpResetPending: true } : {}),
  });
  if (work !== undefined) await drainScheduleCleanup(ref);
  return result;
}
