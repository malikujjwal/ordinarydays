import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock.js';
import type { Instant, TimeZone } from './types.js';

describe('fixedClock', () => {
  it('holds one instant while deriving calendar dates in different zones', () => {
    const instant = '2026-08-07T00:30:00.000Z' as Instant;
    const clock = fixedClock(instant);

    expect(clock.now()).toBe(instant);
    expect(clock.todayIn('America/New_York' as TimeZone)).toBe('2026-08-06');
    expect(clock.todayIn('Asia/Tokyo' as TimeZone)).toBe('2026-08-07');
  });
});
