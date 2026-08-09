/**
 * The reminder picker's options (`notifications.md` §3, §2.1).
 *
 * Two lists, because a reminder is an offset from an instant and an untimed activity has
 * none. §3.2 is explicit: sub-day offsets "are not offered on an untimed item; the picker
 * shows `On the day`, `1 day before`, `2 days before`, `Custom…`", where the item fires at
 * the user's all-day reminder hour instead.
 *
 * **Only three of the six forms show this control at all** — Task, Event and General. Meal,
 * Watch and Outing have no Reminder row in `activities.md` §4 and §2.1 says so outright, which
 * is also why the profile default does not apply at their creation.
 */
export interface ReminderOption {
  /** Minutes relative to the fire instant. `undefined` is `Off` — no `REM#` row is written. */
  offsetMinutes: number | undefined;
  label: string;
}

const OFF: ReminderOption = { offsetMinutes: undefined, label: 'Off' };

/** §3's picker list, in its order. `0` is a real reminder; `Off` is the absence of one. */
export const TIMED_REMINDER_OPTIONS: readonly ReminderOption[] = Object.freeze([
  OFF,
  { offsetMinutes: 0, label: 'At the time' },
  { offsetMinutes: -5, label: '5 minutes before' },
  { offsetMinutes: -15, label: '15 minutes before' },
  { offsetMinutes: -30, label: '30 minutes before' },
  { offsetMinutes: -60, label: '1 hour before' },
  { offsetMinutes: -120, label: '2 hours before' },
  { offsetMinutes: -1440, label: '1 day before' },
  { offsetMinutes: -2880, label: '2 days before' },
]);

/** §3.2's untimed list. `On the day` is the all-day hour itself, so its offset is zero. */
export const UNTIMED_REMINDER_OPTIONS: readonly ReminderOption[] = Object.freeze([
  OFF,
  { offsetMinutes: 0, label: 'On the day' },
  { offsetMinutes: -1440, label: '1 day before' },
  { offsetMinutes: -2880, label: '2 days before' },
]);

export function reminderOptions(hasTime: boolean): readonly ReminderOption[] {
  return hasTime ? TIMED_REMINDER_OPTIONS : UNTIMED_REMINDER_OPTIONS;
}

/**
 * The offset that survives a switch between the two lists.
 *
 * Setting a time on an activity reminded `2 days before` must not silently drop the reminder,
 * and clearing a time on one reminded `15 minutes before` must not leave a value the untimed
 * picker cannot show. Anything the new list does not offer falls back to `Off`, which is the
 * only honest answer: the control then reads exactly what will happen.
 */
export function reconcileReminder(
  offsetMinutes: number | undefined,
  hasTime: boolean,
): number | undefined {
  if (offsetMinutes === undefined) return undefined;
  const offered = reminderOptions(hasTime).some(
    (option) => option.offsetMinutes === offsetMinutes,
  );
  return offered ? offsetMinutes : undefined;
}
