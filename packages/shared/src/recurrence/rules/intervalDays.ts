import type { RecurrenceSegment } from '../../types/recurrence.js';
import { addWallDays, differenceInWallDays } from '../calendar.js';
import { RecurrenceValidationError } from '../error.js';
import { firstAlignedDate, type RuleWindow } from './shared.js';

export function expandIntervalDays(
  segment: RecurrenceSegment,
  window: RuleWindow,
): string[] {
  const interval = segment.interval;
  if (interval === undefined || interval < 2 || interval > 365) {
    throw new RecurrenceValidationError(
      'Every-X-days recurrence requires an interval from 2 to 365.',
    );
  }

  const dates: string[] = [];
  let date = firstAlignedDate(
    segment.effectiveFrom,
    window.from,
    interval,
    differenceInWallDays,
    addWallDays,
  );

  while (date <= window.to && dates.length < window.maxOccurrences) {
    window.step();
    dates.push(date);
    date = addWallDays(date, interval);
  }

  return dates;
}
