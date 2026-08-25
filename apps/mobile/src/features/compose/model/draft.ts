import type { ActivityDetails, ActivityType } from '@od/shared/types';
import type { MealSlot } from '@/features/compose/model/fields';
import { newLocalId } from '@/lib/localIds';

/**
 * The shape a half-filled form holds, and its two conversions (P1-25).
 *
 * ## Why the draft is strings
 *
 * Every text-backed field is a `string`, including the numeric ones — `season`, `episode`,
 * `price`, `partySize`. A form field's value while it is being typed is not a number: `''`,
 * `'1'` and `'1.'` are all states a user passes through, and a store that held `number |
 * undefined` would have to invent a meaning for each. Parsing happens once, at the boundary,
 * in `toCreateActivityInput` — which is also the only place a validation message can be
 * attached to the field that produced it.
 */
export interface DraftIngredient {
  /**
   * The row's `ing_` identity — stable for its lifetime, so React keys it by identity rather
   * than by position **and** the server can name the same row after a reorder.
   *
   * It was a local `row-N` counter until P3-17, described here as "never sent — the server
   * has no notion of an ingredient id". It is now sent, and is the same value the meal
   * stores: `data-model.md` §8's client-minted embedded-row identity. A row loaded from an
   * existing meal keeps the id it already has; only a genuinely new row mints one.
   */
  id: string;
  name: string;
  quantity: string;
  /** Unchecked by default (`activities.md` §4.2): the user picks what to copy, if anything. */
  selected: boolean;
}

export interface DraftReservation {
  name: string;
  time: string;
  partySize: string;
  reference: string;
}

export interface DraftSchedule {
  date: string | undefined;
  time: string | undefined;
  endTime: string | undefined;
  /**
   * Whether `time` is the app's guess from a Meal slot rather than something the user chose.
   *
   * §4.2's rule is "auto-set from the slot when a slot is chosen and no time is set", written
   * to stop a slot change silently moving a time the user typed. Without this flag the rule
   * cannot tell those apart, so the **app's own guess** froze the field: picking Breakfast set
   * 08:00, and every later slot was then refused its time because "a time is set". Choosing
   * Dinner left the meal at eight in the morning.
   *
   * So the flag records provenance, and only a derived time is re-derived. A time the user
   * picked is still never overwritten, which is the half of §4.2 that was always right.
   */
  timeFromSlot: boolean;
}

export interface DraftLocation {
  label: string;
  address: string;
}

export interface DraftDetails {
  mealSlot: MealSlot | undefined;
  ingredients: DraftIngredient[];
  recipeUrl: string;
  /** `undefined` until the user chooses; `watchKind()` supplies the default for display. */
  mediaKind: 'movie' | 'show' | undefined;
  season: string;
  episode: string;
  episodeTitle: string;
  service: string;
  description: string;
  price: string;
  /** Profile currency used when a typed Event price becomes integer minor units. */
  currency: string;
  ticketUrl: string;
  organiser: string;
  reservation: DraftReservation;
}

export const EMPTY_RESERVATION: DraftReservation = Object.freeze({
  name: '',
  time: '',
  partySize: '',
  reference: '',
});

export const EMPTY_DETAILS: DraftDetails = Object.freeze({
  mealSlot: undefined,
  ingredients: [],
  recipeUrl: '',
  mediaKind: undefined,
  season: '',
  episode: '',
  episodeTitle: '',
  service: '',
  description: '',
  price: '',
  currency: '',
  ticketUrl: '',
  organiser: '',
  reservation: EMPTY_RESERVATION,
});

export const EMPTY_SCHEDULE: DraftSchedule = Object.freeze({
  date: undefined,
  time: undefined,
  endTime: undefined,
  timeFromSlot: false,
});

export const EMPTY_LOCATION: DraftLocation = Object.freeze({ label: '', address: '' });

