import type { AgendaItem } from '@od/shared/types';

/** The four fixed Today sections. UP NEXT deliberately duplicates the first schedule row. */
export interface TodaySections {
  upNext: AgendaItem[];
  schedule: AgendaItem[];
  anytime: AgendaItem[];
  earlier: AgendaItem[];
}

const COMPLETED = new Set<AgendaItem['status']>(['completed', 'completed_occurrence']);

const HIDDEN = new Set<AgendaItem['status']>([
  'cancelled',
  'skipped',
  'skipped_occurrence',
]);

const compareIdentity = (left: AgendaItem, right: AgendaItem): number =>
  left.activityId.localeCompare(right.activityId) ||
  (left.occurrenceDate ?? '').localeCompare(right.occurrenceDate ?? '');

const compareSchedule = (left: AgendaItem, right: AgendaItem): number =>
  (left.time ?? '').localeCompare(right.time ?? '') || compareIdentity(left, right);

const anytimeGroup = (item: AgendaItem): number => {
  if (item.overdueFromDate !== undefined) return 0;
  return item.status === 'saved' ? 2 : 1;
};

const compareAnytime = (left: AgendaItem, right: AgendaItem): number => {
  const leftGroup = anytimeGroup(left);
  const rightGroup = anytimeGroup(right);
  if (leftGroup !== rightGroup) return leftGroup - rightGroup;
  if (leftGroup === 0) {
    return (
      (left.overdueFromDate ?? '').localeCompare(right.overdueFromDate ?? '') ||
      compareIdentity(left, right)
    );
  }
  if (leftGroup === 1) return compareIdentity(left, right);

  // AgendaItem intentionally omits createdAt. Activity ids are ULIDs, so descending id is
  // the client-visible equivalent of §3.1's createdAt-descending server order.
  return -compareIdentity(left, right);
};

const compareEarlier = (
  left: { item: AgendaItem; sourceIndex: number },
  right: { item: AgendaItem; sourceIndex: number },
): number => {
  const leftTime = left.item.time;
  const rightTime = right.item.time;
  if (leftTime !== undefined || rightTime !== undefined) {
    return (
      (rightTime ?? '').localeCompare(leftTime ?? '') ||
      -compareIdentity(left.item, right.item)
    );
  }

  // completedAt is not part of AgendaItem. The server already ordered untimed completions
  // by that instant, so retaining their input order preserves the canonical initial paint.
  return left.sourceIndex - right.sourceIndex;
};

/**
 * Re-partitions the server projection from one local clock reading, with no I/O and no domain
 * classification. In particular this file never tries to identify Plans: P2-08 excludes the
 * `#P` bucket before an AgendaItem exists.
 */
export function partitionAgenda(
  items: readonly AgendaItem[],
  currentMinute: string,
): TodaySections {
  const visible = items
    .map((item, sourceIndex) => ({ item, sourceIndex }))
    .filter(({ item }) => !HIDDEN.has(item.status));

  const schedule = visible
    .filter(
      ({ item }) =>
        !COMPLETED.has(item.status) &&
        item.time !== undefined &&
        (item.endTime ?? item.time) >= currentMinute,
    )
    .map(({ item }) => item)
    .sort(compareSchedule);

  const anytime = visible
    .filter(({ item }) => !COMPLETED.has(item.status) && item.time === undefined)
    .map(({ item }) => item)
    .sort(compareAnytime);

  const earlier = visible
    .filter(
      ({ item }) =>
        COMPLETED.has(item.status) ||
        (item.time !== undefined && (item.endTime ?? item.time) < currentMinute),
    )
    .sort(compareEarlier)
    .map(({ item }) => item);

  return {
    upNext: schedule.slice(0, 1),
    schedule,
    anytime,
    earlier,
  };
}

/** Flattens one server day while removing its deliberate UP NEXT duplicate. */
export function agendaItemsForDay(day: {
  schedule: readonly AgendaItem[];
  anytime: readonly AgendaItem[];
  earlier: readonly AgendaItem[];
}): AgendaItem[] {
  return [...day.schedule, ...day.anytime, ...day.earlier];
}
