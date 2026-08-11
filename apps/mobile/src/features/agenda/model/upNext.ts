import { type Clock, type TimeZone, toWallTime, type WallTime } from '@od/shared/time';
import type { AgendaItem } from '@od/shared/types';

const RESOLVED = new Set<AgendaItem['status']>([
  'cancelled',
  'completed',
  'completed_occurrence',
  'skipped',
  'skipped_occurrence',
]);

const compareIdentity = (left: AgendaItem, right: AgendaItem): number =>
  left.activityId.localeCompare(right.activityId) ||
  (left.occurrenceDate ?? '').localeCompare(right.occurrenceDate ?? '');

const compareSchedule = (left: AgendaItem, right: AgendaItem): number =>
  (left.time ?? '').localeCompare(right.time ?? '') || compareIdentity(left, right);

export interface UpNextSelection {
  item: AgendaItem;
  time: WallTime;
  relativeTime: string;
}

function minuteNumber(time: WallTime): number {
  const [hours = '0', minutes = '0'] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

function relativeTime(start: WallTime, current: WallTime): string {
  const minutes = Math.max(0, minuteNumber(start) - minuteNumber(current));
  if (minutes === 0) return 'now';
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(minutes / 60);
  return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** The next unresolved timed row at an already-derived local wall-clock minute. */
export function selectUpNextAtMinute(
  items: readonly AgendaItem[],
  currentMinute: WallTime,
): AgendaItem | undefined {
  return [...items]
    .filter(
      (candidate) =>
        candidate.time !== undefined &&
        candidate.time >= currentMinute &&
        candidate.overdueFromDate === undefined &&
        !RESOLVED.has(candidate.status),
    )
    .sort(compareSchedule)[0];
}

/** The next unresolved timed row, using exactly one injected clock reading. */
export function selectUpNext(
  items: readonly AgendaItem[],
  clock: Clock,
  timezone: TimeZone,
): UpNextSelection | undefined {
  const currentMinute = toWallTime(clock.now(), timezone);
  const item = selectUpNextAtMinute(items, currentMinute);

  return item === undefined ? undefined : toUpNextSelectionAtMinute(item, currentMinute);
}

function toUpNextSelectionAtMinute(
  item: AgendaItem,
  currentMinute: WallTime,
): UpNextSelection | undefined {
  if (item.time === undefined) return undefined;
  return {
    item,
    time: item.time as WallTime,
    relativeTime: relativeTime(item.time as WallTime, currentMinute),
  };
}

/** Formats the server-authored initial UP NEXT row against the same injected clock. */
export function toUpNextSelection(
  item: AgendaItem,
  clock: Clock,
  timezone: TimeZone,
): UpNextSelection | undefined {
  return toUpNextSelectionAtMinute(item, toWallTime(clock.now(), timezone));
}
