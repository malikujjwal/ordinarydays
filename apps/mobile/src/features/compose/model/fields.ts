import type { ActivityType } from '@od/shared/types';

/**
 * The six field tables from `activities.md` §4, as data (P1-25).
 *
 * **The order is part of the spec, not a suggestion** (§3 rule 3), and a field absent from a
 * type's table does not appear, is not collapsed behind a disclosure and is not greyed out
 * (§3 rule 1). Holding the tables here rather than in six JSX files is what lets one test
 * fail when a field is added, removed or reordered — the test P1-25 asks for — instead of six
 * render tests that each agree with whatever their own component happens to do.
 *
 * The forms render **from** this list. It is not a description of them.
 */
export type FieldKey =
  | 'title'
  | 'date'
  | 'time'
  | 'endTime'
  | 'reminder'
  | 'repeat'
  | 'relatedPlan'
  | 'slot'
  | 'people'
  | 'ingredients'
  | 'addIngredientsTo'
  | 'recipeUrl'
  | 'kind'
  | 'season'
  | 'episode'
  | 'episodeTitle'
  | 'service'
  | 'alsoAddTo'
  | 'location'
  | 'description'
  | 'price'
  | 'ticketUrl'
  | 'organiser'
  | 'sourceImageLink'
  | 'reservation'
  | 'notes';

export interface FieldSpec {
  key: FieldKey;
  /** The label as shown, verbatim from the table's **Field** column. */
  label: string;
}

/**
 * `Time` is `Start time` on an Event, because that table says so and because the Event is the
 * one type where an end time is offered beside it. Two labels for one control is what the
 * table asks for; one label for both would be a quiet edit of the spec.
 */
const field = (key: FieldKey, label: string): FieldSpec => ({ key, label });

const TASK: readonly FieldSpec[] = [
  field('title', 'Title'),
  field('date', 'Date'),
  field('time', 'Time'),
  field('reminder', 'Reminder'),
  field('repeat', 'Repeat'),
  field('relatedPlan', 'Related plan'),
  field('notes', 'Notes'),
];

const MEAL: readonly FieldSpec[] = [
  field('title', 'Meal'),
  field('date', 'Date'),
  field('time', 'Time'),
  field('slot', 'Slot'),
  field('people', 'People'),
  field('ingredients', 'Ingredients'),
  field('addIngredientsTo', 'Add selected ingredients to…'),
  field('recipeUrl', 'Recipe link'),
  field('notes', 'Notes'),
];

const WATCH: readonly FieldSpec[] = [
  field('title', 'Movie or show'),
  field('kind', 'Kind'),
  field('season', 'Season'),
  field('episode', 'Episode'),
  field('episodeTitle', 'Episode title'),
  field('date', 'Date'),
  field('time', 'Time'),
  field('people', 'People'),
  field('service', 'Streaming service'),
  field('alsoAddTo', 'Also add to…'),
  field('notes', 'Notes'),
];

const EVENT: readonly FieldSpec[] = [
  field('title', 'Title'),
  field('date', 'Date'),
  field('time', 'Start time'),
  field('endTime', 'End time'),
  field('location', 'Location'),
  field('description', 'Description'),
  field('people', 'People'),
  field('price', 'Price'),
  field('ticketUrl', 'Ticket link'),
  field('organiser', 'Organiser'),
  field('sourceImageLink', 'Source image / link'),
  field('reminder', 'Reminder'),
  field('notes', 'Notes'),
];

const OUTING: readonly FieldSpec[] = [
  field('title', 'Place'),
  field('date', 'Date'),
  field('time', 'Time'),
  field('endTime', 'End time'),
  field('location', 'Location'),
  field('people', 'People'),
  field('reservation', 'Reservation'),
  field('notes', 'Notes'),
];

const CUSTOM: readonly FieldSpec[] = [
  field('title', 'Title'),
  field('date', 'Date'),
  field('time', 'Time'),
  field('people', 'People'),
  field('reminder', 'Reminder'),
  field('repeat', 'Repeat'),
  field('notes', 'Notes'),
];

