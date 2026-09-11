export interface FailedCalendarListLanding {
  readonly index: number;
  readonly averageItemLength: number;
}

export interface CalendarListLandingRecovery {
  readonly offset: number;
  readonly retryAfterMs: number;
}

/**
 * A distant SectionList target may not be measured yet. Move once to the list's own stable
 * estimate and give the native list several render batches to mount the target. React Native
 * batches distant cells every 50 ms by default, so the former two 32 ms retries could both
 * expire around the first batch and strand a far-month landing at its rough estimate. The
 * retries remain bounded and never walk the estimate farther.
 */
/** How long a calendar landing keeps retrying once the list can place its target. */
export const CALENDAR_LANDING_WINDOW_MS = 256;

/**
 * The deadline a failed landing leaves behind. A list remounted for a calendar date fails
 * every landing until it has measured a single cell; on RN 0.86 (Expo SDK 57) that arrives
 * ~250 ms after the tap, so a window counted from the tap expired first and stranded the list
 * on its preceding row. Only a list that has measured nothing restarts the window: a measured
 * list's late failure keeps the original deadline, and the recovery's attempt cap below still
 * bounds the whole landing.
 */
export function calendarListLandingDeadline(
  info: FailedCalendarListLanding,
  now: number,
  deadline: number,
): number {
  return info.averageItemLength === 0
    ? Math.max(deadline, now + CALENDAR_LANDING_WINDOW_MS)
    : deadline;
}

export function calendarListLandingRecovery(
  info: FailedCalendarListLanding,
  attempt: number,
): CalendarListLandingRecovery | undefined {
  if (attempt >= 8) return undefined;
  return {
    offset: info.averageItemLength * info.index,
    retryAfterMs: 32,
  };
}
