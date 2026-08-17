import {
  addDays,
  format,
  isSaturday,
  isSunday,
  nextMonday,
  nextSaturday,
  parse,
  parseISO,
} from 'date-fns';

/**
 * Wall-clock values and the pure arithmetic the two pickers need.
 *
 * A **wall date** is `YYYY-MM-DD` and a **wall time** is `HH:mm`, both with no zone attached
 * — what "Thursday" and "6 PM" mean to a person (`data-model.md` §6). They are declared here
 * rather than imported because `packages/ui` depends on **no** workspace package
 * (`repo-structure.md` §2.2), so it cannot reach `@od/shared` for them. They are plain
 * aliases on purpose: the moment `shared` brands them, a branded value still assigns to a
 * `string` parameter and the primitives keep compiling.
 *
 * Everything here is pure and takes `today` as an argument. No `new Date()`, no `Date.now()`
 * (`coding-standards.md` §11 smell 6) — which is why the weekend and next-week rules can be
 * asserted on a Tuesday and on a Saturday in the same test run.
 */
export type WallDate = string;
export type WallTime = string;

/** `parseISO`, not `new Date(string)` — the latter reads `'2026-08-08'` as UTC midnight. */
const asDate = (date: WallDate): Date => parseISO(date);

/**
 * The reference instant `parse` fills the unspecified fields from.
 *
 * Fixed at the epoch rather than `new Date()`: only hours and minutes are read back out, and
 * a reference that moves would make these functions depend on the day they ran.
 */
const TIME_REFERENCE = new Date(0);

const asTime = (time: WallTime): Date => parse(time, 'HH:mm', TIME_REFERENCE);

/** A `Date` back to the wall date it represents in the same (local) reading. */
export const toWallDate = (date: Date): WallDate => format(date, 'yyyy-MM-dd');

/** A `Date` back to the wall time it represents, to the minute. */
export const toWallTime = (date: Date): WallTime => format(date, 'HH:mm');

export const wallDateToDate = asDate;
export const wallTimeToDate = asTime;

/**
 * `Sat, Aug 8` — the format `design-system.md` §7.3 renders on a plan card.
 *
 * Via `date-fns`, because `coding-standards.md` §4.4 rules out slicing the string or carrying
 * a month-name array.
 */
export const formatWallDate = (date: WallDate): string =>
  format(asDate(date), 'EEE, MMM d');

/**
 * `Thursday, August 6` — Today's day caption (`design-system.md` §7.1).
 *
 * Long where {@link formatWallDate} is short, because this one is the screen's only statement of
 * which day it is: `Thu, Aug 6` above a serif `Today` reads as metadata, and §7.1 draws it as
 * the sentence that dates the page. `Text`'s `caption` variant uppercases it.
 */
export const formatDayCaption = (date: WallDate): string =>
  format(asDate(date), 'EEEE, MMMM d');

/** `12:00 PM` — the same §7.3 format, and the one the time rail uses. */
export const formatWallTime = (time: WallTime): string => format(asTime(time), 'h:mm a');

/**
 * The date quick chips, in the order `activities.md` §3.4 lists them.
 *
 * `pick` opens the calendar and resolves to no date of its own, which is why
 * {@link resolveQuickDate} returns `null` for it.
 */
export const DATE_QUICK_OPTIONS = [
  'today',
  'tomorrow',
  'this-weekend',
  'next-week',
  'pick',
] as const;

export type DateQuickOption = (typeof DATE_QUICK_OPTIONS)[number];

/** The visible copy for each chip, verbatim from `activities.md` §3.4. */
export const DATE_QUICK_LABELS: Record<DateQuickOption, string> = {
  today: 'Today',
  tomorrow: 'Tomorrow',
  'this-weekend': 'This weekend',
  'next-week': 'Next week',
  pick: 'Pick a date',
};

/**
 * Which date a quick chip means, relative to `today`. `null` for `pick`, which opens the
 * calendar instead of choosing anything.
 *
 * Two rules the product docs leave open, decided here and stated so the next reader does not
 * have to infer them from the arithmetic:
 *
 * - **This weekend** is the coming Saturday, or today when today is already Saturday or
 *   Sunday. Skipping to next Saturday on a Saturday would offer a date a week away under a
 *   chip that says "this".
 * - **Next week** is the coming Monday, always strictly after today — so on a Monday it means
 *   the Monday seven days out, not this morning.
 */
export function resolveQuickDate(
  option: DateQuickOption,
  today: WallDate,
): WallDate | null {
  const base = asDate(today);

  switch (option) {
    case 'today':
      return today;
    case 'tomorrow':
      return toWallDate(addDays(base, 1));
    case 'this-weekend':
      return isSaturday(base) || isSunday(base) ? today : toWallDate(nextSaturday(base));
    case 'next-week':
      return toWallDate(nextMonday(base));
    case 'pick':
      return null;
  }
}

/**
 * Whether a wall date sits inside an optional `min`/`max` window.
 *
 * String comparison is correct for `YYYY-MM-DD` and only for that shape: the format is
 * fixed-width and big-endian, so lexicographic order is chronological order.
 */
export function isWallDateInRange(
  date: WallDate,
  min?: WallDate,
  max?: WallDate,
): boolean {
  if (min !== undefined && date < min) return false;
  if (max !== undefined && date > max) return false;
  return true;
}
