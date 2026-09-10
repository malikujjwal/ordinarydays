import { describe, expect, it } from 'vitest';
import { parseMinorUnits } from './parse.js';

describe('parseMinorUnits', () => {
  it('returns undefined for blank input', () => {
    expect(parseMinorUnits('')).toBeUndefined();
    expect(parseMinorUnits('   ')).toBeUndefined();
  });

  it('refuses a leading sign rather than stripping it', () => {
    expect(parseMinorUnits('-5')).toBeUndefined();
    expect(parseMinorUnits('+12.50')).toBeUndefined();
  });

  it('parses a whole number as that many major units at 2 minor units', () => {
    expect(parseMinorUnits('12')).toBe(1200);
    expect(parseMinorUnits('0')).toBe(0);
  });

  it('parses one or two fractional digits without multiplying a float', () => {
    expect(parseMinorUnits('37.5')).toBe(3750);
    expect(parseMinorUnits('37.50')).toBe(3750);
    expect(parseMinorUnits('0.00')).toBe(0);
    expect(parseMinorUnits('0.05')).toBe(5);
  });

  it('treats a trailing separator as an unfinished fractional part, padded with zeros', () => {
    expect(parseMinorUnits('12.')).toBe(1200);
  });

  it('refuses a leading separator, a second separator, and non-digits', () => {
    expect(parseMinorUnits('.5')).toBeUndefined();
    expect(parseMinorUnits('1.2.3')).toBeUndefined();
    expect(parseMinorUnits('12,50')).toBeUndefined();
    expect(parseMinorUnits('$12.50')).toBeUndefined();
    expect(parseMinorUnits('12a')).toBeUndefined();
  });

  it('refuses extra fractional digits rather than truncating them', () => {
    expect(parseMinorUnits('12.567')).toBeUndefined();
    expect(parseMinorUnits('1.234', 3)).toBe(1234);
  });

  it('uses the default of 2 minor units when the caller omits the count', () => {
    expect(parseMinorUnits('1.5')).toBe(150);
    expect(parseMinorUnits('1.50', 2)).toBe(150);
  });

  it('accepts a zero-decimal currency as digits only', () => {
    expect(parseMinorUnits('42', 0)).toBe(42);
    expect(parseMinorUnits('0', 0)).toBe(0);
    expect(parseMinorUnits('42.0', 0)).toBeUndefined();
  });

  it('refuses a value that would leave the safe-integer range', () => {
    expect(parseMinorUnits('9'.repeat(16))).toBeUndefined();
  });
});
