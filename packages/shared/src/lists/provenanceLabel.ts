import { format, parseISO } from 'date-fns';
import { differenceInWallDays } from '../recurrence/calendar.js';

/** How near a meal has to be for its weekday to identify it unambiguously. */
const NEAR_DAYS = 7;

/** What the label needs to know about the meal it names. */
export interface LabelSourceMeal {
  readonly title: string;
  /** The meal's scheduled wall date, `YYYY-MM-DD`. Absent for a meal with no date. */
  readonly date?: string;
  readonly mealSlot?: 'breakfast' | 'lunch' | 'dinner' | 'snack';
}

/**
 * `ListItem.sourceLabel` — where a grocery item came from, in a few human words
 * (`plans-and-lists.md` §7.5, `phase-03` §P3-17).
 *
 * ## Computed once, stored, never recomputed
 *
 * This runs at creation and its result is written onto the item. That is the whole design:
 * a label recomputed on read would silently change when the meal is rescheduled and become
 * a lie when the meal is deleted, and the item is supposed to record where it came from —
 * which is a fact about the past that rescheduling does not alter (acceptance criterion 15).
 * Nothing may call this with a stored item in hand.
 *
 * ## Why `today` is a parameter
 *
 * §P3-17 writes the signature as `provenanceLabel(meal, existingLabelsOnList)`, and that
 * function cannot be pure: rules 1–3 turn on how far away the meal is, which means reading a
 * clock. Passing the reference date in keeps the rule testable without freezing time and
 * keeps the zone decision where the zone is actually known — the caller has the meal's
 * timezone and the request's; this function has neither and must not guess.
 *
 * ## The rules
 *
 * 1. Scheduled within 7 days **and** has a slot → `Sunday dinner`.
 * 2. Scheduled within 7 days, no slot → `Sunday`.
 * 3. Scheduled further off → `23 Aug dinner`, and `23 Aug` when there is no slot. §7.5
 *    writes rule 3 with a slot only; dropping it when absent is the same choice rule 2 makes
 *    for rule 1, rather than emitting a trailing space.
 * 4. Unscheduled → the meal's title.
 * 5. If rules 1–3 produced a label already on the list **from a different meal**, the meal
 *    title is appended: `Sunday dinner · Chicken tacos`.
 *
 * A meal **in the past** takes rule 3, not rule 2. `Sunday` identifies a day only while it is
 * the nearest one; for anything outside the window — behind as well as ahead — the absolute
 * date is the honest label, and `23 Aug` reads correctly whichever side of today it falls.
 *
 * @param existingLabels Labels already on the destination list **from other meals only**.
 * Filtering to "other" is the caller's, because ownership lives in the item's storage-only
 * activity-keyed provenance segments and this pure function is given strings. Passing this
 * meal's own labels in would make it disambiguate itself from itself.
 */
export function provenanceLabel(
  meal: LabelSourceMeal,
  existingLabels: readonly string[],
  today: string,
): string {
  const title = meal.title.trim();
  const date = meal.date;

  // Rule 4. The title is already unique to this meal, so rule 5 has nothing to add to it —
  // `Chicken tacos · Chicken tacos` disambiguates nothing.
  if (date === undefined) return title;

  const away = differenceInWallDays(date, today);
  const near = away >= 0 && away <= NEAR_DAYS;
  const when = near ? weekdayOf(date) : monthDayOf(date);
  const base = meal.mealSlot === undefined ? when : `${when} ${meal.mealSlot}`;

  // Rule 5.
  return existingLabels.includes(base) ? `${base} · ${title}` : base;
}

/** Noon, so a wall date cannot cross a day boundary on a DST transition. */
function atNoon(date: string): Date {
  return parseISO(`${date}T12:00:00`);
}

function weekdayOf(date: string): string {
  return format(atNoon(date), 'EEEE');
}

function monthDayOf(date: string): string {
  return format(atNoon(date), 'd MMM');
}
