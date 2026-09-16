import { describe, expect, it } from 'vitest';
import { canReceiveIngredients, listCapabilities } from '../ingredientDestination.js';
import { LIST_TEMPLATES } from '../templates.js';

describe('listCapabilities', () => {
  it('reports ingredients: true for a checkbox list, false for state-less and staged lists', () => {
    expect(listCapabilities({ itemStateMode: { mode: 'checkbox' } })).toEqual({
      ingredients: true,
    });
    expect(listCapabilities({ itemStateMode: { mode: 'none' } })).toEqual({
      ingredients: false,
    });
    expect(
      listCapabilities({
        itemStateMode: {
          mode: 'stages',
          labels: { open: 'Open', active: 'Active', done: 'Done' },
          groupByState: true,
        },
      }),
    ).toEqual({ ingredients: false });
  });

  it('classifies every creation template, and canReceiveIngredients agrees for every one', () => {
    expect(
      Object.fromEntries(
        LIST_TEMPLATES.map((template) => [
          template.templateKey,
          listCapabilities(template).ingredients,
        ]),
      ),
    ).toEqual({
      blank: false,
      checklist: true,
      groceries: true,
      'watch-later': false,
      'books-to-read': false,
      'places-to-visit': true,
      'meal-ideas': false,
    });

    // The two must never disagree: canReceiveIngredients is a thin delegation, not a
    // second implementation, so this is a delegation check rather than a duplicate rule.
    for (const template of LIST_TEMPLATES) {
      expect(listCapabilities(template).ingredients, template.templateKey).toBe(
        canReceiveIngredients(template),
      );
    }
  });
});

describe('canReceiveIngredients', () => {
  it('accepts checkbox lists and rejects state-less and staged lists', () => {
    expect(canReceiveIngredients({ itemStateMode: { mode: 'checkbox' } })).toBe(true);
    expect(canReceiveIngredients({ itemStateMode: { mode: 'none' } })).toBe(false);
    expect(
      canReceiveIngredients({
        itemStateMode: {
          mode: 'stages',
          labels: { open: 'Open', active: 'Active', done: 'Done' },
          groupByState: true,
        },
      }),
    ).toBe(false);
  });

  it('classifies every creation template by the shared capability rule', () => {
    expect(
      Object.fromEntries(
        LIST_TEMPLATES.map((template) => [
          template.templateKey,
          canReceiveIngredients(template),
        ]),
      ),
    ).toEqual({
      blank: false,
      checklist: true,
      groceries: true,
      'watch-later': false,
      'books-to-read': false,
      'places-to-visit': true,
      'meal-ideas': false,
    });
  });

  it('rejects Meal Ideas because it is a source of meals, not a shopping destination', () => {
    const mealIdeas = LIST_TEMPLATES.find(
      (template) => template.templateKey === 'meal-ideas',
    );
    if (mealIdeas === undefined) throw new Error('Missing Meal Ideas template');
    expect(canReceiveIngredients(mealIdeas)).toBe(false);
  });
});
