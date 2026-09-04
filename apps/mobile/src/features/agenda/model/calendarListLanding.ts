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
