import { describe, expect, it } from 'vitest';
import { formatOverdueAccessibilityLabel, formatOverdueChip } from './formatOverdueChip';

describe('formatOverdueChip', () => {
  const today = '2026-08-06';

  it.each([
    ['2026-08-05', 'Yesterday'],
    ['2026-08-04', 'Tue'],
    ['2026-08-03', 'Mon'],
    ['2026-08-02', 'Sun'],
    ['2026-08-01', 'Sat'],
    ['2026-07-31', 'Fri'],
    ['2026-07-30', '30 Jul'],
    ['2026-07-07', '7 Jul'],
  ])('formats %s as %s', (overdueFromDate, expected) => {
    expect(formatOverdueChip(overdueFromDate, today)).toBe(expected);
  });

  it('keeps the spoken label unabbreviated', () => {
    expect(formatOverdueAccessibilityLabel('2026-08-04')).toBe(
      'Overdue from Tuesday 4 August',
    );
  });
});
