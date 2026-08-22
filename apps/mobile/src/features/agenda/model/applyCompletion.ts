import type { AgendaData, AgendaDay, AgendaItem } from '@od/shared/types';

export interface AgendaMutationTarget {
  activityId: string;
  occurrenceDate?: string;
}

export interface AgendaProjectionClock {
  today: string;
  currentMinute: string;
}

export type CompletionProjectionVariables = AgendaMutationTarget &
  AgendaProjectionClock &
  ({ completed: true } | { completed: false; restoredStatus: 'saved' | 'scheduled' });

type SectionName = 'schedule' | 'anytime' | 'earlier';

const RESOLVED = new Set<AgendaItem['status']>([
  'completed',
  'completed_occurrence',
  'skipped',
  'skipped_occurrence',
]);

const sameTarget = (item: AgendaItem, target: AgendaMutationTarget): boolean =>
  item.activityId === target.activityId && item.occurrenceDate === target.occurrenceDate;

const identity = (item: AgendaItem): string =>
  `${item.activityId}\u0000${item.occurrenceDate ?? ''}`;

const compareSchedule = (left: AgendaItem, right: AgendaItem): number =>
  (left.time ?? '').localeCompare(right.time ?? '') ||
  identity(left).localeCompare(identity(right));

const anytimeGroup = (item: AgendaItem): number => {
  if (item.overdueFromDate !== undefined) return 0;
  return item.status === 'saved' ? 2 : 1;
};

const compareAnytime = (left: AgendaItem, right: AgendaItem): number => {
  const group = anytimeGroup(left) - anytimeGroup(right);
  if (group !== 0) return group;
  if (anytimeGroup(left) === 0) {
    return (
      (left.overdueFromDate ?? '').localeCompare(right.overdueFromDate ?? '') ||
      identity(left).localeCompare(identity(right))
    );
  }
  return anytimeGroup(left) === 2
    ? identity(right).localeCompare(identity(left))
    : identity(left).localeCompare(identity(right));
};

const compareEarlier = (left: AgendaItem, right: AgendaItem): number =>
  (right.time ?? '').localeCompare(left.time ?? '') ||
  identity(right).localeCompare(identity(left));

function sectionFor(
  item: AgendaItem,
  day: string,
  clock: AgendaProjectionClock,
): SectionName {
  if (day === clock.today) {
    if (RESOLVED.has(item.status)) return 'earlier';
    if (item.time !== undefined && (item.endTime ?? item.time) < clock.currentMinute) {
      return 'earlier';
    }
  }
  return item.time === undefined ? 'anytime' : 'schedule';
}

export function uniqueItems(day: AgendaDay): AgendaItem[] {
  const seen = new Set<string>();
  return [...day.schedule, ...day.anytime, ...day.earlier].filter((item) => {
    const key = identity(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function projectDay(
  day: AgendaDay,
  items: readonly AgendaItem[],
  clock: AgendaProjectionClock,
): AgendaDay {
  const schedule: AgendaItem[] = [];
  const anytime: AgendaItem[] = [];
  const earlier: AgendaItem[] = [];
  for (const item of items) {
    const section = sectionFor(item, day.date, clock);
    if (section === 'schedule') schedule.push(item);
    else if (section === 'anytime') anytime.push(item);
    else earlier.push(item);
  }
  schedule.sort(compareSchedule);
  anytime.sort(compareAnytime);
  earlier.sort(compareEarlier);
  const upNext = schedule.find((item) => !RESOLVED.has(item.status));
  return {
    date: day.date,
    ...(upNext === undefined ? {} : { upNext }),
    schedule,
    anytime,
    earlier,
  };
}

export interface AgendaItemProjection {
  item: AgendaItem;
  sourceDate: string;
}

export function findAgendaItem(
  agenda: AgendaData,
  target: AgendaMutationTarget,
): AgendaItemProjection | undefined {
  for (const day of agenda.days) {
    const item = uniqueItems(day).find((candidate) => sameTarget(candidate, target));
    if (item !== undefined) return { item, sourceDate: day.date };
  }
  return undefined;
}

export function replaceAgendaItem(
  agenda: AgendaData,
  target: AgendaMutationTarget,
  next: AgendaItem | undefined,
  destinationDate: string,
  clock: AgendaProjectionClock,
  materializeMissingDestination = false,
): AgendaData {
  const destinationExists = agenda.days.some((day) => day.date === destinationDate);
  const days = agenda.days.map((day) => {
    const items = uniqueItems(day).filter((item) => !sameTarget(item, target));
    if (next !== undefined && day.date === destinationDate) items.unshift(next);
    return projectDay(day, items, clock);
  });
  if (next !== undefined && !destinationExists && materializeMissingDestination) {
    days.push(
      projectDay(
        { date: destinationDate, schedule: [], anytime: [], earlier: [] },
        [next],
        clock,
      ),
    );
    days.sort((left, right) => left.date.localeCompare(right.date));
  }
  return {
    ...agenda,
    days,
  };
}

/** Projects task/occurrence completion and its compensating uncomplete operation. */
export function applyCompletion(
  agenda: AgendaData,
  variables: CompletionProjectionVariables,
): AgendaData {
  const found = findAgendaItem(agenda, variables);
  if (found === undefined) return agenda;

  const status: AgendaItem['status'] = variables.completed
    ? variables.occurrenceDate === undefined
      ? 'completed'
      : 'completed_occurrence'
    : variables.restoredStatus;
  const next = { ...found.item, status };

  return replaceAgendaItem(agenda, variables, next, found.sourceDate, variables);
}
