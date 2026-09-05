import { addWallDays, differenceInWallDays } from '@od/shared/recurrence';
import type { AgendaData, AgendaDay, AgendaItem } from '@od/shared/types';
import { format, parseISO } from 'date-fns';

export interface UpcomingDateGroup {
  kind: 'date';
  date: string;
  label: string;
  items: AgendaItem[];
}

export interface UpcomingGap {
  kind: 'gap';
  from: string;
  to: string;
  label: string;
}

export interface UpcomingUnloadedRange {
  kind: 'unloaded';
  from: string;
  to: string;
}

export type UpcomingListItem = UpcomingDateGroup | UpcomingGap | UpcomingUnloadedRange;

export interface UpcomingMonthSection {
  month: string;
  title: string;
  data: UpcomingListItem[];
}

const asDate = (date: string): Date => parseISO(`${date}T12:00:00`);

export const formatDateHeading = (date: string): string =>
  format(asDate(date), 'EEE, MMM d');

export const formatMonthHeading = (date: string): string =>
  format(asDate(date), 'MMMM yyyy');

function formatGap(from: string, to: string): string {
  if (from === to) return `${format(asDate(from), 'MMM d')} · nothing planned`;
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  return `${format(asDate(from), 'MMM d')} – ${format(asDate(to), sameMonth ? 'd' : 'MMM d')} · nothing planned`;
}

const itemIdentity = (item: AgendaItem): string =>
  `${item.activityId}:${item.occurrenceDate ?? ''}`;

function itemsForDay(day: AgendaDay): AgendaItem[] {
  const dated = [...day.schedule, ...day.anytime, ...day.earlier].filter(
    (item) => item.status !== 'saved' && item.overdueFromDate === undefined,
  );
  return [...new Map(dated.map((item) => [itemIdentity(item), item])).values()].sort(
    (left, right) =>
      (left.time ?? '').localeCompare(right.time ?? '') ||
      itemIdentity(left).localeCompare(itemIdentity(right)),
  );
}

/**
 * The shared shape of one occupied date, wherever its rows came from — the agenda window
 * (this file's original caller) or the `/v1/plans` date store (P3-36's `plansStages`).
 */
export interface OccupiedDay {
  readonly date: string;
  readonly items: AgendaItem[];
}

/**
 * Ascending occupied days → month sections with interior gap lines.
 *
 * Extracted from {@link buildUpcomingSections} when P3-36 gave it a second producer: the
 * grouping, the gap rule ("empty dates become one line only when bounded by populated
 * dates") and the month headers are presentation the two data sources must not drift apart
 * on.
 */
export function sectionsFromOccupiedDays(
  occupied: readonly OccupiedDay[],
): UpcomingMonthSection[] {
  const list: UpcomingListItem[] = [];
  for (const [index, day] of occupied.entries()) {
    const previous = occupied[index - 1];
    if (previous !== undefined && differenceInWallDays(day.date, previous.date) > 1) {
      const from = addWallDays(previous.date, 1);
      const to = addWallDays(day.date, -1);
      list.push({ kind: 'gap', from, to, label: formatGap(from, to) });
    }
    list.push({
      kind: 'date',
      date: day.date,
      label: formatDateHeading(day.date),
      items: day.items,
    });
  }

  const sections: UpcomingMonthSection[] = [];
  for (const item of list) {
    const anchor = item.kind === 'date' ? item.date : item.from;
    const month = anchor.slice(0, 7);
    const current = sections.at(-1);
    if (current?.month === month) {
      current.data.push(item);
    } else {
      sections.push({ month, title: formatMonthHeading(anchor), data: [item] });
    }
  }
  return sections;
}

/**
 * Builds Plans → Upcoming from the server's complete date window.
 *
 * Empty dates become one line only when they are bounded by populated dates. Native Agenda
 * deliberately materializes Today's wider visible superset, so Plans filters that shared
 * projection here. Every genuinely dated row remains visible even after Agenda moves it to
 * Earlier or resolves it; only undated Saved items and rolled-forward overdue copies are
 * Today-only. Duplicate identities collapse after the three buckets are merged.
 */
export function buildUpcomingSections(agenda: AgendaData): UpcomingMonthSection[] {
  const occupied = agenda.days
    .map((day) => ({ date: day.date, items: itemsForDay(day) }))
    .filter(({ items }) => items.length > 0)
    .sort((left, right) => left.date.localeCompare(right.date));

  return sectionsFromOccupiedDays(occupied);
}
