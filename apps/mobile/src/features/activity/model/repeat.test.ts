import type { Recurrence, RecurrenceSegment } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  buildRepeatLimitAttempt,
  buildRepeatValue,
  endRepeatSeries,
  endsForRecurrence,
  optionForSegment,
  type RepeatOption,
  repeatOptions,
  segmentForOption,
} from './repeat';

const ANCHOR = '2026-08-12'; // Wednesday

describe('repeat options', () => {
  it('exposes the founder-approved dropdown order and labels', () => {
    expect(repeatOptions).toEqual([
      { value: 'never', label: 'Never' },
      { value: 'daily', label: 'Daily' },
      { value: 'weekdays', label: 'Weekdays' },
      { value: 'weekends', label: 'Weekends' },
      { value: 'weekly', label: 'Weekly' },
      { value: 'biweekly', label: 'Biweekly' },
      { value: 'monthly', label: 'Monthly' },
      { value: 'quarterly', label: 'Every 3 Months' },
      { value: 'semiannual', label: 'Every 6 Months' },
      { value: 'yearly', label: 'Yearly' },
      { value: 'custom', label: 'Custom' },
    ]);
  });
});

describe('segmentForOption', () => {
  it.each<{ option: Exclude<RepeatOption, 'never'>; expected: RecurrenceSegment }>([
    { option: 'daily', expected: { freq: 'daily', interval: 1, effectiveFrom: ANCHOR } },
    { option: 'weekdays', expected: { freq: 'weekdays', effectiveFrom: ANCHOR } },
    {
      option: 'weekends',
      expected: { freq: 'weekly', interval: 1, byWeekday: [0, 6], effectiveFrom: ANCHOR },
    },
    {
      option: 'weekly',
      expected: { freq: 'weekly', interval: 1, byWeekday: [3], effectiveFrom: ANCHOR },
    },
    {
      option: 'biweekly',
      expected: { freq: 'weekly', interval: 2, byWeekday: [3], effectiveFrom: ANCHOR },
    },
    {
      option: 'monthly',
      expected: { freq: 'monthly', byMonthDay: [12], effectiveFrom: ANCHOR },
    },
    {
      option: 'quarterly',
      expected: { freq: 'monthly', interval: 3, byMonthDay: [12], effectiveFrom: ANCHOR },
    },
    {
      option: 'semiannual',
      expected: { freq: 'monthly', interval: 6, byMonthDay: [12], effectiveFrom: ANCHOR },
    },
    {
      option: 'yearly',
      expected: { freq: 'yearly', byMonth: [8], byMonthDay: [12], effectiveFrom: ANCHOR },
    },
    {
      option: 'custom',
      expected: { freq: 'interval_days', interval: 9, effectiveFrom: ANCHOR },
    },
  ])('writes exact $option fields and anchors', ({ option, expected }) => {
    expect(segmentForOption(option, ANCHOR, 9)).toEqual(expected);
  });
});

describe('buildRepeatValue', () => {
  it.each([
    [{ kind: 'never' } as const, {}],
    [{ kind: 'date', date: '2026-12-31' } as const, { endDate: '2026-12-31' }],
    [{ kind: 'count', count: 7 } as const, { count: 7 }],
  ])('writes Ends at series level', (ends, expected) => {
    const result = buildRepeatValue({
      option: 'daily',
      anchorDate: ANCHOR,
      customDays: 2,
      ends,
    });
    expect(result).toMatchObject({ mode: 'fixed', ...expected });
    expect(result.segments[0]).not.toHaveProperty('endDate');
    expect(result.segments[0]).not.toHaveProperty('count');
  });

  it('preserves history and appends only a changed active rule', () => {
    const segments: RecurrenceSegment[] = [
      { freq: 'daily', interval: 1, effectiveFrom: '2026-08-01' },
      { freq: 'weekly', interval: 1, byWeekday: [1], effectiveFrom: '2026-08-05' },
    ];
    const result = buildRepeatValue({
      option: 'quarterly',
      anchorDate: ANCHOR,
      customDays: 2,
      ends: { kind: 'never' },
      current: { mode: 'fixed', segments },
    });
    expect(result.segments).toEqual([
      ...segments,
      { freq: 'monthly', interval: 3, byMonthDay: [12], effectiveFrom: ANCHOR },
    ]);
  });

  it('keeps an unchanged active rule and changes only Ends', () => {
    const active: RecurrenceSegment = {
      freq: 'daily',
      interval: 1,
      effectiveFrom: '2026-08-01',
      time: '09:00',
    };
    expect(
      buildRepeatValue({
        option: 'daily',
        anchorDate: ANCHOR,
        customDays: 2,
        ends: { kind: 'count', count: 5 },
        current: { mode: 'fixed', segments: [active] },
      }),
    ).toEqual({ mode: 'fixed', segments: [active], count: 5 });
  });

  it('appends when the custom-day interval changes', () => {
    const current: Recurrence = {
      mode: 'fixed',
      segments: [{ freq: 'interval_days', interval: 2, effectiveFrom: '2026-08-01' }],
    };
    expect(
      buildRepeatValue({
        option: 'custom',
        anchorDate: ANCHOR,
        customDays: 3,
        ends: { kind: 'never' },
        current,
      }).segments,
    ).toHaveLength(2);
  });
});

