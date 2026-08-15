import { describe, expect, it } from 'vitest';
import { isFutureWallTime, snoozeOptions } from './snoozeOptions';

describe('snoozeOptions', () => {
  it('offers the one-off table and computes every fixed time from now', () => {
    expect(snoozeOptions('15:10', false)).toEqual([
      { key: 'minutes15', label: '15 minutes', until: '15:25' },
      { key: 'hour1', label: '1 hour', until: '16:10' },
      { key: 'hours3', label: '3 hours', until: '18:10' },
      { key: 'evening', label: 'This evening (6 PM)', until: '18:00' },
      { key: 'tomorrow', label: 'Tomorrow' },
      { key: 'pick', label: 'Pick a time' },
    ]);
  });

  it('removes Tomorrow for a recurring occurrence', () => {
    expect(snoozeOptions('15:10', true).map(({ label }) => label)).toEqual([
      '15 minutes',
      '1 hour',
      '3 hours',
      'This evening (6 PM)',
      'Pick a time',
    ]);
  });

  it('removes the evening option after 18:00 and relative values that cross midnight', () => {
    expect(snoozeOptions('19:00', false).map(({ label }) => label)).not.toContain(
      'This evening (6 PM)',
    );
    expect(snoozeOptions('23:50', false).map(({ label }) => label)).toEqual([
      'Tomorrow',
      'Pick a time',
    ]);
  });

  it('accepts only a same-day picked time later than now', () => {
    expect(isFutureWallTime('19:05', '19:00')).toBe(true);
    expect(isFutureWallTime('19:00', '19:00')).toBe(false);
    expect(isFutureWallTime('18:55', '19:00')).toBe(false);
  });
});

/**
 * The base the options count from (`today-and-tasks.md` §5.3, "Snooze moves this occurrence
 * later"). Reported from the built sheet: a 6:00 PM task snoozed at 2:10 PM offered 2:25 PM.
 */
describe('snoozeOptions — the base is the later of now and the occurrence', () => {
  it('counts from the occurrence while it is still ahead of the clock', () => {
    const options = snoozeOptions('14:10', false, '18:00');

    expect(options.filter((o) => 'until' in o).map((o) => [o.key, o.until])).toEqual([
      ['minutes15', '18:15'],
      ['hour1', '19:00'],
      ['hours3', '21:00'],
    ]);
  });

  /** `This evening (6 PM)` on a 6:00 PM task would move it nowhere, so it is not offered. */
  it('drops a fixed option that does not clear the occurrence', () => {
    expect(snoozeOptions('14:10', false, '18:00').map((o) => o.key)).not.toContain(
      'evening',
    );
    expect(snoozeOptions('14:10', false, '17:00').map((o) => o.key)).toContain('evening');
  });

  it('counts from the clock once the occurrence is past', () => {
    const options = snoozeOptions('19:20', false, '18:00');

    expect(options.filter((o) => 'until' in o).map((o) => o.until)).toEqual([
      '19:35',
      '20:20',
      '22:20',
    ]);
  });

  /** No item time keeps the previous clock-only base, so nothing else had to change. */
  it('falls back to the clock when no occurrence time is supplied', () => {
    expect(snoozeOptions('14:10', false).map((o) => o.key)).toEqual(
      snoozeOptions('14:10', false, '14:00').map((o) => o.key),
    );
  });

  it('still drops an option that would spill past midnight', () => {
    expect(snoozeOptions('10:00', false, '23:00').map((o) => o.key)).toEqual([
      'minutes15',
      'tomorrow',
      'pick',
    ]);
  });
});

describe('isFutureWallTime — against the same base', () => {
  it('rejects a pick that lands before the occurrence it is moving', () => {
    expect(isFutureWallTime('17:00', '14:10', '18:00')).toBe(false);
    expect(isFutureWallTime('18:30', '14:10', '18:00')).toBe(true);
  });

  it('rejects a pick in the past once the occurrence is behind the clock', () => {
    expect(isFutureWallTime('18:30', '19:20', '18:00')).toBe(false);
    expect(isFutureWallTime('19:30', '19:20', '18:00')).toBe(true);
  });
});
