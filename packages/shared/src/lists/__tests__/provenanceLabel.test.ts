import { describe, expect, it } from 'vitest';
import { type LabelSourceMeal, provenanceLabel } from '../provenanceLabel.js';

/** A Tuesday, so "within 7 days" crosses a weekend and the weekday names are distinct. */
const TODAY = '2026-08-18';

const meal = (overrides: Partial<LabelSourceMeal> = {}): LabelSourceMeal => ({
  title: 'Chicken tacos',
  ...overrides,
});

/** §7.5's five rules, each named by its number so a failure points at the doc. */
describe('provenanceLabel', () => {
  it('rule 1: within 7 days with a slot is weekday plus slot', () => {
    expect(
      provenanceLabel(meal({ date: '2026-08-23', mealSlot: 'dinner' }), [], TODAY),
    ).toBe('Sunday dinner');
  });

  it('rule 2: within 7 days with no slot is the weekday alone', () => {
    expect(provenanceLabel(meal({ date: '2026-08-23' }), [], TODAY)).toBe('Sunday');
  });

  it('rule 3: beyond 7 days is the date plus slot', () => {
    expect(
      provenanceLabel(meal({ date: '2026-09-13', mealSlot: 'dinner' }), [], TODAY),
    ).toBe('13 Sep dinner');
  });

  it('rule 3 with no slot drops it rather than trailing a space', () => {
    expect(provenanceLabel(meal({ date: '2026-09-13' }), [], TODAY)).toBe('13 Sep');
  });

  it('rule 4: an unscheduled meal is named by its title', () => {
    expect(provenanceLabel(meal(), [], TODAY)).toBe('Chicken tacos');
  });

  it('rule 5: a label already on the list from another meal gains this title', () => {
    expect(
      provenanceLabel(
        meal({ date: '2026-08-23', mealSlot: 'dinner' }),
        ['Sunday dinner'],
        TODAY,
      ),
    ).toBe('Sunday dinner · Chicken tacos');
  });

  it('rule 5 does not fire on an unrelated label', () => {
    expect(
      provenanceLabel(
        meal({ date: '2026-08-23', mealSlot: 'dinner' }),
        ['Sunday lunch', 'Thursday dinner'],
        TODAY,
      ),
    ).toBe('Sunday dinner');
  });

  it('rule 5 applies to a rule-3 label too', () => {
    expect(
      provenanceLabel(
        meal({ date: '2026-09-13', mealSlot: 'dinner' }),
        ['13 Sep dinner'],
        TODAY,
      ),
    ).toBe('13 Sep dinner · Chicken tacos');
  });

  /**
   * Rule 5 is written as "a label produced by rules 1–3". Appending the title to the title
   * would disambiguate a meal from itself and read as a stutter.
   */
  it('rule 5 never applies to rule 4, even when the title is already on the list', () => {
    expect(provenanceLabel(meal(), ['Chicken tacos'], TODAY)).toBe('Chicken tacos');
  });

  describe('the 7-day window', () => {
    it.each([
      ['today', '2026-08-18', 'Tuesday'],
      ['tomorrow', '2026-08-19', 'Wednesday'],
      ['the seventh day, which is inside the window', '2026-08-25', 'Tuesday'],
    ])('treats %s as near: %s', (_why, date, expected) => {
      expect(provenanceLabel(meal({ date }), [], TODAY)).toBe(expected);
    });

    it('treats the eighth day as far, so the weekday cannot be ambiguous', () => {
      expect(provenanceLabel(meal({ date: '2026-08-26' }), [], TODAY)).toBe('26 Aug');
    });

    /**
     * A past meal is outside the window in the other direction. `Sunday` identifies a day
     * only while it is the nearest one; `16 Aug` is right whichever side of today it is.
     */
    it('treats yesterday as far', () => {
      expect(
        provenanceLabel(meal({ date: '2026-08-16', mealSlot: 'lunch' }), [], TODAY),
      ).toBe('16 Aug lunch');
    });
  });

  it('is pure: the same inputs give the same answer', () => {
    const input = meal({ date: '2026-08-23', mealSlot: 'dinner' });
    expect(provenanceLabel(input, ['Sunday dinner'], TODAY)).toBe(
      provenanceLabel(input, ['Sunday dinner'], TODAY),
    );
  });
});
