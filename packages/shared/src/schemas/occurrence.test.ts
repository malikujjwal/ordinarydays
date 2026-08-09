import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { Occurrence } from '../types/occurrence.js';
import { occurrence } from './occurrence.js';

describe('the schema and the interface are the same shape', () => {
  it('Occurrence is assignable both ways', () => {
    expectTypeOf<z.infer<typeof occurrence>>().toEqualTypeOf<Occurrence>();
  });
});

const valid = {
  activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  date: '2026-08-08',
  status: 'completed',
};

describe('an occurrence override', () => {
  it('accepts the minimal row', () => {
    expect(occurrence.safeParse(valid).success).toBe(true);
  });

  it.each(['completed', 'skipped', 'snoozed', 'rescheduled'])(
    'accepts status %s',
    (status) => {
      expect(occurrence.safeParse({ ...valid, status }).success).toBe(true);
    },
  );

  it('accepts a same-day snooze as HH:mm', () => {
    expect(
      occurrence.safeParse({ ...valid, status: 'snoozed', snoozedUntil: '20:00' })
        .success,
    ).toBe(true);
  });

  it('accepts a snooze to an instant on another day', () => {
    expect(
      occurrence.safeParse({
        ...valid,
        status: 'snoozed',
        snoozedUntil: '2026-08-09T20:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  /**
   * The this-occurrence-only reschedule. `date` stays the series' nominal date — it is the
   * key — and `overrideDate` is where this one instance moved to. Storing the move here
   * rather than editing the rule is what keeps the series untouched.
   */
  it('accepts an overrideDate distinct from the nominal date', () => {
    const result = occurrence.safeParse({
      ...valid,
      status: 'rescheduled',
      overrideDate: '2026-08-11',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.date).toBe('2026-08-08');
      expect(result.data.overrideDate).toBe('2026-08-11');
    }
  });

  it.each([
    ['an impossible nominal date', { date: '2026-13-45' }],
    ['an impossible overrideDate', { overrideDate: '2026-02-30' }],
    ['a malformed overrideTime', { overrideTime: '25:00' }],
    ['an unknown status', { status: 'postponed' }],
  ])('rejects %s', (_why, extra) => {
    expect(occurrence.safeParse({ ...valid, ...extra }).success).toBe(false);
  });
});
