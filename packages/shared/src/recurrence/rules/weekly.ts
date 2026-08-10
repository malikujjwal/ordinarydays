import type { RecurrenceSegment, Weekday } from '../../types/recurrence.js';
import { addWallDays, differenceInWallWeeks, startOfWallWeek } from '../calendar.js';
import { RecurrenceValidationError } from '../error.js';
import type { RuleWindow } from './shared.js';

export function expandWeekly(segment: RecurrenceSegment, window: RuleWindow): string[] {
  const weekdays = [...new Set(segment.byWeekday ?? [])].sort(
    (a, b) => a - b,
  ) as Weekday[];
  if (weekdays.length === 0) {
    throw new RecurrenceValidationError(
      'Weekly recurrence requires at least one weekday.',
    );
  }

  const interval = segment.interval ?? 1;
  if (interval < 1) {
    throw new RecurrenceValidationError('Weekly recurrence interval must be positive.');
  }

  const anchorWeek = startOfWallWeek(segment.effectiveFrom);
  const fromWeek = startOfWallWeek(window.from);
  const elapsedWeeks = Math.max(0, differenceInWallWeeks(fromWeek, anchorWeek));
  const activeWeekOffset = Math.ceil(elapsedWeeks / interval) * interval;
  let weekStart = addWallDays(anchorWeek, activeWeekOffset * 7);
  const dates: string[] = [];

  while (weekStart <= window.to && dates.length < window.maxOccurrences) {
    window.step();
    for (const weekday of weekdays) {
      const date = addWallDays(weekStart, weekday);
      if (
        date >= segment.effectiveFrom &&
        date >= window.from &&
        date <= window.to &&
        dates.length < window.maxOccurrences
      ) {
        dates.push(date);
      }
    }
    weekStart = addWallDays(weekStart, interval * 7);
  }

  return dates;
}
