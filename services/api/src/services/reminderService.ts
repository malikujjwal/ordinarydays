import { MAX_REMINDERS_PER_USER_PER_ACTIVITY } from '@od/shared/constants';
import { type ReminderInput, reminderInputForSchedule } from '@od/shared/schemas';
import type { Reminder } from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import type { IdempotencyReceipt } from '../lib/idempotency.js';
import { newReminderId } from '../repositories/activityRepository.js';
import {
  createForUser,
  deleteForUser,
  listForUser,
} from '../repositories/reminderRepository.js';
import { assertActivityAccess } from './authz.js';
import { drainActivityCleanup } from './idempotencyCleanupService.js';
import { executeScheduleCleanup } from './scheduleService.js';

const NEEDS_DATE = 'A reminder needs a scheduled date.';
const DUPLICATE = 'A reminder already exists at this offset.';
const LIMIT = 'You can add up to 3 reminders.';
const NOT_FOUND = 'Reminder not found.';

type ReceiptFor = (reminder: Reminder) => IdempotencyReceipt;

function requireSchedule(
  schedule: Parameters<typeof reminderInputForSchedule>[0],
): NonNullable<typeof schedule> {
  if (schedule === undefined) {
    throw new AppError('validation_failed', NEEDS_DATE, [
      { path: 'offsetMinutes', message: NEEDS_DATE },
    ]);
  }
  return schedule;
}

/** Lists the caller's rows only, after proving they may read the activity. */
export async function listReminders(
  userId: string,
  activityId: string,
): Promise<Reminder[]> {
  const { activity } = await assertActivityAccess(userId, activityId, 'read');
  requireSchedule(activity.schedule);
  return listForUser(activityId, userId);
}

/** Creates one caller-owned reminder with the same schedule rules as activity creation. */
export async function createReminder(
  userId: string,
  activityId: string,
  input: ReminderInput,
  now: string,
  receiptFor: ReceiptFor,
): Promise<Reminder> {
  await drainActivityCleanup(activityId, executeScheduleCleanup);
  const { activity } = await assertActivityAccess(userId, activityId, 'read');
  const parsed = reminderInputForSchedule(requireSchedule(activity.schedule)).parse(
    input,
  );
  const existing = await listForUser(activityId, userId);

  if (existing.some((row) => row.offsetMinutes === parsed.offsetMinutes)) {
    throw new AppError('conflict', DUPLICATE, [
      { path: 'offsetMinutes', message: DUPLICATE },
    ]);
  }
  if (existing.length >= MAX_REMINDERS_PER_USER_PER_ACTIVITY) {
    throw new AppError('reminder_limit_exceeded', LIMIT);
  }

  const reminder: Reminder = {
    reminderId: newReminderId(),
    activityId,
    userId,
    offsetMinutes: parsed.offsetMinutes,
    channel: 'push',
  };
  await createForUser(activityId, userId, reminder, now, receiptFor(reminder));
  return reminder;
}

/** Deletes one caller-owned reminder; another user's id is indistinguishable from absence. */
export async function removeReminder(
  userId: string,
  activityId: string,
  reminderId: string,
): Promise<string> {
  await drainActivityCleanup(activityId, executeScheduleCleanup);
  const { activity } = await assertActivityAccess(userId, activityId, 'read');
  requireSchedule(activity.schedule);
  try {
    await deleteForUser(activityId, userId, reminderId);
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      throw new AppError('not_found', NOT_FOUND);
    }
    throw error;
  }
  return reminderId;
}
