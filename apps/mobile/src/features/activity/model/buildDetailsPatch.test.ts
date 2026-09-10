import type { ActivityDetails } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { buildDetailsPatch } from './buildDetailsPatch';

const meal = (patch: Partial<Extract<ActivityDetails, { kind: 'meal' }>> = {}) =>
  ({
    kind: 'meal' as const,
    mealSlot: 'dinner' as const,
    recipeUrl: 'https://www.bbcgoodfood.com/recipes/chicken-tacos',
    ingredients: [
      { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1', name: 'Chicken' },
      {
        ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2',
        name: 'Tortillas',
        quantity: '8',
      },
      {
        ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A3',
        name: 'Salsa',
        addedToListId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1B1',
      },
    ],
    ...patch,
  }) satisfies Extract<ActivityDetails, { kind: 'meal' }>;

describe('buildDetailsPatch', () => {
  it('keeps every ingredient and strips addedToListId on a recipe edit', () => {
    const patch = buildDetailsPatch(meal(), {
      kind: 'meal',
      mealSlot: 'lunch',
      recipeUrl: 'https://www.example.com/tacos',
    });

    expect(patch).toEqual({
      kind: 'meal',
      mealSlot: 'lunch',
      recipeUrl: 'https://www.example.com/tacos',
      ingredients: [
        { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1', name: 'Chicken' },
        {
          ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2',
          name: 'Tortillas',
          quantity: '8',
        },
        { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A3', name: 'Salsa' },
      ],
    });
    expect(patch.kind === 'meal' ? patch.ingredients : undefined).toHaveLength(3);
    expect(
      patch.kind === 'meal'
        ? patch.ingredients?.every((row) => !('addedToListId' in row))
        : false,
    ).toBe(true);
  });

  it('clears an editable key that the sheet omitted', () => {
    expect(
      buildDetailsPatch(meal(), {
        kind: 'meal',
        mealSlot: 'dinner',
      }),
    ).toEqual({
      kind: 'meal',
      mealSlot: 'dinner',
      ingredients: [
        { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1', name: 'Chicken' },
        {
          ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2',
          name: 'Tortillas',
          quantity: '8',
        },
        { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A3', name: 'Salsa' },
      ],
    });
  });

  it('keeps mediaTitle and stored season when a movie edit omits neither identity nor progress', () => {
    const patch = buildDetailsPatch(
      {
        kind: 'watch',
        mediaTitle: 'Past Lives',
        mediaKind: 'show',
        season: 2,
        episode: 4,
        service: 'Netflix',
      },
      { kind: 'watch', mediaKind: 'movie', season: 2, episode: 4, service: 'Netflix' },
    );

    expect(patch).toEqual({
      kind: 'watch',
      mediaTitle: 'Past Lives',
      mediaKind: 'movie',
      season: 2,
      episode: 4,
      service: 'Netflix',
    });
  });

  it('returns the current details, ingredients stripped, when the edit kind does not match', () => {
    expect(
      buildDetailsPatch(meal(), {
        kind: 'event',
        description: 'should not apply',
      }),
    ).toEqual({
      kind: 'meal',
      mealSlot: 'dinner',
      recipeUrl: 'https://www.bbcgoodfood.com/recipes/chicken-tacos',
      ingredients: [
        { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1', name: 'Chicken' },
        {
          ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2',
          name: 'Tortillas',
          quantity: '8',
        },
        { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A3', name: 'Salsa' },
      ],
    });
  });
});