describe('buildRepeatLimitAttempt', () => {
  const segments = Array.from({ length: 20 }, (_, index) => ({
    freq: 'daily' as const,
    interval: 1,
    effectiveFrom: `2026-07-${String(index + 1).padStart(2, '0')}`,
  }));

  it('returns only a deliberate changed 21st segment', () => {
    expect(
      buildRepeatLimitAttempt({
        option: 'monthly',
        anchorDate: ANCHOR,
        customDays: 2,
        ends: { kind: 'never' },
      }),
    ).toBeUndefined();
    expect(
      buildRepeatLimitAttempt({
        option: 'daily',
        anchorDate: ANCHOR,
        customDays: 2,
        ends: { kind: 'never' },
        current: { mode: 'fixed', segments },
      }),
    ).toBeUndefined();
    expect(
      buildRepeatLimitAttempt({
        option: 'monthly',
        anchorDate: ANCHOR,
        customDays: 2,
        ends: { kind: 'date', date: '2026-12-31' },
        current: { mode: 'fixed', segments },
      }),
    ).toMatchObject({
      endDate: '2026-12-31',
      segments: [
        ...segments,
        { freq: 'monthly', byMonthDay: [12], effectiveFrom: ANCHOR },
      ],
    });
  });
});

describe('repeat projections', () => {
  it.each([
    [
      { freq: 'weekly', interval: 1, byWeekday: [0, 6], effectiveFrom: ANCHOR },
      'weekends',
    ],
    [{ freq: 'weekly', interval: 2, byWeekday: [3], effectiveFrom: ANCHOR }, 'biweekly'],
    [{ freq: 'weekly', interval: 1, byWeekday: [1, 5], effectiveFrom: ANCHOR }, 'weekly'],
    [
      { freq: 'monthly', interval: 3, byMonthDay: [12], effectiveFrom: ANCHOR },
      'quarterly',
    ],
    [
      { freq: 'monthly', interval: 6, byMonthDay: [12], effectiveFrom: ANCHOR },
      'semiannual',
    ],
    [{ freq: 'interval_days', interval: 4, effectiveFrom: ANCHOR }, 'custom'],
    [{ freq: 'custom', effectiveFrom: ANCHOR }, 'custom'],
  ] as const)('projects %j to %s', (segment, expected) => {
    expect(optionForSegment(segment as unknown as RecurrenceSegment)).toBe(expected);
  });

  it('projects every series-level ending', () => {
    const daily: RecurrenceSegment = {
      freq: 'daily',
      interval: 1,
      effectiveFrom: ANCHOR,
    };
    expect(endsForRecurrence(undefined)).toEqual({ kind: 'never' });
    expect(
      endsForRecurrence({ mode: 'fixed', segments: [daily], endDate: '2026-09-01' }),
    ).toEqual({ kind: 'date', date: '2026-09-01' });
    expect(endsForRecurrence({ mode: 'fixed', segments: [daily], count: 9 })).toEqual({
      kind: 'count',
      count: 9,
    });
  });
});

describe('endRepeatSeries', () => {
  it('preserves every segment and replaces count with the end date', () => {
    const current: Recurrence = {
      mode: 'fixed',
      segments: [{ freq: 'daily', effectiveFrom: ANCHOR }],
      count: 12,
    };
    expect(endRepeatSeries(current, '2026-08-20')).toEqual({
      mode: 'fixed',
      segments: current.segments,
      endDate: '2026-08-20',
    });
  });
});
