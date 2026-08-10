import type { RecurrenceSegment } from '../../types/recurrence.js';
import { clampWallDate, wallDateParts } from '../calendar.js';
import { RecurrenceValidationError } from '../error.js';
import type { RuleWindow } from './shared.js';

export function expandYearly(segment: RecurrenceSegment, window: RuleWindow): string[] {
  const anchor = wallDateParts(segment.effectiveFrom);
  const hasMonth = segment.byMonth !== undefined;
  const hasMonthDay = segment.byMonthDay !== undefined;
  if (hasMonth !== hasMonthDay) {
    throw new RecurrenceValidationError(
      'Yearly recurrence requires both month and month-day anchors, or neither.',
    );
  }

  const month = segment.byMonth?.[0] ?? anchor.month;
  const monthDay = segment.byMonthDay?.[0] ?? anchor.day;
  if (month < 1 || month > 12 || monthDay < 1 || monthDay > 31) {
    throw new RecurrenceValidationError('Yearly recurrence anchors are out of range.');
  }

  const dates: string[] = [];
  let year = Math.max(anchor.year, wallDateParts(window.from).year);

  while (dates.length < window.maxOccurrences) {
    window.step();
    const date = clampWallDate(year, month, monthDay);
    if (date > window.to) break;
    if (date >= segment.effectiveFrom && date >= window.from) dates.push(date);
    year += 1;
  }

  return dates;
}
