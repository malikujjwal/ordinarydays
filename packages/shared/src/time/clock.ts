import type { Instant, TimeZone, WallDate } from './types.js';
import { toWallDate } from './zone.js';

export interface Clock {
  now(): Instant;
  todayIn(timezone: TimeZone): WallDate;
}

/** The only shared-domain boundary allowed to read the host clock. */
export const systemClock: Clock = {
  now: () => new Date().toISOString() as Instant,
  todayIn: (timezone) => toWallDate(new Date().toISOString() as Instant, timezone),
};

/** A deterministic clock for selectors, providers, stories, and tests. */
export function fixedClock(at: Instant): Clock {
  return {
    now: () => at,
    todayIn: (timezone) => toWallDate(at, timezone),
  };
}
