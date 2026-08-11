import { describe, expect, it } from 'vitest';
import type { Instant, TimeZone, WallDate, WallTime } from './types.js';
import { toInstant, toWallDate, toWallTime } from './zone.js';

describe('wall-clock conversion', () => {
  const newYork = 'America/New_York' as TimeZone;

  it('round-trips a local date and time through an instant', () => {
    const instant = toInstant('2026-07-01' as WallDate, '18:00' as WallTime, newYork);

    expect(instant).toBe('2026-07-01T22:00:00.000Z');
    expect(toWallDate(instant, newYork)).toBe('2026-07-01');
    expect(toWallTime(instant, newYork)).toBe('18:00');
  });

  it('keeps the wall time stable across the DST boundary', () => {
    const before = toInstant('2026-03-07' as WallDate, '18:00' as WallTime, newYork);
    const after = toInstant('2026-03-08' as WallDate, '18:00' as WallTime, newYork);

    expect(before).toBe('2026-03-07T23:00:00.000Z' as Instant);
    expect(after).toBe('2026-03-08T22:00:00.000Z' as Instant);
  });
});
