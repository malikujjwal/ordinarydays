import type { PatchActivityInput } from '@od/shared/schemas';
import type { ActivityDetails, EventReservation, MealIngredient } from '@od/shared/types';

type DetailsPatch = NonNullable<PatchActivityInput['details']>;

/**
 * The type-sheet's own fields. Absence of an optional key is a clear, not "leave it".
 * `kind` must match `current.kind`; ingredients and `mediaTitle` are never edited here.
 */
export type DetailsEdits =
  | {
      kind: 'meal';
      mealSlot?: 'breakfast' | 'lunch' | 'dinner' | 'snack';
      recipeUrl?: string;
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
 * Starts from the full current `details`, overlays the edited keys, and strips
 * server-owned `addedToListId` from every ingredient — the input schema rejects it
 * rather than dropping it. Provenance is reattached on the server after the write.
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
  const ingredients = (current.ingredients ?? []).map(withoutAddedToListId);
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

function withoutAddedToListId(row: MealIngredient): {
  ingredientId: string;
  name: string;
  quantity?: string;
} {
  return {
    ingredientId: row.ingredientId,
    name: row.name,
    ...(row.quantity === undefined ? {} : { quantity: row.quantity }),
  };
}
