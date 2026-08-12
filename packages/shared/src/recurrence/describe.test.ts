import { describe, expect, it, vi } from 'vitest';
import type {
  MonthNumber,
  Recurrence,
  RecurrenceFreq,
  RecurrenceSegment,
} from '../types/recurrence.js';
import { describeRecurrence } from './describe.js';
import { RecurrenceValidationError } from './error.js';

const TODAY = '2026-08-10';

function recurrence(
  segment: RecurrenceSegment,
  ends: Pick<Recurrence, 'endDate' | 'count'> = {},
): Recurrence {
  return { mode: 'fixed', segments: [segment], ...ends };
}

describe('describeRecurrence', () => {
  const cases: Array<{
    name: string;
    recurrence: Recurrence;
    today?: string;
    expected: string;
  }> = [
    {
      name: 'labels a daily series',
      recurrence: recurrence({ freq: 'daily', effectiveFrom: '2026-08-01' }),
      expected: 'Daily',
    },
    {
      name: 'labels weekdays separately from a weekly rule',
      recurrence: recurrence({ freq: 'weekdays', effectiveFrom: '2026-08-03' }),
      expected: 'Every weekday',
    },
    {
      name: 'labels a weekly series on one weekday',
      recurrence: recurrence({
        freq: 'weekly',
        byWeekday: [4],
        effectiveFrom: '2026-08-06',
      }),
      expected: 'Weekly on Thursday',
    },
    {
      name: 'sorts and de-duplicates several weekdays in Monday-first order',
      recurrence: recurrence({
        freq: 'weekly',
        byWeekday: [5, 1, 3, 1],
        effectiveFrom: '2026-08-03',
      }),
      expected: 'Weekly on Monday, Wednesday and Friday',
    },
    {
      name: 'puts Sunday last in a Monday-first week',
      recurrence: recurrence({
        freq: 'weekly',
        byWeekday: [0, 2, 1],
        effectiveFrom: '2026-08-02',
      }),
      expected: 'Weekly on Monday, Tuesday and Sunday',
    },
    {
      name: 'labels an every-N-weeks series',
      recurrence: recurrence({
        freq: 'weekly',
        interval: 2,
        byWeekday: [1],
        effectiveFrom: '2026-08-03',
      }),
      expected: 'Every 2 weeks on Monday',
    },
    {
      name: 'labels a monthly series with an ordinal',
      recurrence: recurrence({
        freq: 'monthly',
        byMonthDay: [6],
        effectiveFrom: '2026-08-06',
      }),
      expected: 'Monthly on the 6th',
    },
    {
      name: 'falls back to the monthly effective date when an anchor is absent',
      recurrence: recurrence({ freq: 'monthly', effectiveFrom: '2026-08-06' }),
      expected: 'Monthly on the 6th',
    },
    {
      name: 'labels an every-three-months series',
      recurrence: recurrence({
        freq: 'monthly',
        interval: 3,
        byMonthDay: [6],
        effectiveFrom: '2026-08-06',
      }),
      expected: 'Every 3 months on the 6th',
    },
    {
      name: 'labels an every-six-months series',
      recurrence: recurrence({
        freq: 'monthly',
        interval: 6,
        byMonthDay: [6],
        effectiveFrom: '2026-08-06',
      }),
      expected: 'Every 6 months on the 6th',
    },
    {
      name: 'labels a yearly series from its explicit anchors',
      recurrence: recurrence({
        freq: 'yearly',
        byMonth: [9],
        byMonthDay: [3],
        effectiveFrom: '2026-09-03',
      }),
      expected: 'Every year on 3 September',
    },
    {
      name: 'labels a leap-day series from the stored anchor rather than a clamped date',
      recurrence: recurrence({
        freq: 'yearly',
        byMonth: [2],
        byMonthDay: [29],
        effectiveFrom: '2028-02-29',
      }),
      expected: 'Every year on 29 February',
    },
    {
      name: 'falls back to the yearly effective date when anchors are absent',
      recurrence: recurrence({ freq: 'yearly', effectiveFrom: '2026-08-06' }),
      expected: 'Every year on 6 August',
    },
    {
      name: 'labels an every-N-days series',
      recurrence: recurrence({
        freq: 'interval_days',
        interval: 3,
        effectiveFrom: '2026-08-01',
      }),
      expected: 'Every 3 days',
    },
    {
      name: 'omits the year from an end date in the current year',
      recurrence: recurrence(
        { freq: 'daily', effectiveFrom: '2026-08-01' },
        { endDate: '2026-12-12' },
      ),
      expected: 'Daily until 12 Dec',
    },
    {
      name: 'includes the year for an end date outside the current year',
      recurrence: recurrence(
        { freq: 'daily', effectiveFrom: '2026-08-01' },
        { endDate: '2027-12-12' },
      ),
      expected: 'Daily until 12 Dec 2027',
    },
    {
      name: 'labels a count of one with the singular noun',
      recurrence: recurrence(
        { freq: 'daily', effectiveFrom: '2026-08-01' },
        { count: 1 },
      ),
      expected: 'Daily, 1 time',
    },
    {
      name: 'labels a count greater than one with the plural noun',
      recurrence: recurrence(
        { freq: 'daily', effectiveFrom: '2026-08-01' },
        { count: 3 },
      ),
      expected: 'Daily, 3 times',
    },
    {
      name: 'shows only the end-date suffix when both Ends bounds are present',
      recurrence: recurrence(
        { freq: 'daily', effectiveFrom: '2026-08-01' },
        { endDate: '2026-12-12', count: 3 },
      ),
      expected: 'Daily until 12 Dec',
    },
    {
      name: 'describes only the active segment of a changed series',
      recurrence: {
        mode: 'fixed',
        segments: [
          {
            freq: 'weekly',
            byWeekday: [1, 3, 5],
            effectiveFrom: '2026-01-05',
          },
          {
            freq: 'monthly',
            byMonthDay: [10],
            effectiveFrom: '2026-08-10',
          },
        ],
      },
      expected: 'Monthly on the 10th',
    },
  ];

  it.each(cases)('$name', (testCase) => {
    expect(describeRecurrence(testCase.recurrence, testCase.today ?? TODAY)).toBe(
      testCase.expected,
    );
  });

  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [22, '22nd'],
    [23, '23rd'],
    [31, '31st'],
  ])('uses the correct ordinal suffix for day %i', (day, expectedOrdinal) => {
    const rec = recurrence({
      freq: 'monthly',
      byMonthDay: [day],
      effectiveFrom: '2026-01-01',
    });

    expect(describeRecurrence(rec, TODAY)).toBe(`Monthly on the ${expectedOrdinal}`);
  });

  it('is pure and independent of the process clock', () => {
    const rec = Object.freeze({
      mode: 'fixed',
      segments: Object.freeze([
        Object.freeze({
          freq: 'weekly',
          byWeekday: Object.freeze([5, 1, 3]),
          effectiveFrom: '2026-08-03',
        }),
      ]),
      endDate: '2027-12-12',
    }) as unknown as Recurrence;
    const before = JSON.stringify(rec);

    vi.useFakeTimers();
    try {
      vi.setSystemTime('2026-08-10T12:00:00.000Z');
      const first = describeRecurrence(rec, TODAY);
      vi.setSystemTime('2027-08-10T12:00:00.000Z');
      const second = describeRecurrence(rec, TODAY);

      expect(first).toBe('Weekly on Monday, Wednesday and Friday until 12 Dec 2027');
      expect(second).toBe(first);
      expect(JSON.stringify(rec)).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  const errorCases: Array<{
    name: string;
    recurrence: Recurrence;
    message: string;
  }> = [
    {
      name: 'completion-relative mode',
      recurrence: {
        mode: 'after_completion',
        segments: [{ freq: 'interval_days', interval: 3, effectiveFrom: '2026-08-01' }],
      },
      message: 'Completion-relative recurrence is not available until Phase 9.',
    },
    {
      name: 'an empty segment list',
      recurrence: { mode: 'fixed', segments: [] },
      message: 'Recurrence requires at least one segment.',
    },
    {
      name: 'a custom rule',
      recurrence: recurrence({
        freq: 'custom',
        rrule: 'FREQ=DAILY',
        effectiveFrom: '2026-08-01',
      }),
      message: 'Custom recurrence is not available until Phase 9.',
    },
    {
      name: 'an unsupported frequency',
      recurrence: recurrence({
        freq: 'fortnightly' as RecurrenceFreq,
        effectiveFrom: '2026-08-01',
      }),
      message: 'Unsupported recurrence frequency.',
    },
    {
      name: 'a weekly rule without weekdays',
      recurrence: recurrence({ freq: 'weekly', effectiveFrom: '2026-08-01' }),
      message: 'Weekly recurrence requires at least one weekday.',
    },
    {
      name: 'a weekly rule with a non-positive interval',
      recurrence: recurrence({
        freq: 'weekly',
        interval: 0,
        byWeekday: [1],
        effectiveFrom: '2026-08-01',
      }),
      message: 'Weekly recurrence interval must be positive.',
    },
    {
      name: 'a monthly rule with a non-positive interval',
      recurrence: recurrence({
        freq: 'monthly',
        interval: 0,
        byMonthDay: [1],
        effectiveFrom: '2026-08-01',
      }),
      message: 'Monthly recurrence interval must be positive.',
    },
    {
      name: 'an every-X-days rule without an interval',
      recurrence: recurrence({ freq: 'interval_days', effectiveFrom: '2026-08-01' }),
      message: 'Every-X-days recurrence requires an interval from 2 to 365.',
    },
    {
      name: 'an every-X-days rule below its interval range',
      recurrence: recurrence({
        freq: 'interval_days',
        interval: 1,
        effectiveFrom: '2026-08-01',
      }),
      message: 'Every-X-days recurrence requires an interval from 2 to 365.',
    },
    {
      name: 'an every-X-days rule above its interval range',
      recurrence: recurrence({
        freq: 'interval_days',
        interval: 366,
        effectiveFrom: '2026-08-01',
      }),
      message: 'Every-X-days recurrence requires an interval from 2 to 365.',
    },
    {
      name: 'a yearly rule with only a month anchor',
      recurrence: recurrence({
        freq: 'yearly',
        byMonth: [9],
        effectiveFrom: '2026-09-03',
      }),
      message: 'Yearly recurrence requires both month and month-day anchors, or neither.',
    },
    {
      name: 'a yearly rule with only a month-day anchor',
      recurrence: recurrence({
        freq: 'yearly',
        byMonthDay: [3],
        effectiveFrom: '2026-09-03',
      }),
      message: 'Yearly recurrence requires both month and month-day anchors, or neither.',
    },
  ];

  it.each(errorCases)('throws a typed error for $name', (testCase) => {
    const call = () => describeRecurrence(testCase.recurrence, TODAY);

    expect(call).toThrow(RecurrenceValidationError);
    expect(call).toThrow(testCase.message);
  });

  it('uses every fixed English month name', () => {
    const names = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];

    for (const [index, name] of names.entries()) {
      const month = (index + 1) as MonthNumber;
      expect(
        describeRecurrence(
          recurrence({
            freq: 'yearly',
            byMonth: [month],
            byMonthDay: [1],
            effectiveFrom: '2026-01-01',
          }),
          TODAY,
        ),
        `month ${month}`,
      ).toBe(`Every year on 1 ${name}`);
    }
  });

  it('rejects an invalid hand-constructed end-date month', () => {
    expect(() =>
      describeRecurrence(
        {
          mode: 'fixed',
          segments: [{ freq: 'daily', effectiveFrom: '2026-01-01' }],
          endDate: '2026-13-01',
        },
        TODAY,
      ),
    ).toThrow('Month must be from 1 to 12.');
  });
});
