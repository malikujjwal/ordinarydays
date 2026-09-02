import type { PlansDateStore } from '@od/shared/client';
import type { WallDate } from '@od/shared/time';
import type { AgendaItem } from '@od/shared/types';
import { format, getYear, parseISO } from 'date-fns';
import {
  type OccupiedDay,
  sectionsFromOccupiedDays,
  type UpcomingMonthSection,
} from './plansWindow';

/**
 * The three-stage Plans projections (P3-36, `plans-and-lists.md` §1.3).
 *
 * Pure functions over the shared `/v1/plans` date store. Nothing here re-sorts a stage the
 * server ordered — `needsDate` renders exactly as it arrived (§1.3's "Ordering is the
 * server's"), and the dated stages sort only by **date**, which is the response's own axis.
 */

/** The date slot of a needs-a-date card (`design-system.md` §7.3). */
export function needsDateLine(suggestionCount: number): string {
  if (suggestionCount <= 0) return 'No date yet';
  return `No date yet — ${suggestionCount} ${suggestionCount === 1 ? 'suggestion' : 'suggestions'}`;
}

/**
 * Upcoming: the covered dates ascending, with interior gap lines and month headers — the
 * same section grammar the agenda-backed view used, from the store instead.
 *
 * Only dates inside `[from, through]` render: the store may hold Past dates too, and a date
 * outside the exhausted window has no business claiming a gap line beside it.
 */
export function upcomingSectionsFromStore(
  store: PlansDateStore,
  from: WallDate,
  through: WallDate,
): UpcomingMonthSection[] {
  const occupied: OccupiedDay[] = [...store.byDate.entries()]
    .filter(([date, items]) => date >= from && date <= through && items.length > 0)
    // The wire item parses optionals as `T | undefined`; the domain expresses them as
    // absence — the same boundary cast every store reader makes.
    .map(([date, items]) => ({ date, items: [...items] as AgendaItem[] }))
    .sort((left, right) => left.date.localeCompare(right.date));
  return sectionsFromOccupiedDays(occupied);
}

export interface PastDay {
  readonly date: WallDate;
  readonly label: string;
  readonly items: AgendaItem[];
}

export interface PastMonthSection {
  readonly month: string;
  readonly title: string;
  readonly data: PastDay[];
}

/** `Wed 12 Aug` — the muted day heading Past draws (§7.3's day-card grammar); the calendar's cell label too. */
export const pastDayHeading = (date: WallDate): string =>
  format(parseISO(`${date}T12:00:00`), 'EEE d MMM');

/** `August` within the current year, `August 2025` beyond it — the sticky month header. */
function pastMonthTitle(date: WallDate, today: WallDate): string {
  const parsed = parseISO(`${date}T12:00:00`);
  const todayDate = parseISO(`${today}T12:00:00`);
  return format(parsed, getYear(parsed) === getYear(todayDate) ? 'MMMM' : 'MMMM yyyy');
}

/**
 * Past: strictly-before-today dates descending, grouped under month headings. No gap lines —
 * a record has no "nothing planned" to promise — and no re-sort within a date beyond what
 * the response carried.
 */
export function pastSectionsFromStore(
  store: PlansDateStore,
  today: WallDate,
): PastMonthSection[] {
  const days: PastDay[] = [...store.byDate.entries()]
    .filter(([date, items]) => date < today && items.length > 0)
    .sort((left, right) => right[0].localeCompare(left[0]))
    .map(([date, items]) => ({
      date,
      label: pastDayHeading(date),
      items: [...items] as AgendaItem[],
    }));

  const sections: PastMonthSection[] = [];
  for (const day of days) {
    const month = format(parseISO(`${day.date}T12:00:00`), 'yyyy-MM');
    const current = sections.at(-1);
    if (current?.month === month) {
      current.data.push(day);
    } else {
      sections.push({ month, title: pastMonthTitle(day.date, today), data: [day] });
    }
  }
  return sections;
}
