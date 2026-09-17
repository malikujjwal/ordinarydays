import type { PatchActivityInput } from '@od/shared/schemas';
import type { ActivityDetails, EventReservation, MealIngredient } from '@od/shared/types';

type DetailsPatch = NonNullable<PatchActivityInput['details']>;

/** One ingredient row as the meal sheet edits it: its stored identity, a name, a quantity. */
export interface EditedIngredient {
  /** The row's `ing_` id — the stored one for an existing row, never re-minted. */
  ingredientId: string;
  name: string;
  quantity?: string;
}

/**
 * The type-sheet's own fields. Absence of an optional key is a clear, not "leave it" —
 * with one exception: a meal edit that omits `ingredients` did not touch the rows, so the
 * stored rows are carried. `kind` must match `current.kind`; `mediaTitle` is never edited
 * here.
 */
export type DetailsEdits =
  | {
      kind: 'meal';
      mealSlot?: 'breakfast' | 'lunch' | 'dinner' | 'snack';
      recipeUrl?: string;
      /**
       * The edited rows in order (2026-09-10: ingredients are editable after creation).
       * Blank names are dropped and quantities trimmed here, so the sheet can hand over
       * exactly what it holds.
       */
      ingredients?: readonly EditedIngredient[];
    }
  | {
      kind: 'watch';
      mediaKind?: 'movie' | 'show';
      season?: number;
      episode?: number;
      episodeTitle?: string;
      service?: string;
    }
  | {
      kind: 'event';
      description?: string;
      priceCents?: number;
      currency?: string;
      ticketUrl?: string;
      organiser?: string;
      reservation?: EventReservation;
    };

/**
 * Wholesale-replace payload for a type-details save.
 *
 * Starts from the full current `details`, overlays the edited keys, and strips the
 * deprecated, server-owned `addedToListId` from every ingredient — the input schema rejects
 * the key outright rather than dropping it silently, so a save that still carried it would
 * `400`. There is nothing left on the server to reattach it from: an add no longer writes it,
 * and `Added` is derived from the destination list's own items (Option B, 2026-09-16), not
 * from anything carried across this patch.
 */
export function buildDetailsPatch(
  current: ActivityDetails,
  edits: DetailsEdits,
): DetailsPatch {
  if (current.kind === 'meal' && edits.kind === 'meal') {
    return mealPatch(current, edits);
  }
  if (current.kind === 'watch' && edits.kind === 'watch') {
    return watchPatch(current, edits);
  }
  if (current.kind === 'event' && edits.kind === 'event') {
    return eventPatch(current, edits);
  }
  return retained(current);
}

function mealPatch(
  current: Extract<ActivityDetails, { kind: 'meal' }>,
  edits: Extract<DetailsEdits, { kind: 'meal' }>,
): DetailsPatch {
  const ingredients =
    edits.ingredients === undefined
      ? (current.ingredients ?? []).map(withoutAddedToListId)
      : edits.ingredients.flatMap(cleanIngredient);
  return {
    kind: 'meal',
    ...(edits.mealSlot === undefined ? {} : { mealSlot: edits.mealSlot }),
    ...(ingredients.length === 0 ? {} : { ingredients }),
    ...(edits.recipeUrl === undefined ? {} : { recipeUrl: edits.recipeUrl }),
  };
}

function watchPatch(
  current: Extract<ActivityDetails, { kind: 'watch' }>,
  edits: Extract<DetailsEdits, { kind: 'watch' }>,
): DetailsPatch {
  return {
    kind: 'watch',
    mediaTitle: current.mediaTitle,
    ...(edits.mediaKind === undefined ? {} : { mediaKind: edits.mediaKind }),
    ...(edits.season === undefined ? {} : { season: edits.season }),
    ...(edits.episode === undefined ? {} : { episode: edits.episode }),
    ...(edits.episodeTitle === undefined ? {} : { episodeTitle: edits.episodeTitle }),
    ...(edits.service === undefined ? {} : { service: edits.service }),
  };
}

function eventPatch(
  _current: Extract<ActivityDetails, { kind: 'event' }>,
  edits: Extract<DetailsEdits, { kind: 'event' }>,
): DetailsPatch {
  return {
    kind: 'event',
    ...(edits.description === undefined ? {} : { description: edits.description }),
    ...(edits.priceCents === undefined ? {} : { priceCents: edits.priceCents }),
    ...(edits.currency === undefined ? {} : { currency: edits.currency }),
    ...(edits.ticketUrl === undefined ? {} : { ticketUrl: edits.ticketUrl }),
    ...(edits.organiser === undefined ? {} : { organiser: edits.organiser }),
    ...(edits.reservation === undefined ? {} : { reservation: edits.reservation }),
  };
}

function retained(current: ActivityDetails): DetailsPatch {
  if (current.kind === 'meal') {
    return mealPatch(current, { kind: 'meal', ...pickMeal(current) });
  }
  return current;
}

function pickMeal(current: Extract<ActivityDetails, { kind: 'meal' }>): {
  mealSlot?: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  recipeUrl?: string;
} {
  return {
    ...(current.mealSlot === undefined ? {} : { mealSlot: current.mealSlot }),
    ...(current.recipeUrl === undefined ? {} : { recipeUrl: current.recipeUrl }),
  };
}

/**
 * An edited row as the input schema takes it, or nothing when its name is blank. Edited rows
 * never carry `addedToListId` (the input schema rejects it). Renaming or re-quantifying a row
 * has nothing to preserve for `Added` any more — it is read off the destination list by
 * `ingredientId`, not off anything stored on the meal — so this strip is only about
 * satisfying the schema, never about losing state.
 */
function cleanIngredient(row: EditedIngredient): EditedIngredient[] {
  const name = row.name.trim();
  if (name === '') return [];
  const quantity = row.quantity?.trim() ?? '';
  return [
    {
      ingredientId: row.ingredientId,
      name,
      ...(quantity === '' ? {} : { quantity }),
    },
  ];
}

function withoutAddedToListId(row: MealIngredient): EditedIngredient {
  return {
    ingredientId: row.ingredientId,
    name: row.name,
    ...(row.quantity === undefined ? {} : { quantity: row.quantity }),
  };
}
