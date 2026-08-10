import {
  addDays,
  addMinutes,
  addMonths,
  differenceInCalendarDays,
  differenceInCalendarMonths,
  differenceInCalendarWeeks,
  format,
  getDate,
  getDay,
  getMonth,
  getYear,
  lastDayOfMonth,
  parseISO,
  setDate,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { RecurrenceValidationError } from './error.js';

const WALL_DATE_FORMAT = 'yyyy-MM-dd';
const WALL_STAMP_FORMAT = "yyyy-MM-dd'T'HH:mm";
const ZONE_SEARCH_MINUTES = 180;

function asCalendarDate(value: string): Date {
  return parseISO(`${value}T12:00:00`);
}

export function addWallDays(value: string, amount: number): string {
  return format(addDays(asCalendarDate(value), amount), WALL_DATE_FORMAT);
}

export function addWallMonths(value: string, amount: number): string {
  return format(startOfMonth(addMonths(asCalendarDate(value), amount)), WALL_DATE_FORMAT);
}

export function differenceInWallDays(later: string, earlier: string): number {
  return differenceInCalendarDays(asCalendarDate(later), asCalendarDate(earlier));
}

export function differenceInWallMonths(later: string, earlier: string): number {
  return differenceInCalendarMonths(
    startOfMonth(asCalendarDate(later)),
    startOfMonth(asCalendarDate(earlier)),
  );
}

export function differenceInWallWeeks(later: string, earlier: string): number {
  return differenceInCalendarWeeks(asCalendarDate(later), asCalendarDate(earlier), {
    weekStartsOn: 0,
  });
}

export function startOfWallWeek(value: string): string {
  return format(
    startOfWeek(asCalendarDate(value), { weekStartsOn: 0 }),
    WALL_DATE_FORMAT,
  );
}

export function wallDateParts(value: string): {
  year: number;
  month: number;
  day: number;
  weekday: number;
} {
  const date = asCalendarDate(value);
  return {
    year: getYear(date),
    month: getMonth(date) + 1,
    day: getDate(date),
    weekday: getDay(date),
  };
}

export function clampWallDate(year: number, month: number, day: number): string {
  const first = asCalendarDate(`${year}-${String(month).padStart(2, '0')}-01`);
  const clampedDay = Math.min(day, getDate(lastDayOfMonth(first)));
  return format(setDate(first, clampedDay), WALL_DATE_FORMAT);
}

/**
 * Converts one wall-clock occurrence to an instant.
 *
 * `date-fns-tz` already chooses the earlier instant for a repeated time. For a missing
 * spring-forward time it can resolve to the wall time before the gap, so the bounded search
 * below finds either the earliest exact instant or the first valid wall minute after it.
 */
export function toUtcInstant(date: string, time: string, timezone: string): string {
  const target = `${date}T${time}`;
  const candidate = fromZonedTime(`${target}:00`, timezone);
  let firstAfter: { instant: Date; wall: string } | undefined;

  for (let offset = -ZONE_SEARCH_MINUTES; offset <= ZONE_SEARCH_MINUTES; offset += 1) {
    const instant = addMinutes(candidate, offset);
    const wall = formatInTimeZone(instant, timezone, WALL_STAMP_FORMAT);

    if (wall === target) return instant.toISOString();
    if (wall > target && (firstAfter === undefined || wall < firstAfter.wall)) {
      firstAfter = { instant, wall };
    }
  }

  if (firstAfter !== undefined) return firstAfter.instant.toISOString();
  throw new RecurrenceValidationError(
    `Could not resolve ${target} in timezone ${timezone}.`,
  );
}
