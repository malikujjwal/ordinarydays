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
