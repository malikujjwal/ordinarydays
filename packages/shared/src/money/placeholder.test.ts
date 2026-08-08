import { describe, expect, it } from 'vitest';
import { isNonNegativeCents } from './placeholder.js';

/**
 * Both operands of the `&&`, so branch coverage is genuinely 100% rather than incidentally
 * so — a test that only ever varied one side would leave a branch uncovered and the gate
 * would catch it.
 */
describe('isNonNegativeCents', () => {
  it.each([0, 1, 1_250, Number.MAX_SAFE_INTEGER])('accepts %s', (value) => {
    expect(isNonNegativeCents(value)).toBe(true);
  });

  it('rejects a negative integer', () => {
    expect(isNonNegativeCents(-1)).toBe(false);
  });

  it('rejects a float, which is the whole point of integer cents', () => {
    expect(isNonNegativeCents(12.5)).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %s',
    (value) => {
      expect(isNonNegativeCents(value)).toBe(false);
    },
  );
});
