import type { RecurrenceSegment } from '../../types/recurrence.js';
import { addWallDays, wallDateParts } from '../calendar.js';
import type { RuleWindow } from './shared.js';

function firstWeekdayOnOrAfter(date: string): string {
  const { weekday } = wallDateParts(date);
  if (weekday === 6) return addWallDays(date, 2);
  if (weekday === 0) return addWallDays(date, 1);
  return date;
}

export function expandWeekdays(
  _segment: RecurrenceSegment,
  window: RuleWindow,
): string[] {
  const dates: string[] = [];
  let date = firstWeekdayOnOrAfter(window.from);

  while (date <= window.to && dates.length < window.maxOccurrences) {
    window.step();
    dates.push(date);
    date = addWallDays(date, wallDateParts(date).weekday === 5 ? 3 : 1);
  }

  return dates;
}
