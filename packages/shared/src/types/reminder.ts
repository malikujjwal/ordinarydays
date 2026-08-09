import type { UserId } from '../schemas/common.js';

/**
 * One user's reminder on one activity — `ACT#<activityId>` / `REM#<userId>#<reminderId>`
 * (`data-model.md` §3.1, §4.3).
 *
 * **A `Reminder` is its own item, and `Activity` has no `reminders[]` field.** A shared plan
 * has one schedule and many reminder sets: if the owner wants "leave in 15 minutes", that is
 * theirs, and a participant must not receive it because the owner created the plan. Keying
 * on `userId` inside the activity partition means one `Query` still serves both the detail
 * screen (filtered to the caller) and the reminder scheduler (all of them).
 *
 * `userId` is therefore **never inherited from the creator**. A joiner's row comes from their
 * own saved `User.defaultReminderOffset` at join time (P6-13), not from copying anyone's.
 * ADR-047.
 */
export interface Reminder {
  reminderId: string;
  activityId: string;
  /** Whose reminder this is. The field the whole per-user design rests on. */
  userId: UserId;
  /** Negative is before the start. `0` is at the start time. */
  offsetMinutes: number;
  /** Email and SMS are out of scope for v1. */
  channel: 'push';
}
