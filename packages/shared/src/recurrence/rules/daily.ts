import type { RecurrenceSegment } from '../../types/recurrence.js';
import { addWallDays, differenceInWallDays } from '../calendar.js';
import { firstAlignedDate, type RuleWindow } from './shared.js';

export function expandDaily(segment: RecurrenceSegment, window: RuleWindow): string[] {
  const dates: string[] = [];
  let date = firstAlignedDate(
    segment.effectiveFrom,
    window.from,
    1,
    differenceInWallDays,
    addWallDays,
  );

  while (date <= window.to && dates.length < window.maxOccurrences) {
    window.step();
    dates.push(date);
    date = addWallDays(date, 1);
  }

  return dates;
}
