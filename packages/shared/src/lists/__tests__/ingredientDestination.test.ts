import { describe, expect, it } from 'vitest';
import { canReceiveIngredients } from '../ingredientDestination.js';
import { LIST_TEMPLATES } from '../templates.js';

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