/**
 * A new ingredient row, with a freshly minted `ing_` id.
 *
 * This used to be a counter, on the reasoning that the id never left the draft and reaching
 * for `expo-crypto` would put a native module behind a plus button. P3-17 makes the id part
 * of the stored meal, so it has to be a real ULID from the device's CSPRNG — the same
 * generator the reminder ids already use. It is still one call per tap of `+`.
 *
 * **Only a new row calls this.** Editing or reordering keeps the id it has, and
 * {@link fromActivityDetails} carries the stored id back in rather than re-minting, because
 * re-minting on open would make every id stale the moment a meal was edited.
 */
export function newIngredient(): DraftIngredient {
  return { id: newLocalId('ing'), name: '', quantity: '', selected: false };
}

const trimmed = (value: string): string | undefined => {
  const next = value.trim();
  return next === '' ? undefined : next;
};

/** A draft integer, or `undefined` when the field is empty or not yet a number. */
export function draftInteger(value: string): number | undefined {
  const next = value.trim();
  if (next === '' || !/^\d+$/.test(next)) return undefined;
  return Number.parseInt(next, 10);
}

/**
 * A typed price to integer minor units. **Never a float** (`coding-standards.md` §3).
 *
 * `12.5` is 1250 cents and `12.567` is rejected rather than rounded: the input is money the
 * user typed, and silently dropping a digit from it is the class of bug §3 exists to prevent.
 * Multiplication happens on the integer parts, so `0.1 + 0.2` never enters the path.
 */
export function draftCents(value: string): number | undefined {
  const raw = value.trim();
  /**
   * A sign is rejected, not stripped. The leading strip below exists to let a currency
   * symbol through — `$18.00` — and an earlier version of it ate the `-` as well, quietly
   * turning `-5` into 500. A negative price is not a price; the schema says `nonnegative`
   * and this returns nothing rather than inventing a positive one.
   */
  if (raw.startsWith('-') || raw.startsWith('+')) return undefined;

  const next = raw.replace(/^[^\d.]*/, '');
  if (next === '') return undefined;

  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(next);
  if (match === null) return undefined;

  const whole = Number.parseInt(match[1] ?? '0', 10);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  return whole * 100 + Number.parseInt(fraction, 10);
}

/**
 * Integer cents back to the string the field shows — `1250` → `12.50`.
 *
 * Digits, not arithmetic. `coding-standards.md` §11 smell 5 bans division and `toFixed` from
 * the money path outright, and this is the money path: a `/ 100` here would be the first
 * float in it, on the one value the user is entitled to see rendered exactly.
 */
