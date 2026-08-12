import {
  recurrence as recurrenceSchema,
  recurrenceSegment as recurrenceSegmentSchema,
} from '@od/shared/schemas';
import type { Recurrence, RecurrenceSegment, Weekday } from '@od/shared/types';
import { getDate, getDay, getMonth, parseISO } from 'date-fns';

export type RepeatOption =
  | 'never'
  | 'daily'
  | 'weekdays'
  | 'weekends'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'semiannual'
  | 'yearly'
  | 'custom';

export type RepeatEnds =
  | { kind: 'never' }
  | { kind: 'date'; date: string }
  | { kind: 'count'; count: number };

export const repeatOptions: readonly { value: RepeatOption; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekends', label: 'Weekends' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Biweekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Every 3 Months' },
  { value: 'semiannual', label: 'Every 6 Months' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'custom', label: 'Custom' },
] as const;

export interface BuildRepeatValueInput {
  option: Exclude<RepeatOption, 'never'>;
  anchorDate: string;
  customDays: number;
  ends: RepeatEnds;
  current?: Recurrence;
}

function segmentForInput(input: BuildRepeatValueInput): RecurrenceSegment {
  const active = input.current?.segments.at(-1);
  const preservesActiveRule =
    active !== undefined &&
    optionForSegment(active) === input.option &&
    (input.option !== 'custom' || active.interval === input.customDays);
  return preservesActiveRule
    ? active
    : segmentForOption(input.option, input.anchorDate, input.customDays, active);
}

function seriesLevel(ends: RepeatEnds) {
  return {
    ...(ends.kind === 'date' ? { endDate: ends.date } : {}),
    ...(ends.kind === 'count' ? { count: ends.count } : {}),
  };
}

function anchorParts(anchorDate: string) {
  const parsed = parseISO(anchorDate);
  return {
    weekday: getDay(parsed) as Weekday,
    month: (getMonth(parsed) + 1) as NonNullable<RecurrenceSegment['byMonth']>[number],
    monthDay: getDate(parsed),
  };
}

/** Exact Phase 2 rule shape, including every explicit anchor the client owns. */
export function segmentForOption(
  option: Exclude<RepeatOption, 'never'>,
  anchorDate: string,
  customDays: number,
  snapshot?: Pick<RecurrenceSegment, 'time' | 'endTime'>,
): RecurrenceSegment {
  const anchor = anchorParts(anchorDate);
  const common = {
    effectiveFrom: anchorDate,
    ...(snapshot?.time === undefined ? {} : { time: snapshot.time }),
    ...(snapshot?.endTime === undefined ? {} : { endTime: snapshot.endTime }),
  };

  switch (option) {
    case 'daily':
      return { ...common, freq: 'daily', interval: 1 };
    case 'weekdays':
      return { ...common, freq: 'weekdays' };
    case 'weekends':
      return { ...common, freq: 'weekly', interval: 1, byWeekday: [0, 6] };
    case 'weekly':
      return { ...common, freq: 'weekly', interval: 1, byWeekday: [anchor.weekday] };
    case 'biweekly':
      return { ...common, freq: 'weekly', interval: 2, byWeekday: [anchor.weekday] };
    case 'monthly':
      return { ...common, freq: 'monthly', byMonthDay: [anchor.monthDay] };
    case 'quarterly':
      return { ...common, freq: 'monthly', interval: 3, byMonthDay: [anchor.monthDay] };
    case 'semiannual':
      return { ...common, freq: 'monthly', interval: 6, byMonthDay: [anchor.monthDay] };
    case 'yearly':
      return {
        ...common,
        freq: 'yearly',
        byMonth: [anchor.month],
        byMonthDay: [anchor.monthDay],
      };
    case 'custom':
      return { ...common, freq: 'interval_days', interval: customDays };
  }
}

