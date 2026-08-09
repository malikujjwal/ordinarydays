import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { MAX_RECURRENCE_SEGMENTS } from '../constants.js';
import type { Recurrence } from '../types/recurrence.js';
import { recurrence } from './recurrence.js';

describe('the schema and the interface are the same shape', () => {
  it('Recurrence is assignable both ways', () => {
    expectTypeOf<z.infer<typeof recurrence>>().toEqualTypeOf<Recurrence>();
  });
});

const segment = (effectiveFrom: string) => ({ freq: 'weekly' as const, effectiveFrom });

describe('segments', () => {
  it('accepts a single-segment series, which is what every new series is', () => {
    expect(
      recurrence.safeParse({ mode: 'fixed', segments: [segment('2026-08-08')] }).success,
    ).toBe(true);
  });

  it('rejects a series with no segments — there is no rule to expand', () => {
    expect(recurrence.safeParse({ mode: 'fixed', segments: [] }).success).toBe(false);
  });

  it('accepts segments in strictly ascending order', () => {
    expect(
      recurrence.safeParse({
        mode: 'fixed',
        segments: [segment('2026-01-01'), segment('2026-06-01'), segment('2026-08-08')],
      }).success,
    ).toBe(true);
  });

  /**
   * Out-of-order segments make an older rule shadow a newer one, and the symptom is an
   * occurrence on the wrong day months later. Rejected at the boundary because nothing else
   * in Phase 1 would catch it.
   */
  it('rejects descending segments', () => {
    expect(
      recurrence.safeParse({
        mode: 'fixed',
        segments: [segment('2026-08-08'), segment('2026-01-01')],
      }).success,
    ).toBe(false);
  });

  it('rejects two segments effective on the same day — strictly ascending, not merely sorted', () => {
    expect(
      recurrence.safeParse({
        mode: 'fixed',
        segments: [segment('2026-08-08'), segment('2026-08-08')],
      }).success,
    ).toBe(false);
  });

  it(`accepts exactly ${MAX_RECURRENCE_SEGMENTS} segments`, () => {
    const segments = Array.from({ length: MAX_RECURRENCE_SEGMENTS }, (_, i) =>
      segment(`2026-01-${String(i + 1).padStart(2, '0')}`),
    );
    expect(recurrence.safeParse({ mode: 'fixed', segments }).success).toBe(true);
  });

  it(`rejects the ${MAX_RECURRENCE_SEGMENTS + 1}th`, () => {
    const segments = Array.from({ length: MAX_RECURRENCE_SEGMENTS + 1 }, (_, i) =>
      segment(`2026-01-${String(i + 1).padStart(2, '0')}`),
    );
    expect(recurrence.safeParse({ mode: 'fixed', segments }).success).toBe(false);
  });
});

describe('rule fields', () => {
  const parse = (extra: Record<string, unknown>) =>
    recurrence.safeParse({
      mode: 'fixed',
      segments: [{ ...segment('2026-08-08'), ...extra }],
    }).success;

  it('accepts explicit yearly anchors, which the Repeat sheet always writes', () => {
    expect(parse({ freq: 'yearly', byMonth: [2], byMonthDay: [29] })).toBe(true);
  });

  it('accepts selected weekdays', () => {
    expect(parse({ freq: 'weekly', byWeekday: [1, 3, 5] })).toBe(true);
  });

  it.each([
    ['a weekday above Saturday', { byWeekday: [7] }],
    ['a month above December', { byMonth: [13] }],
    ['a month day above 31', { byMonthDay: [32] }],
    ['a zero month day', { byMonthDay: [0] }],
    ['a zero interval', { freq: 'interval_days', interval: 0 }],
    ['a fractional interval', { freq: 'interval_days', interval: 1.5 }],
    ['an unknown frequency', { freq: 'fortnightly' }],
    ['an empty weekday list', { byWeekday: [] }],
  ])('rejects %s', (_why, extra) => {
    expect(parse(extra)).toBe(false);
  });

  it('rejects a segment with no effectiveFrom, which has no anchor to expand from', () => {
    expect(
      recurrence.safeParse({ mode: 'fixed', segments: [{ freq: 'daily' }] }).success,
    ).toBe(false);
  });
});

describe('series-level ends', () => {
  const base = { mode: 'fixed' as const, segments: [segment('2026-08-08')] };

  it('accepts an end date', () => {
    expect(recurrence.safeParse({ ...base, endDate: '2026-12-31' }).success).toBe(true);
  });

  it('accepts a count', () => {
    expect(recurrence.safeParse({ ...base, count: 10 }).success).toBe(true);
  });

  it.each([
    ['a zero count', 0],
    ['a negative count', -1],
    ['a fractional count', 2.5],
  ])('rejects %s', (_why, count) => {
    expect(recurrence.safeParse({ ...base, count }).success).toBe(false);
  });

  it('rejects a malformed end date rather than an impossible occurrence', () => {
    expect(recurrence.safeParse({ ...base, endDate: '2026-13-45' }).success).toBe(false);
  });
});
