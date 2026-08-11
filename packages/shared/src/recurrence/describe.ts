import { assertNever } from '../types/assert.js';
import type { Recurrence, RecurrenceSegment, Weekday } from '../types/recurrence.js';
import { wallDateParts } from './calendar.js';
import { RecurrenceValidationError } from './error.js';

const WEEKDAY_NAMES: Record<Weekday, string> = {
  0: 'Sunday',
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
};

const MONDAY_FIRST_ORDER: Record<Weekday, number> = {
  0: 7,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
};

const MONTH_NAMES = [
  undefined,
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function monthName(month: number): string {
  const name = MONTH_NAMES[month];
  if (name === undefined) {
    throw new RecurrenceValidationError('Month must be from 1 to 12.');
  }
  return name;
}

function ordinal(value: number): string {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

function joinEnglish(first: string, rest: string[]): string {
  if (rest.length === 0) return first;
  return rest.reduce(
    (label, value, index) =>
      index === rest.length - 1 ? `${label} and ${value}` : `${label}, ${value}`,
    first,
  );
}

function weeklyLabel(segment: RecurrenceSegment): string {
  const weekdays = [...new Set(segment.byWeekday ?? [])].sort(
    (a, b) => MONDAY_FIRST_ORDER[a] - MONDAY_FIRST_ORDER[b],
  );
  const interval = segment.interval ?? 1;
  if (interval < 1) {
    throw new RecurrenceValidationError('Weekly recurrence interval must be positive.');
  }
  const [firstWeekday, ...otherWeekdays] = weekdays;
  if (firstWeekday === undefined) {
    throw new RecurrenceValidationError(
      'Weekly recurrence requires at least one weekday.',
    );
  }
  const days = joinEnglish(
    WEEKDAY_NAMES[firstWeekday],
    otherWeekdays.map((weekday) => WEEKDAY_NAMES[weekday]),
  );
  return interval === 1 ? `Weekly on ${days}` : `Every ${interval} weeks on ${days}`;
}

function monthlyLabel(segment: RecurrenceSegment): string {
  const monthDay = segment.byMonthDay?.[0] ?? wallDateParts(segment.effectiveFrom).day;
  return `Monthly on the ${ordinal(monthDay)}`;
}

function yearlyLabel(segment: RecurrenceSegment): string {
  const hasMonth = segment.byMonth !== undefined;
  const hasMonthDay = segment.byMonthDay !== undefined;
  if (hasMonth !== hasMonthDay) {
    throw new RecurrenceValidationError(
      'Yearly recurrence requires both month and month-day anchors, or neither.',
    );
  }
  const anchor = wallDateParts(segment.effectiveFrom);
  const month = segment.byMonth?.[0] ?? anchor.month;
  const monthDay = segment.byMonthDay?.[0] ?? anchor.day;
  return `Every year on ${monthDay} ${monthName(month)}`;
}

function intervalDaysLabel(segment: RecurrenceSegment): string {
  const interval = segment.interval;
  if (interval === undefined || interval < 2 || interval > 365) {
    throw new RecurrenceValidationError(
      'Every-X-days recurrence requires an interval from 2 to 365.',
    );
  }
  return `Every ${interval} days`;
}

function ruleLabel(segment: RecurrenceSegment): string {
  switch (segment.freq) {
    case 'daily':
      return 'Daily';
    case 'weekdays':
      return 'Every weekday';
    case 'weekly':
      return weeklyLabel(segment);
    case 'monthly':
      return monthlyLabel(segment);
    case 'yearly':
      return yearlyLabel(segment);
    case 'interval_days':
      return intervalDaysLabel(segment);
    case 'custom':
      throw new RecurrenceValidationError(
        'Custom recurrence is not available until Phase 9.',
      );
    default:
      return assertNever(
        segment.freq,
        'RecurrenceFreq',
        () => new RecurrenceValidationError('Unsupported recurrence frequency.'),
      );
  }
}

function withEnds(label: string, rec: Recurrence, today: string): string {
  if (rec.endDate !== undefined) {
    const end = wallDateParts(rec.endDate);
    const todayYear = wallDateParts(today).year;
    const month = monthName(end.month).slice(0, 3);
    const year = end.year === todayYear ? '' : ` ${end.year}`;
    return `${label} until ${end.day} ${month}${year}`;
  }
  if (rec.count !== undefined) {
    return `${label}, ${rec.count} ${rec.count === 1 ? 'time' : 'times'}`;
  }
  return label;
}

/** Returns the product label for the active (last) rule segment and series-level Ends. */
export function describeRecurrence(rec: Recurrence, today: string): string {
  if (rec.mode !== 'fixed') {
    throw new RecurrenceValidationError(
      'Completion-relative recurrence is not available until Phase 9.',
    );
  }
  const active = rec.segments.at(-1);
  if (active === undefined) {
    throw new RecurrenceValidationError('Recurrence requires at least one segment.');
  }
  return withEnds(ruleLabel(active), rec, today);
}
