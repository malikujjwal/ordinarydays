import type { WallTime } from '@od/shared/time';
import type { AgendaItem } from '@od/shared/types';
import { selectUpNextAtMinute } from './upNext';

/** The four fixed Today sections. UP NEXT deliberately duplicates the first schedule row. */
export interface TodaySections {
  upNext: AgendaItem[];
  schedule: AgendaItem[];
  anytime: AgendaItem[];
  earlier: AgendaItem[];
}

const COMPLETED = new Set<AgendaItem['status']>(['completed', 'completed_occurrence']);

const SKIPPED = new Set<AgendaItem['status']>(['skipped', 'skipped_occurrence']);

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

/**
 * EARLIER TODAY sorts **ascending**, oldest first — founder decision, 2026-08-17.
 *
 * It sorted descending while the section rendered last, and `today-and-tasks.md` §2.4 gave the
 * reason: "the two sections point in opposite directions from 'now', which is what makes the
 * screen readable as a timeline centred on the present moment." That reasoning was sound for a
 * section **below** SCHEDULE. The founder has moved EARLIER TODAY **above** it, with the NOW
 * divider between the two, and under that order the same goal inverts the sort: reading down the
 * screen must run 9:00 AM → 11:00 AM → NOW → 2:30 PM, so the past ascends into the present
 * instead of retreating from it.
 *
 * §2.4 is amended in the same pull request; this comment is not the rule, it is why the rule
 * changed.
 */
const compareEarlier = (
  left: { item: AgendaItem; sourceIndex: number },
  right: { item: AgendaItem; sourceIndex: number },
): number => {
  const leftTime = left.item.time;
  const rightTime = right.item.time;
  if (leftTime !== undefined || rightTime !== undefined) {
    return (
      (leftTime ?? '').localeCompare(rightTime ?? '') ||
      compareIdentity(left.item, right.item)
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
  showSkipped = false,
): TodaySections {
  const visible = items
    .map((item, sourceIndex) => {
      if (item.time === undefined) return { item, sourceIndex };
      const isPast = (item.endTime ?? item.time) < currentMinute;
      return {
        item: item.isPast === isPast ? item : { ...item, isPast },
        sourceIndex,
      };
    })
    .filter(
      ({ item }) =>
        item.status !== 'cancelled' && (showSkipped || !SKIPPED.has(item.status)),
    );

  /**
   * **A completed row keeps its slot until its time passes** — founder decision, 2026-08-17.
   *
   * With EARLIER TODAY moved above SCHEDULE, relocating on completion threw the row *upward*
   * across the NOW divider — a task you finished early jumped backwards past "now", which reads
   * as the screen rewriting the day rather than recording it. It now stays where it is, struck
   * and dimmed, and joins EARLIER TODAY when the clock reaches it like everything else.
   *
   * An **untimed** item is the stated exception, and has to be: it has no slot to stay in, so
   * completing it moves it out of ANYTIME immediately — which is `today-and-tasks.md` §2.3's
   * existing rule and the reason §2.4 admits untimed completions at all.
   */
  const schedule = visible
    .filter(
      ({ item }) =>
        !SKIPPED.has(item.status) &&
        item.time !== undefined &&
        (item.endTime ?? item.time) >= currentMinute,
    )
    .map(({ item }) => item)
    .sort(compareSchedule);

  const anytime = visible
    .filter(
      ({ item }) =>
        !COMPLETED.has(item.status) &&
        !SKIPPED.has(item.status) &&
        item.time === undefined,
    )
    .map(({ item }) => item)
    .sort(compareAnytime);

  const earlier = visible
    .filter(
      ({ item }) =>
        // Its time has passed — completed or not; the section is "what is behind you".
        (item.time !== undefined && (item.endTime ?? item.time) < currentMinute) ||
        // Or it never had a time and is resolved, so ANYTIME can no longer hold it (§2.3).
        (item.time === undefined &&
          (COMPLETED.has(item.status) || SKIPPED.has(item.status))) ||
        // A skipped timed row stays revealed where `Show skipped` put it.
        (SKIPPED.has(item.status) && item.time !== undefined),
    )
    .sort(compareEarlier)
    .map(({ item }) => item);
  const upNext = selectUpNextAtMinute(schedule, currentMinute as WallTime);

  return {
    upNext: upNext === undefined ? [] : [upNext],
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
