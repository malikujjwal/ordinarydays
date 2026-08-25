import { describe, expect, it } from 'vitest';
import { MAX_FREE_TEXT_LEN, MAX_TITLE_LEN } from '../../constants.js';
import { formatIngredientTitle } from '../formatIngredientTitle.js';

/**
 * §P3-17's three cases: no quantity, an exact-boundary quantity, and the 120 + 120 maximum
 * that must still produce a valid title rather than failing insertion.
 */
describe('formatIngredientTitle', () => {
  it('renders the bare name when there is no quantity', () => {
    expect(formatIngredientTitle('Chicken')).toBe('Chicken');
  });

  it.each(['', '   '])('renders the bare name for the quantity %o', (quantity) => {
    expect(formatIngredientTitle('Chicken', quantity)).toBe('Chicken');
  });

  it('appends a present quantity in parentheses', () => {
    expect(formatIngredientTitle('Tortillas', '8')).toBe('Tortillas (8)');
  });

  it('trims both sides, because a form field holds whatever was left in it', () => {
    expect(formatIngredientTitle('  Tortillas  ', '  8  ')).toBe('Tortillas (8)');
  });

  it('leaves a title of exactly MAX_TITLE_LEN untouched', () => {
    const name = 'n'.repeat(MAX_FREE_TEXT_LEN);
    const quantity = 'q'.repeat(MAX_TITLE_LEN - MAX_FREE_TEXT_LEN - ' ()'.length);

    const title = formatIngredientTitle(name, quantity);

    expect(title).toHaveLength(MAX_TITLE_LEN);
    expect(title).toBe(`${name} (${quantity})`);
    expect(title).not.toContain('…');
  });

  /**
   * The boundary the whole function exists for: the largest meal a client may legally send
   * must produce a title the list may legally store.
   */
  describe('the 120 + 120 maximum', () => {
    const name = 'n'.repeat(MAX_FREE_TEXT_LEN);
    const quantity = 'q'.repeat(MAX_FREE_TEXT_LEN);
    const title = formatIngredientTitle(name, quantity);

    it('is exactly MAX_TITLE_LEN characters', () => {
      expect(title).toHaveLength(MAX_TITLE_LEN);
    });

    it('preserves every character of the name', () => {
      expect(title.startsWith(`${name} (`)).toBe(true);
    });

    it('truncates only the quantity, and ends with one ellipsis inside the brackets', () => {
      expect(title.endsWith('…)')).toBe(true);
      expect([...title].filter((character) => character === '…')).toHaveLength(1);
    });

    it('is deterministic', () => {
      expect(formatIngredientTitle(name, quantity)).toBe(title);
    });
  });

  it('never exceeds MAX_TITLE_LEN across the whole legal input range', () => {
    for (let nameLength = 1; nameLength <= MAX_FREE_TEXT_LEN; nameLength += 1) {
      for (const quantityLength of [0, 1, 40, MAX_FREE_TEXT_LEN]) {
        const produced = formatIngredientTitle(
          'n'.repeat(nameLength),
          'q'.repeat(quantityLength),
        );
        expect(produced.length).toBeLessThanOrEqual(MAX_TITLE_LEN);
        expect(produced.startsWith('n'.repeat(nameLength))).toBe(true);
      }
    }
  });
});
