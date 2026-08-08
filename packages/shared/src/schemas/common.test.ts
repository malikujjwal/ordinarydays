import { describe, expect, it } from 'vitest';
import { cents, cursor, hhmm, ianaTimezone, isoDate, ulidId } from './common.js';

/**
 * These primitives are composed by every other schema in the product, so a hole here is a
 * hole everywhere. Each case is a value that must be accepted or must be rejected — the
 * rejections matter more, because an over-permissive primitive is invisible until bad data
 * is already stored.
 */

describe('isoDate', () => {
  it.each(['2026-08-08', '2024-02-29', '2000-01-01'])('accepts %s', (v) => {
    expect(isoDate.safeParse(v).success).toBe(true);
  });

  it.each([
    ['a month that does not exist', '2026-13-01'],
    ['a day that does not exist', '2026-02-30'],
    ['Feb 29 in a non-leap year', '2025-02-29'],
    ['a datetime, not a date', '2026-08-08T19:30'],
    ['unpadded parts', '2026-8-8'],
    ['empty', ''],
  ])('rejects %s', (_why, v) => {
    expect(isoDate.safeParse(v).success).toBe(false);
  });
});

describe('hhmm', () => {
  it.each(['00:00', '09:05', '19:30', '23:59'])('accepts %s', (v) => {
    expect(hhmm.safeParse(v).success).toBe(true);
  });

  it.each([
    ['hour 24', '24:00'],
    ['minute 60', '12:60'],
    ['seconds', '19:30:00'],
    ['unpadded hour', '9:05'],
    ['12-hour clock', '7:30pm'],
  ])('rejects %s', (_why, v) => {
    expect(hhmm.safeParse(v).success).toBe(false);
  });
});

describe('ianaTimezone', () => {
  it.each(['America/New_York', 'Europe/London', 'Australia/Adelaide', 'UTC'])(
    'accepts %s',
    (v) => {
      expect(ianaTimezone.safeParse(v).success).toBe(true);
    },
  );

  it.each([
    ['an offset, not a zone', '+05:30'],
    ['an abbreviation', 'EST5EDT7'],
    ['a bare region', 'America'],
    ['empty', ''],
  ])('rejects %s', (_why, v) => {
    expect(ianaTimezone.safeParse(v).success).toBe(false);
  });
});

describe('cents', () => {
  it('accepts a positive integer', () => {
    expect(cents.safeParse(1250).success).toBe(true);
  });

  it('accepts a negative integer, because a net balance can be owed the other way', () => {
    expect(cents.safeParse(-1250).success).toBe(true);
  });

  it('accepts zero', () => {
    expect(cents.safeParse(0).success).toBe(true);
  });

  it.each([
    ['a float, which is the whole reason money is integer cents', 12.5],
    ['a float that looks safe', 0.1 + 0.2],
    ['a numeric string', '1250'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s', (_why, v) => {
    expect(cents.safeParse(v).success).toBe(false);
  });
});

describe('ulidId', () => {
  const activityId = ulidId('act');

  it('accepts a prefixed ULID', () => {
    expect(activityId.safeParse('act_01J8XKQY3M4N5P6R7S8T9VWXYZ').success).toBe(true);
  });

  it.each([
    ['the wrong prefix', 'lst_01J8XKQY3M4N5P6R7S8T9VWXYZ'],
    ['no prefix', '01J8XKQY3M4N5P6R7S8T9VWXYZ'],
    ['a UUID', 'act_f47ac10b-58cc-4372-a567-0e02b2c3d479'],
    ['too short', 'act_01J8XKQY3M4N5P6R7S8T9VWXY'],
    ['I, which Crockford base32 excludes', 'act_01J8XKQY3M4N5P6R7S8T9VWXYI'],
    ['lowercase body', 'act_01j8xkqy3m4n5p6r7s8t9vwxyz'],
  ])('rejects %s', (_why, v) => {
    expect(activityId.safeParse(v).success).toBe(false);
  });

  it('is per-prefix, so a list id is not an activity id', () => {
    const listId = ulidId('lst');
    const value = 'lst_01J8XKQY3M4N5P6R7S8T9VWXYZ';
    expect(listId.safeParse(value).success).toBe(true);
    expect(activityId.safeParse(value).success).toBe(false);
  });
});

describe('cursor', () => {
  it('accepts base64url', () => {
    expect(cursor.safeParse('eyJwayI6IlVTRVIjMDEifQ').success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['characters outside the alphabet', 'not a cursor!'],
    ['something longer than the bound', 'a'.repeat(2049)],
  ])('rejects %s', (_why, v) => {
    expect(cursor.safeParse(v).success).toBe(false);
  });
});
