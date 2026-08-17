import type { AgendaItem } from '@od/shared/types';

/**
 * The day's completion figure — `2 of 6 done` (`design-system.md` §7.1, P2-44).
 *
 * **It counts everything on Today**, which is the four sections as rendered: SCHEDULE, ANYTIME
 * and EARLIER TODAY. UP NEXT is deliberately not added to that, because it is a duplicate render
 * of a row already in SCHEDULE (`today-and-tasks.md` §2.1) — counting it would make a six-row day
 * report seven.
 *
 * Pure, and given the items rather than reaching for them, so the zero/some/all cases are unit
 * tests rather than three screens to set up.
 */
export interface DayCount {
  done: number;
  total: number;
  /** `done / total`, and **0 at an empty day** rather than `NaN` (`ProgressBar` clamps too). */
  fraction: number;
}

const DONE = new Set<AgendaItem['status']>(['completed', 'completed_occurrence']);

/**
 * A skipped row is **not** done and **not** counted at all.
 *
 * `today-and-tasks.md` §5.4 is explicit that a skip is "deliberately not done, no guilt
 * attached". Counting one in the denominator would leave the bar permanently short of full on a
 * day the user had in fact finished with, which is the nag the whole screen is written against
 * (§8.3); counting it in the numerator would claim it happened.
 */
const NOT_COUNTED = new Set<AgendaItem['status']>([
  'skipped',
  'skipped_occurrence',
  'cancelled',
]);

export function dayCount(items: readonly AgendaItem[]): DayCount {
  const counted = items.filter((item) => !NOT_COUNTED.has(item.status));
  const done = counted.filter((item) => DONE.has(item.status)).length;
  const total = counted.length;

  return { done, total, fraction: total === 0 ? 0 : done / total };
}

/** The label, shown on the title's trailing edge and spoken as the bar's accessible name. */
export const dayCountLabel = ({ done, total }: DayCount): string =>
  `${done} of ${total} done`;
