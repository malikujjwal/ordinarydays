import type { Recurrence, RecurrenceSegment } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  buildRepeatLimitAttempt,
  buildRepeatValue,
  endRepeatSeries,
  endsForRecurrence,
  optionForSegment,
  type RepeatOption,
  segmentForOption,
} from './repeat';

const ANCHOR = '2026-08-12'; // Wednesday

describe('segmentForOption', () => {
  it.each<{
    option: Exclude<RepeatOption, 'never'>;
    expected: RecurrenceSegment;
  }>([
    {
      option: 'daily',
      expected: { freq: 'daily', interval: 1, effectiveFrom: ANCHOR },
    },
    { option: 'weekdays', expected: { freq: 'weekdays', effectiveFrom: ANCHOR } },
    {
      option: 'weekly',
      expected: {
        freq: 'weekly',
        interval: 1,
        byWeekday: [3],
        effectiveFrom: ANCHOR,
      },
    },
    {
      option: 'monthly',
      expected: { freq: 'monthly', byMonthDay: [12], effectiveFrom: ANCHOR },
    },
    {
      option: 'yearly',
      expected: {
        freq: 'yearly',
        byMonth: [8],
        byMonthDay: [12],
        effectiveFrom: ANCHOR,
      },
    },
    {
      option: 'interval_days',
      expected: { freq: 'interval_days', interval: 2, effectiveFrom: ANCHOR },
    },
    {
      option: 'selected_weekdays',
      expected: {
        freq: 'weekly',
        interval: 1,
        byWeekday: [1, 5],
        effectiveFrom: ANCHOR,
      },
    },
  ])('writes exact $option fields and anchors', ({ option, expected }) => {
    expect(segmentForOption(option, ANCHOR, 2, [5, 1])).toEqual(expected);
  });
});

