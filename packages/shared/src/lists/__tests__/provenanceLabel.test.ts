import { describe, expect, it } from 'vitest';
import { type LabelSourceMeal, provenanceLabel } from '../provenanceLabel.js';

const meal = (title = 'Chicken tacos'): LabelSourceMeal => ({ title });

/** §7.5, amended 2026-09-11 (founder): the label is the source plan's name, always. */
describe('provenanceLabel', () => {
  it("is the source plan's title", () => {
    expect(provenanceLabel(meal())).toBe('Chicken tacos');
  });

  it('trims the title', () => {
    expect(provenanceLabel(meal('  Chicken tacos \n'))).toBe('Chicken tacos');
  });

  /**
   * A meal's day and slot are not part of the label any more, whatever the meal carries.
   * Structural typing lets the caller hand over the whole Activity; only the title is read.
   */
  it('ignores when the meal is scheduled', () => {
    const scheduled = { title: 'Chicken tacos', date: '2026-08-23', mealSlot: 'dinner' };
    expect(provenanceLabel(scheduled)).toBe('Chicken tacos');
  });

  it('keeps a title that itself contains the join delimiter whole', () => {
    expect(provenanceLabel(meal('Rice · beans'))).toBe('Rice · beans');
  });

  it('is pure: the same inputs give the same answer', () => {
    expect(provenanceLabel(meal())).toBe(provenanceLabel(meal()));
  });
});
