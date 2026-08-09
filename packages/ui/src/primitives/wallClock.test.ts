import { describe, expect, it } from 'vitest';
import {
  DATE_QUICK_LABELS,
  DATE_QUICK_OPTIONS,
  formatWallDate,
  formatWallTime,
  isWallDateInRange,
  resolveQuickDate,
  toWallDate,
  toWallTime,
} from './wallClock';

/**
 * The pure half of the two pickers. Every case fixes `today` explicitly, which is the whole
 * point of taking it as an argument: the weekend rule can be asserted on a Tuesday and on a
 * Saturday in one run, and the suite means the same thing in every week of the year.
 *
 * 2026-08-11 is a Tuesday; 2026-08-15 a Saturday; 2026-08-16 a Sunday; 2026-08-17 a Monday.
 */
describe('the date quick chips (activities.md §3.4)', () => {
  it('offers exactly the five options, in the order the product doc lists them', () => {
    expect(DATE_QUICK_OPTIONS.map((option) => DATE_QUICK_LABELS[option])).toEqual([
      'Today',
      'Tomorrow',
      'This weekend',
      'Next week',
      'Pick a date',
    ]);
  });

  it.each([
    ['today', '2026-08-11', '2026-08-11'],
    ['tomorrow', '2026-08-11', '2026-08-12'],
    // Month-end: tomorrow rolls the month rather than producing the 32nd.
    ['tomorrow', '2026-08-31', '2026-09-01'],
    // Year-end, and a leap day on the way in.
    ['tomorrow', '2026-12-31', '2027-01-01'],
    ['tomorrow', '2028-02-28', '2028-02-29'],
    ['this-weekend', '2026-08-11', '2026-08-15'],
    ['next-week', '2026-08-11', '2026-08-17'],
  ] as const)('%s from %s → %s', (option, today, expected) => {
    expect(resolveQuickDate(option, today)).toBe(expected);
  });

  /**
   * The two rules the product docs leave open, asserted rather than left to the arithmetic:
   * "this weekend" on a Saturday is today, and "next week" on a Monday is a week away.
   */
  it.each([
    ['2026-08-15', '2026-08-15'], // Saturday → itself
    ['2026-08-16', '2026-08-16'], // Sunday → itself
    ['2026-08-14', '2026-08-15'], // Friday → tomorrow
  ])('this weekend from %s → %s', (today, expected) => {
    expect(resolveQuickDate('this-weekend', today)).toBe(expected);
  });

  it('next week from a Monday is the Monday after, never this morning', () => {
    expect(resolveQuickDate('next-week', '2026-08-17')).toBe('2026-08-24');
  });

  it('pick resolves to no date — it opens the calendar instead', () => {
    expect(resolveQuickDate('pick', '2026-08-11')).toBeNull();
  });
});

describe('formatting (coding-standards.md §4.4 — date-fns, never string slicing)', () => {
  it('renders a date the way a plan card does', () => {
    expect(formatWallDate('2026-08-08')).toBe('Sat, Aug 8');
  });

  it.each([
    ['00:00', '12:00 AM'],
    ['09:05', '9:05 AM'],
    ['12:00', '12:00 PM'],
    ['19:30', '7:30 PM'],
  ])('%s reads as %s', (time, expected) => {
    expect(formatWallTime(time)).toBe(expected);
  });

  /**
   * `parseISO`, not `new Date('2026-08-08')` — the latter reads a bare date as **UTC**
   * midnight, which is the previous day everywhere west of Greenwich. The round trip is what
   * catches it: a UTC read would come back as 2026-08-07 for anyone in the Americas, which is
   * where this product is being built.
   */
  it('round-trips a wall date through a Date without shifting a day', () => {
    expect(toWallDate(new Date(2026, 7, 8))).toBe('2026-08-08');
    expect(formatWallDate(toWallDate(new Date(2026, 7, 8)))).toBe('Sat, Aug 8');
  });

  it('round-trips a wall time to the minute', () => {
    expect(toWallTime(new Date(2026, 7, 8, 19, 30))).toBe('19:30');
  });
});

describe('min and max windows', () => {
  it.each([
    ['2026-08-11', undefined, undefined, true],
    ['2026-08-11', '2026-08-12', undefined, false],
    ['2026-08-11', '2026-08-11', undefined, true],
    ['2026-08-11', undefined, '2026-08-10', false],
    ['2026-08-11', '2026-08-01', '2026-08-31', true],
  ] as const)('%s within %s…%s → %s', (date, min, max, expected) => {
    expect(isWallDateInRange(date, min, max)).toBe(expected);
  });
});
