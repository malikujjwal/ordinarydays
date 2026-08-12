import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { MAX_RECURRENCE_SEGMENTS } from '../constants.js';
import type { Recurrence } from '../types/recurrence.js';
import { createRecurrence, recurrence } from './recurrence.js';

const daily = (effectiveFrom: string) => ({ freq: 'daily' as const, effectiveFrom });
const series = (
  segment: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  mode: 'fixed',
  segments: [{ effectiveFrom: '2026-08-08', ...segment }],
  ...extra,
});

describe('schema and interface parity', () => {
  it('keeps the stored recurrence schema assignable both ways with its interface', () => {
    expectTypeOf<z.infer<typeof recurrence>>().toEqualTypeOf<Recurrence>();
  });

  it('narrows creation to a one-element segment tuple', () => {
    const parsed = createRecurrence.parse(series({ freq: 'daily' }));

    expectTypeOf(parsed.segments).toEqualTypeOf<[Recurrence['segments'][number]]>();
    expect(parsed.segments).toHaveLength(1);
  });
});

describe('mode and future rule kinds', () => {
  it('accepts fixed recurrence', () => {
    expect(recurrence.safeParse(series({ freq: 'daily' })).success).toBe(true);
  });

  it('rejects completion-relative recurrence with the phase in its message', () => {
    const result = recurrence.safeParse({
      ...series({ freq: 'daily' }),
      mode: 'after_completion',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('Phase 9');
  });

  it('rejects an unknown mode', () => {
    expect(
      recurrence.safeParse({ ...series({ freq: 'daily' }), mode: 'floating' }).success,
    ).toBe(false);
  });

  it('rejects custom recurrence even when it carries an rrule', () => {
    expect(
      recurrence.safeParse(series({ freq: 'custom', rrule: 'FREQ=DAILY' })).success,
    ).toBe(false);
  });

  it('rejects custom recurrence without an rrule too', () => {
    expect(recurrence.safeParse(series({ freq: 'custom' })).success).toBe(false);
  });
});

describe('weekly rules', () => {
  it('accepts one or several valid weekdays', () => {
    expect(
      recurrence.safeParse(series({ freq: 'weekly', byWeekday: [0, 3, 6] })).success,
    ).toBe(true);
  });

  it.each([
    ['no weekday list', { freq: 'weekly' }],
    ['an empty weekday list', { freq: 'weekly', byWeekday: [] }],
    ['a weekday below Sunday', { freq: 'weekly', byWeekday: [-1] }],
    ['a weekday above Saturday', { freq: 'weekly', byWeekday: [7] }],
  ])('rejects %s', (_name, segment) => {
    expect(recurrence.safeParse(series(segment)).success).toBe(false);
  });
});

describe('monthly rules', () => {
  it('accepts exactly one month-day anchor', () => {
    expect(
      recurrence.safeParse(series({ freq: 'monthly', byMonthDay: [31] })).success,
    ).toBe(true);
  });

  it.each([1, 3, 6, 365])('accepts a positive monthly interval of %i', (interval) => {
    expect(
      recurrence.safeParse(series({ freq: 'monthly', interval, byMonthDay: [31] }))
        .success,
    ).toBe(true);
  });

  it.each([
    ['no month-day anchor', { freq: 'monthly' }],
    ['an empty month-day list', { freq: 'monthly', byMonthDay: [] }],
    ['two month-day anchors', { freq: 'monthly', byMonthDay: [1, 15] }],
    ['day zero', { freq: 'monthly', byMonthDay: [0] }],
    ['day 32', { freq: 'monthly', byMonthDay: [32] }],
  ])('rejects %s', (_name, segment) => {
    expect(recurrence.safeParse(series(segment)).success).toBe(false);
  });
});

describe('yearly rules', () => {
  it('accepts one explicit month and day anchor', () => {
    expect(
      recurrence.safeParse(series({ freq: 'yearly', byMonth: [2], byMonthDay: [29] }))
        .success,
    ).toBe(true);
  });

  it('accepts neither anchor as the documented hand-constructed fallback', () => {
    expect(recurrence.safeParse(series({ freq: 'yearly' })).success).toBe(true);
  });

  it.each([
    ['only a month', { freq: 'yearly', byMonth: [9] }],
    ['only a month-day', { freq: 'yearly', byMonthDay: [3] }],
    ['two months', { freq: 'yearly', byMonth: [1, 2], byMonthDay: [3] }],
    ['two month-days', { freq: 'yearly', byMonth: [9], byMonthDay: [3, 4] }],
    ['month zero', { freq: 'yearly', byMonth: [0], byMonthDay: [3] }],
    ['month 13', { freq: 'yearly', byMonth: [13], byMonthDay: [3] }],
  ])('rejects %s', (_name, segment) => {
    expect(recurrence.safeParse(series(segment)).success).toBe(false);
  });
});

describe('every-X-days rules', () => {
  it.each([2, 365])('accepts the inclusive interval bound %i', (interval) => {
    expect(
      recurrence.safeParse(series({ freq: 'interval_days', interval })).success,
    ).toBe(true);
  });

  it('normalises interval one to daily', () => {
    const parsed = recurrence.parse(series({ freq: 'interval_days', interval: 1 }));

    expect(parsed.segments[0]?.freq).toBe('daily');
    expect(parsed.segments[0]?.interval).toBe(1);
  });

  it.each([
    ['a missing interval', { freq: 'interval_days' }],
    ['zero', { freq: 'interval_days', interval: 0 }],
    ['a fractional interval', { freq: 'interval_days', interval: 2.5 }],
    ['an interval above 365', { freq: 'interval_days', interval: 366 }],
  ])('rejects %s', (_name, segment) => {
    expect(recurrence.safeParse(series(segment)).success).toBe(false);
  });
});

describe('series-level Ends', () => {
  it.each([1, 999])('accepts count %i', (count) => {
    expect(recurrence.safeParse(series({ freq: 'daily' }, { count })).success).toBe(true);
  });

  it.each([0, -1, 2.5, 1000])('rejects count %s', (count) => {
    expect(recurrence.safeParse(series({ freq: 'daily' }, { count })).success).toBe(
      false,
    );
  });

  it('accepts an end date on the first anchor', () => {
    expect(
      recurrence.safeParse(series({ freq: 'daily' }, { endDate: '2026-08-08' })).success,
    ).toBe(true);
  });

  it.each(['2026-08-07', '2025-12-31'])(
    'rejects an end date before the first anchor: %s',
    (endDate) => {
      expect(recurrence.safeParse(series({ freq: 'daily' }, { endDate })).success).toBe(
        false,
      );
    },
  );
});

describe('segment history', () => {
  it('accepts strictly ascending effective dates', () => {
    expect(
      recurrence.safeParse({
        mode: 'fixed',
        segments: [daily('2026-01-01'), daily('2026-06-01'), daily('2026-08-08')],
      }).success,
    ).toBe(true);
  });

  it.each([
    [daily('2026-08-08'), daily('2026-01-01')],
    [daily('2026-08-08'), daily('2026-08-08')],
  ])('rejects history that is not strictly ascending', (...segments) => {
    expect(recurrence.safeParse({ mode: 'fixed', segments }).success).toBe(false);
  });

  it(`accepts exactly ${MAX_RECURRENCE_SEGMENTS} segments`, () => {
    const segments = Array.from({ length: MAX_RECURRENCE_SEGMENTS }, (_, index) =>
      daily(`2026-01-${String(index + 1).padStart(2, '0')}`),
    );

    expect(recurrence.safeParse({ mode: 'fixed', segments }).success).toBe(true);
  });

  it(`rejects the ${MAX_RECURRENCE_SEGMENTS + 1}st with an explanatory message`, () => {
    const segments = Array.from({ length: MAX_RECURRENCE_SEGMENTS + 1 }, (_, index) =>
      daily(`2026-01-${String(index + 1).padStart(2, '0')}`),
    );
    const result = recurrence.safeParse({ mode: 'fixed', segments });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('start a new one');
  });

  it('rejects a missing effective date', () => {
    expect(
      recurrence.safeParse({ mode: 'fixed', segments: [{ freq: 'daily' }] }).success,
    ).toBe(false);
  });

  it('rejects an unknown segment field rather than stripping it', () => {
    expect(
      recurrence.safeParse(series({ freq: 'daily', effectiveUntil: '2026-12-31' }))
        .success,
    ).toBe(false);
  });
});

describe('creation', () => {
  it('accepts exactly one segment', () => {
    expect(createRecurrence.safeParse(series({ freq: 'daily' })).success).toBe(true);
  });

  it('rejects two segments', () => {
    expect(
      createRecurrence.safeParse({
        mode: 'fixed',
        segments: [daily('2026-08-08'), daily('2026-08-09')],
      }).success,
    ).toBe(false);
  });
});