describe('buildRepeatValue', () => {
  it.each([
    ['never', { kind: 'never' } as const, {}],
    ['date', { kind: 'date', date: '2026-12-31' } as const, { endDate: '2026-12-31' }],
    ['count', { kind: 'count', count: 7 } as const, { count: 7 }],
  ])('writes %s Ends at series level', (_label, ends, expected) => {
    const result = buildRepeatValue({
      option: 'daily',
      anchorDate: ANCHOR,
      intervalDays: 2,
      selectedWeekdays: [],
      ends,
    });

    expect(result).toMatchObject({ mode: 'fixed', ...expected });
    expect(result.segments[0]).not.toHaveProperty('endDate');
    expect(result.segments[0]).not.toHaveProperty('count');
  });

  it('keeps old segments byte-identical and appends a changed active rule', () => {
    const first: RecurrenceSegment = {
      freq: 'daily',
      interval: 1,
      effectiveFrom: '2026-08-01',
    };
    const second: RecurrenceSegment = {
      freq: 'weekly',
      interval: 1,
      byWeekday: [1],
      effectiveFrom: '2026-08-05',
    };
    const current: Recurrence = { mode: 'fixed', segments: [first, second] };

    const result = buildRepeatValue({
      option: 'monthly',
      anchorDate: ANCHOR,
      intervalDays: 2,
      selectedWeekdays: [],
      ends: { kind: 'never' },
      current,
    });

    expect(result.segments).toEqual([
      first,
      second,
      { freq: 'monthly', byMonthDay: [12], effectiveFrom: ANCHOR },
    ]);
    expect(result.segments[0]).toEqual(first);
    expect(result.segments[1]).toEqual(second);
  });

  it('updates only the series limit when the active rule is unchanged', () => {
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
        intervalDays: 2,
        selectedWeekdays: [],
        ends: { kind: 'count', count: 5 },
        current: { mode: 'fixed', segments: [active] },
      }),
    ).toEqual({ mode: 'fixed', segments: [active], count: 5 });
  });

  it('treats selected weekdays as a set and appends a changed interval', () => {
    const selected: Recurrence = {
      mode: 'fixed',
      segments: [
        {
          freq: 'weekly',
          interval: 1,
          byWeekday: [1, 5],
          effectiveFrom: '2026-08-01',
        },
      ],
    };
    expect(
      buildRepeatValue({
        option: 'selected_weekdays',
        anchorDate: ANCHOR,
        intervalDays: 2,
        selectedWeekdays: [5, 1, 5],
        ends: { kind: 'never' },
        current: selected,
      }).segments,
    ).toHaveLength(1);

    const interval: Recurrence = {
      mode: 'fixed',
      segments: [{ freq: 'interval_days', interval: 2, effectiveFrom: '2026-08-01' }],
    };
    expect(
      buildRepeatValue({
        option: 'interval_days',
        anchorDate: ANCHOR,
        intervalDays: 3,
        selectedWeekdays: [],
        ends: { kind: 'never' },
        current: interval,
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

  it('does nothing below the cap or when the rule is unchanged', () => {
    const input = {
      option: 'monthly' as const,
      anchorDate: ANCHOR,
      intervalDays: 2,
      selectedWeekdays: [],
      ends: { kind: 'never' as const },
    };
    expect(buildRepeatLimitAttempt(input)).toBeUndefined();
    expect(
      buildRepeatLimitAttempt({
        ...input,
        current: { mode: 'fixed', segments: segments.slice(0, 19) },
      }),
    ).toBeUndefined();
    expect(
      buildRepeatLimitAttempt({
        ...input,
        option: 'daily',
        current: { mode: 'fixed', segments },
      }),
    ).toBeUndefined();
  });

  it.each([
    [{ kind: 'never' } as const, {}],
    [{ kind: 'date', date: '2026-12-31' } as const, { endDate: '2026-12-31' }],
    [{ kind: 'count', count: 8 } as const, { count: 8 }],
  ])('builds the deliberate 21st segment with series-level Ends', (ends, expected) => {
    const result = buildRepeatLimitAttempt({
      option: 'monthly',
      anchorDate: ANCHOR,
      intervalDays: 2,
      selectedWeekdays: [],
      ends,
      current: { mode: 'fixed', segments },
    });
    expect(result).toMatchObject({ mode: 'fixed', ...expected });
    expect(result?.segments).toHaveLength(21);
  });
});

describe('repeat projections', () => {
  it('classifies active segments without losing the two weekly choices', () => {
    expect(
      optionForSegment({
        freq: 'weekly',
        interval: 1,
        byWeekday: [1, 5],
        effectiveFrom: ANCHOR,
      }),
    ).toBe('selected_weekdays');
    expect(
      optionForSegment({
        freq: 'weekly',
        interval: 1,
        byWeekday: [3],
        effectiveFrom: ANCHOR,
      }),
    ).toBe('weekly');
    expect(
      optionForSegment({ freq: 'interval_days', interval: 4, effectiveFrom: ANCHOR }),
    ).toBe('interval_days');
    expect(optionForSegment({ freq: 'custom', effectiveFrom: ANCHOR })).toBe('daily');
  });

  it('projects every series-level ending', () => {
    const daily: RecurrenceSegment = {
      freq: 'daily',
      interval: 1,
      effectiveFrom: ANCHOR,
    };
    expect(endsForRecurrence(undefined)).toEqual({ kind: 'never' });
    expect(endsForRecurrence({ mode: 'fixed', segments: [daily] })).toEqual({
      kind: 'never',
    });
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
      segments: [
        { freq: 'interval_days', interval: 3, effectiveFrom: '2026-08-01' },
        { freq: 'weekly', interval: 1, byWeekday: [3], effectiveFrom: ANCHOR },
      ],
      count: 12,
    };

    expect(endRepeatSeries(current, '2026-08-20')).toEqual({
      mode: 'fixed',
      segments: current.segments,
      endDate: '2026-08-20',
    });
  });
});