export const fieldsByType: Readonly<Record<ActivityType, readonly FieldSpec[]>> =
  Object.freeze({
    task: TASK,
    meal: MEAL,
    watch: WATCH,
    event: EVENT,
    outing: OUTING,
    custom: CUSTOM,
  });

/**
 * Whether a field renders **right now**, given the draft's own state.
 *
 * The two conditions in §4 are both on Watch: `Season`, `Episode` and `Episode title` are
 * "shown only when Kind = Show". This is the one place §3 rule 1 admits a hidden field, and
 * it is hidden rather than disabled — a greyed Season on a Movie would be the "collapsed
 * behind a disclosure" the rule forbids, wearing a different hat.
 */
export function isFieldVisible(key: FieldKey, mediaKind: 'movie' | 'show' | undefined) {
  if (key === 'season' || key === 'episode' || key === 'episodeTitle') {
    return mediaKind === 'show';
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/*  The four derivations §4 specifies, and no fifth                            */
/* -------------------------------------------------------------------------- */

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export const MEAL_SLOTS: readonly MealSlot[] = Object.freeze([
  'breakfast',
  'lunch',
  'dinner',
  'snack',
]);

export const mealSlotLabel = (slot: MealSlot): string =>
  slot.charAt(0).toUpperCase() + slot.slice(1);

/**
 * Slot → time (§4.2): breakfast 08:00, lunch 12:30, dinner 19:00, **snack unset**.
 *
 * `undefined` for snack is the table's own value, not an oversight: a snack has no hour the
 * product is willing to guess.
 */
const SLOT_TIME: Readonly<Record<MealSlot, string | undefined>> = Object.freeze({
  breakfast: '08:00',
  lunch: '12:30',
  dinner: '19:00',
  snack: undefined,
});

/**
 * The time a chosen slot implies, **only when no time is set**.
 *
 * The "only when the other is unset" condition is the whole rule. Without it, choosing Dinner
 * after typing 20:15 would silently move the meal an hour and a quarter earlier — the app
 * overwriting something the user typed, which no derivation in this product is allowed to do.
 */
export function timeForSlot(
  slot: MealSlot,
  currentTime: string | undefined,
): string | undefined {
  if (currentTime !== undefined && currentTime !== '') return currentTime;
  return SLOT_TIME[slot];
}

/**
 * The slot a time implies (§4.2): `< 11:00` breakfast, `< 15:00` lunch, `< 17:00` snack, else
 * dinner — and only when no slot is chosen.
 *
 * Note the order: snack sits between lunch and dinner, so a 16:00 meal is a snack rather than
 * an early dinner. That is the table's ordering and it is deliberate.
 */
export function slotForTime(
  time: string,
  currentSlot: MealSlot | undefined,
): MealSlot | undefined {
  if (currentSlot !== undefined) return currentSlot;
  if (time === '') return undefined;
  if (time < '11:00') return 'breakfast';
  if (time < '15:00') return 'lunch';
  if (time < '17:00') return 'snack';
  return 'dinner';
}

/**
 * Watch `Kind` (§4.3): `Show` if a season or episode is entered, else `Movie`.
 *
 * A **default**, not a lock. It answers "what should Kind be before the user has touched it",
 * and an explicit choice always wins — which is why `chosen` is the first parameter and the
 * first thing returned.
 */
export function watchKind(
  chosen: 'movie' | 'show' | undefined,
  season: string,
  episode: string,
): 'movie' | 'show' {
  if (chosen !== undefined) return chosen;
  return season.trim() !== '' || episode.trim() !== '' ? 'show' : 'movie';
}

/**
 * An Outing keeps `title` and `details.placeName` identical (§4.5), and `location.label`
 * **pre-fills** from Place.
 *
 * The difference between the two matters. `placeName` is kept identical — it mirrors on every
 * keystroke. `location.label` only pre-fills: once the user has typed a label of their own,
 * the Place no longer overwrites it, because a venue and its address label are not always the
 * same words.
 */
export function outingLocationLabel(
  place: string,
  currentLabel: string,
  previousPlace: string,
): string {
  return currentLabel === '' || currentLabel === previousPlace ? place : currentLabel;
}