export function centsToDraft(cents: number): string {
  const digits = String(cents).padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/**
 * The draft's `details`, as the `ActivityDetails` union the request and P1-17's mapping speak.
 *
 * Fields the chosen type does not have are simply not read — the union is the filter, so a
 * A Watch draft that once carried Event fields cannot leak them into another kind's body.
 */
export function toActivityDetails<T extends ActivityType>(
  type: T,
  details: DraftDetails,
  title: string,
): Extract<ActivityDetails, { kind: T }> {
  /**
   * One cast, here, rather than six at the call sites.
   *
   * Every arm below returns the member whose `kind` is the `type` it matched, which is exactly
   * what the signature promises — but TypeScript narrows a `switch` on a generic parameter to
   * the *union* of the returns rather than to the matched member, so the relationship has to
   * be asserted somewhere. Asserting it once, where every arm is visible in one screen, is the
   * version a reader can actually check.
   */
  return kindedDetails(type, details, title) as Extract<ActivityDetails, { kind: T }>;
}

function kindedDetails(
  type: ActivityType,
  details: DraftDetails,
  title: string,
): ActivityDetails {
  switch (type) {
    case 'task':
      return { kind: 'task' };
    case 'meal': {
      const ingredients = details.ingredients
        .filter((row) => row.name.trim() !== '')
        .map((row) => ({
          ingredientId: row.id,
          name: row.name.trim(),
          ...(trimmed(row.quantity) === undefined
            ? {}
            : { quantity: row.quantity.trim() }),
        }));
      return {
        kind: 'meal',
        ...(details.mealSlot === undefined ? {} : { mealSlot: details.mealSlot }),
        ...(ingredients.length === 0 ? {} : { ingredients }),
        ...(trimmed(details.recipeUrl) === undefined
          ? {}
          : { recipeUrl: details.recipeUrl.trim() }),
      };
    }
    case 'watch': {
      const season = draftInteger(details.season);
      const episode = draftInteger(details.episode);
      return {
        kind: 'watch',
        // §4.3: `mediaTitle` starts equal to the title.
        mediaTitle: title,
        ...(details.mediaKind === undefined ? {} : { mediaKind: details.mediaKind }),
        ...(season === undefined ? {} : { season }),
        ...(episode === undefined ? {} : { episode }),
        ...(trimmed(details.episodeTitle) === undefined
          ? {}
          : { episodeTitle: details.episodeTitle.trim() }),
        ...(trimmed(details.service) === undefined
          ? {}
          : { service: details.service.trim() }),
      };
    }
    case 'event': {
      const priceCents = draftCents(details.price);
      const { name, time, partySize, reference } = details.reservation;
      const size = draftInteger(partySize);
      const reservation = {
        ...(trimmed(name) === undefined ? {} : { name: name.trim() }),
        ...(trimmed(time) === undefined ? {} : { time: time.trim() }),
        ...(size === undefined ? {} : { partySize: size }),
        ...(trimmed(reference) === undefined ? {} : { reference: reference.trim() }),
      };
      return {
        kind: 'event',
        ...(trimmed(details.description) === undefined
          ? {}
          : { description: details.description.trim() }),
        ...(priceCents === undefined
          ? {}
          : {
              priceCents,
              ...(trimmed(details.currency) === undefined
                ? {}
                : { currency: details.currency.trim().toUpperCase() }),
            }),
        ...(trimmed(details.ticketUrl) === undefined
          ? {}
          : { ticketUrl: details.ticketUrl.trim() }),
        ...(trimmed(details.organiser) === undefined
          ? {}
          : { organiser: details.organiser.trim() }),
        ...(Object.keys(reservation).length === 0 ? {} : { reservation }),
      };
    }
    case 'custom':
      return { kind: 'custom' };
  }
}

/**
 * The other direction, for a Plan-kind change: whatever P1-17's mapping kept, back onto the
 * draft.
 *
 * Everything it did not keep stays at its empty value, which is what makes the change
 * *visible* — the Season field the user filled in is gone from the form, not lurking in a
 * store waiting to be sent.
 */
export function fromActivityDetails(details: ActivityDetails): DraftDetails {
  const next: DraftDetails = { ...EMPTY_DETAILS, ingredients: [] };

  switch (details.kind) {
    case 'meal':
      return {
        ...next,
        mealSlot: details.mealSlot,
        ingredients: (details.ingredients ?? []).map((row) => ({
          /** The stored id, retained — see {@link newIngredient}. Never re-minted here. */
          id: row.ingredientId,
          name: row.name,
          quantity: row.quantity ?? '',
          selected: false,
        })),
        recipeUrl: details.recipeUrl ?? '',
      };
    case 'watch':
      return {
        ...next,
        mediaKind: details.mediaKind,
        season: details.season === undefined ? '' : String(details.season),
        episode: details.episode === undefined ? '' : String(details.episode),
        episodeTitle: details.episodeTitle ?? '',
        service: details.service ?? '',
      };
    case 'event':
      return {
        ...next,
        description: details.description ?? '',
        price: details.priceCents === undefined ? '' : centsToDraft(details.priceCents),
        currency: details.currency ?? '',
        ticketUrl: details.ticketUrl ?? '',
        organiser: details.organiser ?? '',
        reservation: {
          name: details.reservation?.name ?? '',
          time: details.reservation?.time ?? '',
          partySize:
            details.reservation?.partySize === undefined
              ? ''
              : String(details.reservation.partySize),
          reference: details.reservation?.reference ?? '',
        },
      };
    default:
      return next;
  }
}
