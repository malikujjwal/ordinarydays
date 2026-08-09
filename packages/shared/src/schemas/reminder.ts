import { z } from 'zod';
import { ulidId, userId } from './common.js';

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
    offsetMinutes: z
      .number()
      .int('A reminder offset is a whole number of minutes')
      .min(-10080, 'A reminder cannot be more than a week before')
      .max(0, 'A reminder cannot be after the start'),
    channel: z.literal('push'),
  })
  .meta({ id: 'Reminder' });

/**
 * What a client may send when creating a reminder alongside an activity.
 *
 * **Only the offset.** `userId` is the caller's, taken from the identity seam and never from
 * the body — a body that could name a user would let one person set another's reminders.
 * `channel` has one value and is defaulted server-side rather than accepted.
 */
export const reminderInput = z
  .strictObject({
    offsetMinutes: z
      .number()
      .int('A reminder offset is a whole number of minutes')
      .min(-10080, 'A reminder cannot be more than a week before')
      .max(0, 'A reminder cannot be after the start'),
  })
  .meta({ id: 'ReminderInput' });
