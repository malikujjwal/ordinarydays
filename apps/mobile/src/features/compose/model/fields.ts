import type { ActivityType } from '@od/shared/types';

/**
 * The five field tables from `activities.md` §4, as data (P1-25).
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
  | 'ticketsAndDetails'
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
  field('people', 'People'),
  field('reservation', 'Reservation'),
  field('ticketsAndDetails', 'Tickets & details'),
  field('description', 'Description'),
  field('sourceImageLink', 'Source image / link'),
  field('reminder', 'Reminder'),
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
    custom: CUSTOM,
  });

/**
 * The fields whose behaviour belongs to a later phase, and which therefore **do not render**
 * (P2-43).
 *
 * P1-25 drew each of these as a greyed control carrying `Adding people arrives in Phase 6.`,
 * on the reasoning that hiding a capability tells the user the product is smaller than it is.
 * The founder's 2026-08-12 amendment, decision 5, reversed that for the creation forms:
 * *nothing unimplemented is drawn*. The 2026-08-13 clarification carves out the **Plan detail**
 * screen, where a future capability may appear as an inert `Coming later` row — a discovery
 * surface for something that already exists. A form is not that: a greyed field in the middle
 * of a form the user is filling is a control that will not answer, which is what §3 rule 1
 * bans in the neighbouring sentence.
 *
 * The row stays in `fieldsByType` because that table is `activities.md` §4, not a render list.
 * The phase that builds the capability deletes its key from here and nothing else.
 */
export const UNBUILT_FIELDS: ReadonlySet<FieldKey> = new Set<FieldKey>([
  'people', //           Participants and sharing — Phase 6
  'relatedPlan', //      The plan picker — Phase 3
  'addIngredientsTo', // The list bridge — Phase 3
  'alsoAddTo', //        The list bridge — Phase 3
]);

/**
 * Where a type's table splits into the form's two regions (P2-43).
 *
 * The value is the index of the first field that sits behind `More options`; everything before
 * it renders directly. **It is always a suffix**, which is what keeps §3 rule 3 — "fields render
 * top-to-bottom in the order given in §4" — true of the visible form: a disclosure holding a
 * contiguous tail reorders nothing, it only folds the end of the list away.
 *
 * The split is after the schedule block, because a date and a time are what the user came to
 * set. Meal keeps `Slot` up front with them: §4.2 makes the slot and the time two views of one
 * value, and separating them would put the cause behind a disclosure and leave the effect
 * outside it. Watch keeps its identity fields, which the table itself puts above the date.
 */
const MORE_OPTIONS_FROM: Readonly<Record<ActivityType, FieldKey>> = Object.freeze({
  task: 'reminder',
  meal: 'people',
  watch: 'people',
  event: 'location',
  custom: 'people',
});

/** Everything a draft's own state decides about which fields exist right now. */
export interface FieldVisibility {
  mediaKind?: 'movie' | 'show';
  hasDate?: boolean;
  hasTime?: boolean;
}

export interface FieldRegions {
  /** Rendered directly, in table order. */
  primary: readonly FieldSpec[];
  /** Rendered inside `More options`, in table order. */
  more: readonly FieldSpec[];
}

/**
 * The two regions for a type, with the unbuilt and currently irrelevant fields removed.
 *
 * Pure and total: the caller passes the draft state that decides the conditional fields, so a
 * component never has to reproduce the "only once a date exists" rules and cannot disagree with
 * the test that pins them. `title` is absent from both because the frame renders it, above
 * everything this function describes.
 */
export function fieldRegions(
  type: ActivityType,
  state: FieldVisibility = {},
): FieldRegions {
  const table = fieldsByType[type];
  const splitAt = table.findIndex((spec) => spec.key === MORE_OPTIONS_FROM[type]);
  /**
   * The boundary is a **position in the table**, never a count of what survived: removing an
   * unbuilt field must not drag the split up by one and pull the next field out of the
   * disclosure with it.
   */
  const boundary = splitAt < 0 ? table.length : splitAt;

  const rendered = table
    .map((spec, index) => ({ spec, index }))
    .filter(
      ({ spec }) =>
        spec.key !== 'title' &&
        !UNBUILT_FIELDS.has(spec.key) &&
        isFieldVisible(spec.key, state),
    );

  return {
    primary: rendered.filter((row) => row.index < boundary).map((row) => row.spec),
    more: rendered.filter((row) => row.index >= boundary).map((row) => row.spec),
  };
}

/**
 * Whether a field renders **right now**, given the draft's own state.
 *
 * §4.3 hides `Season`, `Episode` and `Episode title` unless Kind is Show. §3.4's three
 * interlocks are the rest: Time needs a date, End time needs a start time, Reminder and Repeat
 * need a date. P1-25 rendered those three **disabled**, with `Pick a date first.` beside them;
 * P2-43 makes them absent, because a form that shows what the user's choices have made relevant
 * has no disabled fields and no copy explaining one.
 *
 * Every one of these is hidden rather than greyed, which is the same treatment §3 rule 1 already
 * required of a field that does not belong to the type at all.
 */
export function isFieldVisible(key: FieldKey, state: FieldVisibility) {
  if (key === 'season' || key === 'episode' || key === 'episodeTitle') {
    return state.mediaKind === 'show';
  }
  if (key === 'time' || key === 'reminder' || key === 'repeat') {
    return state.hasDate === true;
  }
  if (key === 'endTime') return state.hasTime === true;
  return true;
}

/* -------------------------------------------------------------------------- */
/*  The three derivations §4 specifies, and no fourth                         */
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
 * The time a chosen slot implies, **unless the user set the current one**.
 *
 * The condition that matters is *who set the time*, not *whether a time is set*. Without the
 * distinction the app's own guess blocks the next one: picking Breakfast writes 08:00, and
 * then Dinner is refused because "a time is set", leaving the meal at eight in the morning.
 * That is what §4.2 said literally and it is not what it meant — the rule exists to protect a
 * time the **user** typed, and `derived` is what tells the two apart.
 *
 * Snack returns `undefined` and so **clears** a derived time. That is the table's own value:
 * a snack has no hour the product is willing to guess, and leaving lunch's 12:30 behind under
 * a Snack label would be the app asserting something it was never told.
 */
export function timeForSlot(
  slot: MealSlot,
  currentTime: string | undefined,
  derived: boolean,
): string | undefined {
  const hasTime = currentTime !== undefined && currentTime !== '';
  if (hasTime && !derived) return currentTime;
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
