import type { RecurrenceSegment } from '../../types/recurrence.js';
import {
  addWallMonths,
  clampWallDate,
  differenceInWallMonths,
  wallDateParts,
} from '../calendar.js';
import { RecurrenceValidationError } from '../error.js';
import type { RuleWindow } from './shared.js';

export function expandMonthly(segment: RecurrenceSegment, window: RuleWindow): string[] {
  const anchor = wallDateParts(segment.effectiveFrom);
  const monthDay = segment.byMonthDay?.[0] ?? anchor.day;
  if (monthDay < 1 || monthDay > 31) {
    throw new RecurrenceValidationError('Monthly recurrence day must be from 1 to 31.');
  }

  let monthOffset = Math.max(
    0,
    differenceInWallMonths(window.from, segment.effectiveFrom),
  );
  let monthStart = addWallMonths(segment.effectiveFrom, monthOffset);
  const dates: string[] = [];

  while (monthStart <= window.to && dates.length < window.maxOccurrences) {
    window.step();
    const { year, month } = wallDateParts(monthStart);
    const date = clampWallDate(year, month, monthDay);
    if (date < window.from) {
      monthOffset += 1;
      monthStart = addWallMonths(segment.effectiveFrom, monthOffset);
      continue;
    }
    if (date >= segment.effectiveFrom && date <= window.to) dates.push(date);
    monthOffset += 1;
    monthStart = addWallMonths(segment.effectiveFrom, monthOffset);
  }

  return dates;
}
