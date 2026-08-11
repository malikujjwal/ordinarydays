import { formatInTimeZone } from 'date-fns-tz';
import { describe, expect, it } from 'vitest';
import {
  addWallDays,
  addWallMonths,
  clampWallDate,
  differenceInWallDays,
  differenceInWallMonths,
  differenceInWallWeeks,
  startOfWallWeek,
  toUtcInstant,
  wallDateParts,
} from './calendar.js';
import { RecurrenceValidationError } from './error.js';

describe('wall-clock calendar arithmetic', () => {
  it('steps dates and months without millisecond arithmetic', () => {
    expect(addWallDays('2026-03-07', 2)).toBe('2026-03-09');
    expect(addWallMonths('2026-01-31', 1)).toBe('2026-02-01');
    expect(differenceInWallDays('2026-03-09', '2026-03-07')).toBe(2);
    expect(differenceInWallMonths('2026-04-30', '2026-01-31')).toBe(3);
    expect(differenceInWallWeeks('2026-08-16', '2026-08-02')).toBe(2);
    expect(startOfWallWeek('2026-08-06')).toBe('2026-08-02');
  });

  it('reports calendar parts and clamps short months', () => {
    expect(wallDateParts('2028-02-29')).toEqual({
      year: 2028,
      month: 2,
      day: 29,
      weekday: 2,
    });
    expect(clampWallDate(2026, 2, 31)).toBe('2026-02-28');
    expect(clampWallDate(2028, 2, 29)).toBe('2028-02-29');
  });
});

describe('toUtcInstant', () => {
  it('uses the offset in force on an ordinary date', () => {
    expect(toUtcInstant('2026-07-01', '18:00', 'America/New_York')).toBe(
      '2026-07-01T22:00:00.000Z',
    );
    expect(toUtcInstant('2026-01-01', '18:00', 'Asia/Kolkata')).toBe(
      '2026-01-01T12:30:00.000Z',
    );
  });

  it('spring gap forwards 2026-03-08 02:30 America/New_York to 03:00', () => {
    const instant = toUtcInstant('2026-03-08', '02:30', 'America/New_York');
    expect(instant).toBe('2026-03-08T07:00:00.000Z');
    expect(formatInTimeZone(new Date(instant), 'America/New_York', 'HH:mm')).toBe(
      '03:00',
    );
  });

  it('chooses the earlier instant when a fall-back time occurs twice', () => {
    expect(toUtcInstant('2026-11-01', '01:30', 'America/New_York')).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('shifts an ordinary wall time across both London DST boundaries', () => {
    expect([
      toUtcInstant('2026-03-28', '18:00', 'Europe/London'),
      toUtcInstant('2026-03-29', '18:00', 'Europe/London'),
      toUtcInstant('2026-03-30', '18:00', 'Europe/London'),
    ]).toEqual([
      '2026-03-28T18:00:00.000Z',
      '2026-03-29T17:00:00.000Z',
      '2026-03-30T17:00:00.000Z',
    ]);
    expect([
      toUtcInstant('2026-10-24', '18:00', 'Europe/London'),
      toUtcInstant('2026-10-25', '18:00', 'Europe/London'),
      toUtcInstant('2026-10-26', '18:00', 'Europe/London'),
    ]).toEqual([
      '2026-10-24T17:00:00.000Z',
      '2026-10-25T18:00:00.000Z',
      '2026-10-26T18:00:00.000Z',
    ]);
  });

  it('throws a typed error when an entire wall date cannot resolve in the bounded search', () => {
    expect(() => toUtcInstant('2011-12-30', '12:00', 'Pacific/Apia')).toThrow(
      RecurrenceValidationError,
    );
  });
});
