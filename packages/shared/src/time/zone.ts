import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import type { Instant, TimeZone, WallDate, WallTime } from './types.js';

/** Converts one wall-clock date and time to its absolute instant. */
export function toInstant(date: WallDate, time: WallTime, timezone: TimeZone): Instant {
  return fromZonedTime(`${date}T${time}:00`, timezone).toISOString() as Instant;
}

/** Reads the calendar date of an instant in a named timezone. */
export function toWallDate(instant: Instant, timezone: TimeZone): WallDate {
  return formatInTimeZone(instant, timezone, 'yyyy-MM-dd') as WallDate;
}

/** Reads the minute of an instant in a named timezone. */
export function toWallTime(instant: Instant, timezone: TimeZone): WallTime {
  return formatInTimeZone(instant, timezone, 'HH:mm') as WallTime;
}
