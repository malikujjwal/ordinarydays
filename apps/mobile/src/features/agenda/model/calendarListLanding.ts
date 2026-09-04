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
 * estimate and give layout two frames to mount the target; walking the estimate farther on
 * every failure overshoots the row and turns one tap into seconds of JS-thread work.
 */
export function calendarListLandingRecovery(
  info: FailedCalendarListLanding,
  attempt: number,
): CalendarListLandingRecovery | undefined {
  if (attempt >= 2) return undefined;
  return {
    offset: info.averageItemLength * info.index,
    retryAfterMs: 32,
  };
}
