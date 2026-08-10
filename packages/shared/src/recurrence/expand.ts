import type { Recurrence, RecurrenceSegment } from '../types/recurrence.js';
import { addWallDays } from './calendar.js';
import { RecurrenceValidationError } from './error.js';
import { expandDaily } from './rules/daily.js';
import { expandIntervalDays } from './rules/intervalDays.js';
import { expandMonthly } from './rules/monthly.js';
import type { RuleWindow } from './rules/shared.js';
import { expandWeekdays } from './rules/weekdays.js';
import { expandWeekly } from './rules/weekly.js';
import { expandYearly } from './rules/yearly.js';

const MAX_EXPANSION_STEPS = 1_000;

function ruleDates(segment: RecurrenceSegment, window: RuleWindow): string[] {
  switch (segment.freq) {
    case 'daily':
      return expandDaily(segment, window);
    case 'weekdays':
      return expandWeekdays(segment, window);
    case 'weekly':
      return expandWeekly(segment, window);
    case 'monthly':
      return expandMonthly(segment, window);
    case 'yearly':
      return expandYearly(segment, window);
    case 'interval_days':
      return expandIntervalDays(segment, window);
    case 'custom':
      throw new RecurrenceValidationError(
        'Custom recurrence is not available until Phase 9.',
      );
    default:
      throw new RecurrenceValidationError('Unsupported recurrence frequency.');
  }
}

function orderedSegments(
  segments: RecurrenceSegment[],
): [RecurrenceSegment, ...RecurrenceSegment[]] {
  const [first, ...rest] = segments;
  if (first === undefined) {
    throw new RecurrenceValidationError('Recurrence requires at least one segment.');
  }
  let previous = first;
  for (const current of rest) {
    if (current.effectiveFrom <= previous.effectiveFrom) {
      throw new RecurrenceValidationError(
        'Recurrence segments must be ordered by effective date.',
      );
    }
    previous = current;
  }
  return [first, ...rest];
}

/** Expands one complete stored series into ascending, unique wall-clock dates. */
export function expandRecurrence(
  rec: Recurrence,
  from: string,
  to: string,
  tz: string,
): string[] {
  if (from > to) return [];
  if (rec.mode !== 'fixed') {
    throw new RecurrenceValidationError(
      'Completion-relative recurrence is not available until Phase 9.',
    );
  }
  const segments = orderedSegments(rec.segments);
  const firstSegment = segments[0];
  if (firstSegment.effectiveFrom > to) return [];
  if (rec.endDate !== undefined && rec.endDate < firstSegment.effectiveFrom) return [];
  if (rec.count !== undefined && rec.count < 1) return [];

  void tz;
  const seriesTo = rec.endDate === undefined || rec.endDate > to ? to : rec.endDate;
  const expansionFrom = rec.count === undefined ? from : firstSegment.effectiveFrom;
  const result = new Set<string>();
  let occurrenceCount = 0;
  let steps = 0;
  const step = (): void => {
    steps += 1;
    if (steps > MAX_EXPANSION_STEPS) {
      throw new RecurrenceValidationError('Recurrence expansion exceeded 1,000 steps.');
    }
  };

  for (const [index, segment] of segments.entries()) {
    if (rec.count !== undefined && occurrenceCount >= rec.count) break;
    const next = segments[index + 1];
    const segmentFrom =
      expansionFrom > segment.effectiveFrom ? expansionFrom : segment.effectiveFrom;
    const segmentEnd =
      next === undefined ? seriesTo : addWallDays(next.effectiveFrom, -1);
    const segmentTo = segmentEnd < seriesTo ? segmentEnd : seriesTo;
    if (segmentFrom > segmentTo) continue;

    const remaining =
      rec.count === undefined ? Number.POSITIVE_INFINITY : rec.count - occurrenceCount;
    const dates = ruleDates(segment, {
      from: segmentFrom,
      to: segmentTo,
      maxOccurrences: remaining,
      step,
    });
    occurrenceCount += dates.length;
    for (const date of dates) {
      if (date >= from) result.add(date);
    }
  }

  return [...result].sort();
}
