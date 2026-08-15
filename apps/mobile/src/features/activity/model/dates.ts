import { addDays, format, nextMonday, nextSaturday, parseISO } from 'date-fns';

/**
 * The reschedule sheet's quick chips, and the formatting the detail screen reads dates with
 * (`activities.md` §3 rule 4, `coding-standards.md` §4.2, §4.4).
 *
 * ## Everything here is wall-clock, and that is the point
 *
 * A `WallDate` is `YYYY-MM-DD` with no zone attached — what "Friday" means to a user
 * (`data-model.md` §6). `Tomorrow` is a *calendar* operation: it is the next day on the
 * user's wall, not 24 hours after an instant, and the two differ across a DST boundary. So
 * every function here takes and returns date strings and never constructs an `Instant`.
 *
 * ## `today` is a parameter, not a lookup
 *
 * `new Date()` and `Date.now()` are banned inside pure logic (`coding-standards.md` §4.3) —
 * without that rule "what does This weekend mean?" is untestable and every test depends on
 * the day it ran. The caller passes the user's today; here it is the hook that reads it.
 *
 * > **Owned later by `packages/shared/src/time/`.** That module and its injected `Clock` do
 * > not exist yet — no task has built them, and inventing them from a mobile feature would
 * > put the product's date arithmetic in the wrong package. These are wall-date helpers with
 * > no zone conversion in them, which is the subset this screen needs; the shared module
 * > absorbs them when it lands, and `date-fns-tz` arrives with it.
 */

/** `YYYY-MM-DD`. Named for readability, not enforced — `packages/shared` owns the brand. */
export type WallDate = string;

const toDate = (wall: WallDate): Date => parseISO(wall);
const toWall = (date: Date): WallDate => format(date, 'yyyy-MM-dd');

export interface QuickDate {
  key: string;
  label: string;
  /** `undefined` for `Pick a date`, which opens the picker rather than committing a value. */
  date?: WallDate;
}

/**
 * `Today`, `Tomorrow`, `This weekend`, `Next week`, `Pick a date` — the fixed set and the
 * fixed order from `activities.md` §3 rule 4.
 *
 * `This weekend` is the coming Saturday, and on a Saturday it is *today's* Saturday rather
 * than the one eight days away — `nextSaturday` would skip it, so the same-day case is
 * handled before asking for the next one. `Next week` is the coming Monday, by the same rule.
 */
export function quickDates(today: WallDate): QuickDate[] {
  const base = toDate(today);
  const saturday = base.getDay() === 6 ? base : nextSaturday(base);
  const monday = base.getDay() === 1 ? addDays(base, 7) : nextMonday(base);

  /**
   * **Named days, not vague spans.** The founder's frames are explicit: "concrete date
   * shortcuts instead of ambiguous ones". `This weekend` on a Sunday and `Next week` on a
   * Friday each mean at least two different things depending on who is reading, and the row
   * renders the resolved date beside the label so the shortcut is never a guess.
   */
  return [
    { key: 'today', label: 'Today', date: today },
    { key: 'tomorrow', label: 'Tomorrow', date: toWall(addDays(base, 1)) },
    { key: 'weekend', label: format(saturday, 'EEEE'), date: toWall(saturday) },
    { key: 'nextWeek', label: `Next ${format(monday, 'EEEE')}`, date: toWall(monday) },
    { key: 'pick', label: 'Pick a date' },
  ];
}

/** `Wed, Aug 12` — the resolved date a quick option commits to, shown beside its label. */
export function formatQuickDate(date: WallDate, today: WallDate): string {
  const parsed = toDate(date);
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  return format(parsed, sameYear ? 'EEE, MMM d' : 'EEE, MMM d yyyy');
}

/**
 * The `6:00 PM → 7:00 PM` line the scope question carries (P2-42).
 *
 * **The question is asked after the edit, so the edit has to be visible while it is asked.**
 * `Apply changes to` used to be the sheet's opening state, where there was nothing yet to
 * apply — the user chose a scope for a change they had not made, then made it. Asking second
 * only helps if the summary says what is being scoped, which is why this returns the smallest
 * honest difference rather than the whole schedule.
 *
 * `undefined` when nothing moved: a summary reading `6:00 PM → 6:00 PM` is noise, and the two
 * options still mean what their labels say.
 */
export function formatScheduleChange(
  before: { date: WallDate; time: string | null },
  after: { date: WallDate; time: string | null },
  today: WallDate,
): string | undefined {
  const movedDate = before.date !== after.date;
  const movedTime = before.time !== after.time;
  if (!movedDate && !movedTime) return undefined;

  // A time with no time is `Anytime` — the word the rest of the product uses for an all-day row.
  const side = (value: { date: WallDate; time: string | null }): string => {
    const time = value.time === null ? 'Anytime' : formatWallTime(value.time);
    return movedDate ? `${formatQuickDate(value.date, today)} · ${time}` : time;
  };

  return `${side(before)} → ${side(after)}`;
}

/**
 * `Fri 14 Aug`, or `Fri 14 Aug 2027` when the year is not the current one.
 *
 * The year is dropped for the common case and restored when it matters, so a date in the
 * user's own month does not carry four digits nobody reads — and a date eighteen months out
 * is never ambiguous.
 */
export function formatWallDate(date: WallDate, today: WallDate): string {
  const parsed = toDate(date);
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  return format(parsed, sameYear ? 'EEE d MMM' : 'EEE d MMM yyyy');
}

/** `6:00 PM`. Wall-clock, so no zone is involved and none is applied. */
export function formatWallTime(time: string): string {
  const [hours = '0', minutes = '00'] = time.split(':');
  const hour = Number.parseInt(hours, 10);
  const suffix = hour < 12 ? 'AM' : 'PM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${minutes} ${suffix}`;
}

/**
 * The detail header's one line: `Fri, Aug 14 · 6:00 PM – 8:00 PM`, or `Not scheduled`.
 *
 * `Not scheduled` rather than an empty row, because an undated plan is a plan and the row is
 * never hidden (`plans-and-lists.md` §2.2).
 */
export function formatSchedule(
  schedule: { date: string; time?: string; endTime?: string } | undefined,
  today: WallDate,
): string {
  if (schedule === undefined) return 'Not scheduled';

  const parsed = toDate(schedule.date);
  const sameYear = schedule.date.slice(0, 4) === today.slice(0, 4);
  const parts = [format(parsed, sameYear ? 'EEE, MMM d' : 'EEE, MMM d, yyyy')];
  if (schedule.time !== undefined) {
    parts.push(
      schedule.endTime === undefined
        ? formatWallTime(schedule.time)
        : `${formatWallTime(schedule.time)} – ${formatWallTime(schedule.endTime)}`,
    );
  }
  return parts.join(' · ');
}

/** `15 minutes before`, `1 hour before`, `2 days before`. Offsets are negative minutes. */
export function formatReminderOffset(offsetMinutes: number): string {
  const minutes = Math.abs(offsetMinutes);
  if (minutes === 0) return 'At the time';
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} ${days === 1 ? 'day' : 'days'} before`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} before`;
  }
  return `${minutes} minutes before`;
}
