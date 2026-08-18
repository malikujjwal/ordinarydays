import { z } from 'zod';
import { ulidId, userId } from './common.js';

/** The schedule fields that change which reminder offsets are meaningful. */
export interface ReminderSchedule {
  readonly date: string;
  readonly time?: string | undefined;
}

const reminderOffsetMinutes = z
  .number()
  .int('A reminder offset is a whole number of minutes')
  .min(-10080, 'A reminder cannot be more than a week before')
  .max(0, 'A reminder cannot be after the start');

/**
 * A per-user reminder (`data-model.md` §4.3). Interface in `../types/reminder.ts`.
 *
 * `userId` is a required field on the stored item, which is the whole design: it is what
 * lets one `Query` serve both the caller-filtered detail projection and the reminder
 * scheduler that needs every row (access patterns 4 and 4b).
 */
export const reminder = z
  .object({
    reminderId: ulidId('rem'),
    activityId: ulidId('act'),
    userId,
    offsetMinutes: reminderOffsetMinutes,
    channel: z.literal('push'),
  })
  .meta({ id: 'Reminder' });

/**
 * What a client may send when creating a reminder alongside an activity.
 *
 * **The offset, and optionally the id.** `userId` is the caller's, taken from the identity
 * seam and never from the body — a body that could name a user would let one person set
 * another's reminders. `channel` has one value and is defaulted server-side rather than
 * accepted.
 *
 * `reminderId` is the client-minted canonical id, exactly as `createActivityInput.activityId`
 * is for `act_` (P2-49, ADR-055). A reminder set offline is identity-complete from birth, so
 * the device can arm a local notification for it before any server has heard of it, and the
 * eventual conditional create is idempotent on the id the device already used. Identity is
 * client-mintable; **authority is not** — `userId`, `createdAt` and every derived field stay
 * the server's, and the id is validated for prefix and encoding like any other.
 */
export const reminderInput = z
  .strictObject({
    reminderId: ulidId('rem').optional(),
    offsetMinutes: reminderOffsetMinutes,
  })
  .transform((value) => ({
    ...(value.reminderId === undefined ? {} : { reminderId: value.reminderId }),
    offsetMinutes: Object.is(value.offsetMinutes, -0) ? 0 : value.offsetMinutes,
  }))
  .meta({ id: 'ReminderInput' });

export type ReminderInput = z.infer<typeof reminderInput>;

/**
 * The schedule-aware reminder input used at both public and internal service boundaries.
 *
 * A reminder needs a date. A timed activity accepts minute precision; a date-only activity
 * has no instant to subtract minutes from, so only whole-day offsets are meaningful.
 */
export function reminderInputForSchedule(schedule: ReminderSchedule | undefined) {
  return reminderInput.superRefine((value, ctx) => {
    if (schedule === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['offsetMinutes'],
        message: 'A reminder needs a scheduled date.',
      });
      return;
    }
    if (schedule.time === undefined && value.offsetMinutes % 1440 !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['offsetMinutes'],
        message: 'A date-only reminder must be a whole number of days before.',
      });
    }
  });
}

/** The create path validates the whole caller-owned reminder set against one schedule. */
export function reminderInputsForSchedule(schedule: ReminderSchedule | undefined) {
  return z.array(reminderInputForSchedule(schedule));
}

/** What a reminder deletion acknowledges in the standard response envelope. */
export const deletedReminder = z
  .object({ reminderId: ulidId('rem') })
  .meta({ id: 'DeletedReminder' });