function ruleFields(
  segment: RecurrenceSegment,
): Omit<RecurrenceSegment, 'effectiveFrom'> {
  const { effectiveFrom: _effectiveFrom, ...rule } = segment;
  if (
    (segment.freq === 'daily' || segment.freq === 'weekly') &&
    segment.interval === undefined
  ) {
    return { ...rule, interval: 1 };
  }
  return rule;
}

function sameRule(a: RecurrenceSegment, b: RecurrenceSegment): boolean {
  return JSON.stringify(ruleFields(a)) === JSON.stringify(ruleFields(b));
}

function isSameDayCorrection(active: RecurrenceSegment, anchorDate: string): boolean {
  return active.effectiveFrom === anchorDate;
}

/**
 * Builds the complete request value and validates it with the server's own Zod schema.
 * Existing history is byte-identical. A changed rule replaces an untouched same-day active
 * segment; otherwise it appends one placeholder segment whose `effectiveFrom` the server owns.
 */
export function buildRepeatValue(input: BuildRepeatValueInput): Recurrence {
  const active = input.current?.segments.at(-1);
  const next = segmentForInput(input);
  const segments =
    input.current === undefined
      ? [next]
      : active !== undefined && sameRule(active, next)
        ? input.current.segments
        : active !== undefined && isSameDayCorrection(active, input.anchorDate)
          ? [...input.current.segments.slice(0, -1), next]
          : [...input.current.segments, next];

  return recurrenceSchema.parse({
    mode: 'fixed',
    segments,
    ...seriesLevel(input.ends),
  });
}

/**
 * Constructs only the deliberate 21st-segment request. Its new segment and series fields are
 * schema-validated independently; the complete value is intentionally left for the server's
 * max-segment validation so the component can map that real `validation_failed` response.
 */
export function buildRepeatLimitAttempt(
  input: BuildRepeatValueInput,
): Recurrence | undefined {
  const current = input.current;
  const active = current?.segments.at(-1);
  if (current === undefined || active === undefined || current.segments.length < 20) {
    return undefined;
  }
  const next = segmentForInput(input);
  if (sameRule(active, next)) return undefined;

  const validatedSegment = recurrenceSegmentSchema.parse(next);
  const first = current.segments[0];
  if (first === undefined) return undefined;
  const validatedSeriesLevel = recurrenceSchema.parse({
    mode: 'fixed',
    segments: [first],
    ...seriesLevel(input.ends),
  });
  return {
    mode: 'fixed',
    segments: [...current.segments, validatedSegment],
    ...(validatedSeriesLevel.endDate === undefined
      ? {}
      : { endDate: validatedSeriesLevel.endDate }),
    ...(validatedSeriesLevel.count === undefined
      ? {}
      : { count: validatedSeriesLevel.count }),
  };
}

export function optionForSegment(
  segment: RecurrenceSegment,
): Exclude<RepeatOption, 'never'> {
  if (segment.freq === 'weekly') {
    const weekdays = [...(segment.byWeekday ?? [])].sort();
    if (segment.interval === 1 && weekdays.join(',') === '0,6') return 'weekends';
    if (segment.interval === 2 && weekdays.length === 1) return 'biweekly';
    return 'weekly';
  }
  if (segment.freq === 'monthly') {
    if (segment.interval === 3) return 'quarterly';
    if (segment.interval === 6) return 'semiannual';
    return 'monthly';
  }
  if (segment.freq === 'interval_days' || segment.freq === 'custom') return 'custom';
  return segment.freq;
}

export function endsForRecurrence(recurrence: Recurrence | undefined): RepeatEnds {
  if (recurrence?.endDate !== undefined)
    return { kind: 'date', date: recurrence.endDate };
  if (recurrence?.count !== undefined) return { kind: 'count', count: recurrence.count };
  return { kind: 'never' };
}

/** Ends a series without consulting transient editor state or appending a rule segment. */
export function endRepeatSeries(recurrence: Recurrence, endDate: string): Recurrence {
  return recurrenceSchema.parse({
    mode: recurrence.mode,
    segments: recurrence.segments,
    endDate,
  });
}
