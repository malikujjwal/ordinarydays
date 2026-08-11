import { expandRecurrence, toUtcInstant } from '@od/shared/recurrence';
import type { Activity, Occurrence, RecurrenceSegment, Reminder } from '@od/shared/types';
import { addDays, format, parseISO } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { logger } from '../lib/logger.js';
import {
  batchGetActivityMeta,
  listByBucket,
  listOverdueTaskCandidates,
  listParticipants,
} from '../repositories/activityRepository.js';
import type { StoredItem } from '../repositories/migrate.js';
import {
  batchGetAgendaRows,
  batchGetForPairs,
  type OccurrenceMoveMarker,
} from '../repositories/occurrenceRepository.js';
import { listForUser as listRemindersForUser } from '../repositories/reminderRepository.js';

const SERIES_LIMIT = 200;
const WALL_DATE = 'yyyy-MM-dd';
const WALL_TIME = 'HH:mm';
const RESOLVED = new Set([
  'completed',
  'completed_occurrence',
  'skipped',
  'skipped_occurrence',
  'cancelled',
]);

export type AgendaCandidateStatus =
  | Activity['status']
  | 'completed_occurrence'
  | 'skipped_occurrence';

export interface AgendaActionContext {
  readonly activity: Activity;
  readonly callerId: string;
  readonly callerRole: 'owner' | 'participant' | 'none';
  readonly parentOwnerId?: string;
  readonly participatesInParent: boolean;
}

export interface AgendaCandidate {
  readonly activity: Activity;
  readonly occurrenceDate?: string;
  readonly status: AgendaCandidateStatus;
  readonly viewerDate: string;
  readonly time?: string;
  readonly endTime?: string;
  readonly isSnoozed: boolean;
  readonly movedFromDate?: string;
  readonly overdueFromDate?: string;
  readonly reminders?: readonly Reminder[];
  readonly actionContext: AgendaActionContext;
}

export interface AgendaAssemblyDay {
  readonly date: string;
  readonly upNext?: AgendaCandidate;
  readonly schedule: readonly AgendaCandidate[];
  readonly anytime: readonly AgendaCandidate[];
  readonly earlier: readonly AgendaCandidate[];
}

export interface AgendaAssembly {
  readonly days: readonly AgendaAssemblyDay[];
  readonly warnings: readonly string[];
}

export interface AssembleAgendaInput {
  readonly userId: string;
  readonly from: string;
  readonly to: string;
  readonly timezone: string;
  readonly now: string;
  readonly includeAnytimeUnscheduled?: boolean;
  readonly includeOverdue?: boolean;
  readonly includeReminders?: boolean;
  readonly includeSkipped?: boolean;
}

export interface AgendaDependencies {
  readonly listBucket: typeof listByBucket;
  readonly listOverdue: typeof listOverdueTaskCandidates;
  readonly batchActivities: typeof batchGetActivityMeta;
  readonly listParticipants: typeof listParticipants;
  readonly batchAgendaRows: typeof batchGetAgendaRows;
  readonly batchOccurrences: typeof batchGetForPairs;
  readonly listReminders: typeof listRemindersForUser;
  readonly expand: typeof expandRecurrence;
  readonly warn: (message: string, fields?: Record<string, unknown>) => void;
}

const DEFAULT_DEPENDENCIES: AgendaDependencies = {
  listBucket: listByBucket,
  listOverdue: listOverdueTaskCandidates,
  batchActivities: batchGetActivityMeta,
  listParticipants,
  batchAgendaRows: batchGetAgendaRows,
  batchOccurrences: batchGetForPairs,
  listReminders: listRemindersForUser,
  expand: expandRecurrence,
  warn: (message, fields) => logger.warn(fields ?? {}, message),
};

/** Hydrates, expands and assembles the agenda without performing public projection. */
export async function assembleAgenda(
  input: AssembleAgendaInput,
  dependencies: AgendaDependencies = DEFAULT_DEPENDENCIES,
): Promise<AgendaAssembly> {
  const widenedFrom = addWallDays(input.from, -2);
  const widenedTo = addWallDays(input.to, 2);
  const today = formatInTimeZone(new Date(input.now), input.timezone, WALL_DATE);
  const warnings: string[] = [];

  const [scheduledPage, seriesPage, anytimePage, overdue] = await Promise.all([
    dependencies.listBucket(input.userId, 'S', {
      between: [`${widenedFrom}T00:00`, `${widenedTo}T23:59`],
      limit: 200,
    }),
    dependencies.listBucket(input.userId, 'R', { limit: SERIES_LIMIT }),
    input.includeAnytimeUnscheduled === true
      ? dependencies.listBucket(input.userId, 'N', { ascending: false, limit: 200 })
      : Promise.resolve({ items: [] }),
    input.includeOverdue === true
      ? rollForwardOverdue(input.userId, today, dependencies)
      : Promise.resolve([]),
  ]);

  if (seriesPage.nextCursor !== undefined) warnings.push('series_limit_exceeded');

  const scheduledIndex = indexByActivity(scheduledPage.items);
  const seriesIndex = indexByActivity(seriesPage.items);
  const anytimeIndex = indexByActivity(anytimePage.items);
  const [scheduled, series, anytime] = await Promise.all([
    hydrateSelected(scheduledIndex, dependencies, 'scheduled'),
    hydrateSelected(seriesIndex, dependencies, 'series'),
    hydrateSelected(anytimeIndex, dependencies, 'anytime'),
  ]);

  const nominal = expandSeries(series, widenedFrom, widenedTo, dependencies);
  const markerPairs = series.flatMap((activity) =>
    wallDates(widenedFrom, widenedTo).map((date) => ({
      activityId: activity.activityId,
      date,
    })),
  );
  const firstPass = await dependencies.batchAgendaRows(
    nominal.map((entry) => ({ activityId: entry.activity.activityId, date: entry.date })),
    markerPairs,
  );
  const overrideByPair = occurrenceMap(firstPass.occurrences);
  const movedPairs = firstPass.markers.flatMap((marker) =>
    marker.movedFrom.map((date) => ({ activityId: marker.activityId, date })),
  );
  const movedRows = await dependencies.batchOccurrences(movedPairs);
  const movedByPair = occurrenceMap(
    movedRows.filter((row): row is Occurrence => row !== null),
  );

  const raw: RawCandidate[] = [];
  for (const activity of scheduled) {
    if (activity.status === 'cancelled' || activity.schedule === undefined) continue;
    const index = scheduledIndex.get(activity.activityId);
    raw.push(oneOffCandidate(activity, index?.timezone));
  }
  for (const activity of anytime) {
    if (activity.status === 'cancelled') continue;
    raw.push({
      activity,
      effectiveDate: input.from,
      status: activity.status,
      isSnoozed: false,
    });
  }
  for (const entry of nominal) {
    const override = overrideByPair.get(pairKey(entry.activity.activityId, entry.date));
    const merged = mergeNominal(entry, override);
    if (merged !== undefined) raw.push(merged);
  }
  raw.push(...movedCandidates(firstPass.markers, movedByPair, series));

  const converted = raw
    .map((candidate) => toViewerCandidate(candidate, input.timezone))
    .filter(
      (candidate) =>
        candidate.viewerDate >= input.from && candidate.viewerDate <= input.to,
    )
    .filter(
      (candidate) =>
        input.includeSkipped === true || candidate.status !== 'skipped_occurrence',
    );
  const deduped = dedupe([...converted, ...overdue], warnings);
  const contexts = await hydrateActionContexts(input.userId, deduped, dependencies);
  const reminders =
    input.includeReminders === true
      ? await hydrateReminders(input.userId, deduped, dependencies)
      : new Map<string, readonly Reminder[]>();

  const complete: AgendaCandidate[] = deduped.map((candidate) => {
    const ownReminders = reminders.get(candidate.activity.activityId);
    return {
      ...candidate,
      ...(ownReminders === undefined ? {} : { reminders: ownReminders }),
      actionContext: contexts.get(candidate.activity.activityId) ?? {
        activity: candidate.activity,
        callerId: input.userId,
        callerRole: 'none' as const,
        participatesInParent: false,
      },
    };
  });

  return { days: partitionDays(input, complete), warnings };
}

/**
 * Hydrates eligible index rows and projects them onto Today without changing stored dates.
 * The caller merges these rows before action-context and reminder fan-out.
 */
export async function rollForwardOverdue(
  userId: string,
  today: string,
  dependencies: AgendaDependencies = DEFAULT_DEPENDENCIES,
): Promise<Omit<AgendaCandidate, 'actionContext' | 'reminders'>[]> {
  const from = addWallDays(today, -30);
  const to = addWallDays(today, -1);
  const index = indexByActivity(await dependencies.listOverdue(userId, from, to));
  const hydrated = await hydrateSelected(index, dependencies, 'overdue');

  return hydrated.flatMap((activity) => {
    if (
      activity.type !== 'task' ||
      activity.status !== 'scheduled' ||
      activity.recurrence !== undefined ||
      activity.schedule === undefined ||
      activity.schedule.date < from ||
      activity.schedule.date > to
    ) {
      return [];
    }
    return [
      {
        activity,
        status: activity.status,
        viewerDate: today,
        isSnoozed: false,
        overdueFromDate: activity.schedule.date,
      },
    ];
  });
}

interface RawCandidate {
  readonly activity: Activity;
  readonly occurrenceDate?: string;
  readonly status: AgendaCandidateStatus;
  readonly effectiveDate: string;
  readonly effectiveTime?: string;
  readonly effectiveInstant?: string;
  readonly sourceTimezone?: string;
  readonly endTime?: string;
  readonly isSnoozed: boolean;
  readonly movedFromDate?: string;
}

interface ExpandedNominal {
  readonly activity: Activity;
  readonly date: string;
  readonly time?: string;
}

function addWallDays(value: string, amount: number): string {
  return format(addDays(parseISO(`${value}T12:00:00`), amount), WALL_DATE);
}

function wallDates(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addWallDays(date, 1)) dates.push(date);
  return dates;
}

function indexByActivity(rows: readonly StoredItem[]): Map<string, StoredItem> {
  return new Map(
    rows
      .filter((row) => typeof row.activityId === 'string')
      .map((row) => [String(row.activityId), row]),
  );
}

async function hydrateSelected(
  selected: ReadonlyMap<string, StoredItem>,
  dependencies: AgendaDependencies,
  source: string,
): Promise<Activity[]> {
  const rows = await dependencies.batchActivities([...selected.keys()]);
  const found = new Set(rows.map((row) => row.activityId));
  for (const activityId of selected.keys()) {
    if (!found.has(activityId))
      dependencies.warn('Agenda dropped a missing META row.', { activityId, source });
  }
  return rows;
}

function expandSeries(
  series: readonly Activity[],
  from: string,
  to: string,
  dependencies: AgendaDependencies,
): ExpandedNominal[] {
  const result: ExpandedNominal[] = [];
  for (const activity of series) {
    if (
      activity.status === 'cancelled' ||
      activity.recurrence === undefined ||
      activity.schedule === undefined
    )
      continue;
    const dates = dependencies.expand(
      activity.recurrence,
      from,
      to,
      activity.schedule.timezone,
    );
    for (const date of dates) {
      const time = timeForDate(activity, date);
      result.push({ activity, date, ...(time === undefined ? {} : { time }) });
    }
  }
  return result;
}

function timeForDate(activity: Activity, date: string): string | undefined {
  const segments = activity.recurrence?.segments ?? [];
  let active: RecurrenceSegment | undefined;
  for (const segment of segments) {
    if (segment.effectiveFrom > date) break;
    active = segment;
  }
  return active?.time ?? activity.schedule?.time;
}

function oneOffCandidate(activity: Activity, projectedTimezone: unknown): RawCandidate {
  const schedule = activity.schedule;
  if (schedule === undefined) throw new Error('Scheduled agenda row had no schedule.');
  const snooze = activity.snoozedUntil;
  const effectiveTime = snooze ?? schedule.time;
  return {
    activity,
    status: activity.status,
    effectiveDate: schedule.date,
    ...(snooze?.includes('T') === true
      ? { effectiveInstant: snooze }
      : effectiveTime === undefined
        ? {}
        : { effectiveTime }),
    sourceTimezone:
      typeof projectedTimezone === 'string' ? projectedTimezone : schedule.timezone,
    ...(schedule.endTime === undefined ? {} : { endTime: schedule.endTime }),
    isSnoozed: snooze !== undefined,
  };
}

function mergeNominal(
  entry: ExpandedNominal,
  override: Occurrence | undefined,
): RawCandidate | undefined {
  if (override?.overrideDate !== undefined) return undefined;
  if (override?.status === 'snoozed' && override.snoozedUntil?.includes('T') === true) {
    return undefined;
  }
  const effectiveTime = override?.snoozedUntil ?? override?.overrideTime ?? entry.time;
  return {
    activity: entry.activity,
    occurrenceDate: entry.date,
    status:
      override?.status === 'completed'
        ? 'completed_occurrence'
        : override?.status === 'skipped'
          ? 'skipped_occurrence'
          : entry.activity.status,
    effectiveDate: entry.date,
    ...(effectiveTime === undefined ? {} : { effectiveTime }),
    sourceTimezone: entry.activity.schedule?.timezone ?? 'UTC',
    ...(entry.activity.schedule?.endTime === undefined
      ? {}
      : { endTime: entry.activity.schedule.endTime }),
    isSnoozed: override?.status === 'snoozed',
  };
}

function movedCandidates(
  markers: readonly OccurrenceMoveMarker[],
  moved: ReadonlyMap<string, Occurrence>,
  series: readonly Activity[],
): RawCandidate[] {
  const activityById = new Map(series.map((activity) => [activity.activityId, activity]));
  const result: RawCandidate[] = [];
  for (const marker of markers) {
    const activity = activityById.get(marker.activityId);
    if (activity === undefined) continue;
    for (const sourceDate of marker.movedFrom) {
      const override = moved.get(pairKey(marker.activityId, sourceDate));
      if (override === undefined) continue;
      const effectiveTime =
        override.snoozedUntil ??
        override.overrideTime ??
        timeForDate(activity, sourceDate);
      result.push({
        activity,
        occurrenceDate: sourceDate,
        status:
          override.status === 'completed' ? 'completed_occurrence' : activity.status,
        effectiveDate: override.overrideDate ?? marker.destinationDate,
        ...(override.snoozedUntil?.includes('T') === true
          ? { effectiveInstant: override.snoozedUntil }
          : effectiveTime === undefined
            ? {}
            : { effectiveTime }),
        sourceTimezone: activity.schedule?.timezone ?? 'UTC',
        isSnoozed: override.status === 'snoozed',
        movedFromDate: sourceDate,
      });
    }
  }
  return result;
}

function occurrenceMap(rows: readonly Occurrence[]): Map<string, Occurrence> {
  return new Map(rows.map((row) => [pairKey(row.activityId, row.date), row]));
}

const pairKey = (activityId: string, date: string) => `${activityId}\u0000${date}`;

function toViewerCandidate(
  candidate: RawCandidate,
  viewerTimezone: string,
): Omit<AgendaCandidate, 'actionContext' | 'reminders'> {
  if (candidate.effectiveInstant !== undefined) {
    const instant = new Date(candidate.effectiveInstant);
    return {
      activity: candidate.activity,
      ...(candidate.occurrenceDate === undefined
        ? {}
        : { occurrenceDate: candidate.occurrenceDate }),
      status: candidate.status,
      viewerDate: formatInTimeZone(instant, viewerTimezone, WALL_DATE),
      time: formatInTimeZone(instant, viewerTimezone, WALL_TIME),
      isSnoozed: candidate.isSnoozed,
      ...(candidate.movedFromDate === undefined
        ? {}
        : { movedFromDate: candidate.movedFromDate }),
    };
  }
  if (candidate.effectiveTime === undefined) {
    return {
      activity: candidate.activity,
      ...(candidate.occurrenceDate === undefined
        ? {}
        : { occurrenceDate: candidate.occurrenceDate }),
      status: candidate.status,
      viewerDate: candidate.effectiveDate,
      isSnoozed: candidate.isSnoozed,
      ...(candidate.movedFromDate === undefined
        ? {}
        : { movedFromDate: candidate.movedFromDate }),
    };
  }
  const instant = toUtcInstant(
    candidate.effectiveDate,
    candidate.effectiveTime,
    candidate.sourceTimezone ?? 'UTC',
  );
  const viewerEndTime =
    candidate.endTime === undefined
      ? undefined
      : formatInTimeZone(
          toUtcInstant(
            candidate.effectiveDate,
            candidate.endTime,
            candidate.sourceTimezone ?? 'UTC',
          ),
          viewerTimezone,
          WALL_TIME,
        );
  return {
    activity: candidate.activity,
    ...(candidate.occurrenceDate === undefined
      ? {}
      : { occurrenceDate: candidate.occurrenceDate }),
    status: candidate.status,
    viewerDate: formatInTimeZone(instant, viewerTimezone, WALL_DATE),
    time: formatInTimeZone(instant, viewerTimezone, WALL_TIME),
    ...(viewerEndTime === undefined ? {} : { endTime: viewerEndTime }),
    isSnoozed: candidate.isSnoozed,
    ...(candidate.movedFromDate === undefined
      ? {}
      : { movedFromDate: candidate.movedFromDate }),
  };
}

function dedupe(
  candidates: readonly Omit<AgendaCandidate, 'actionContext' | 'reminders'>[],
  warnings: string[],
): Omit<AgendaCandidate, 'actionContext' | 'reminders'>[] {
  const seen = new Map<string, Omit<AgendaCandidate, 'actionContext' | 'reminders'>>();
  for (const candidate of [...candidates].sort(compareCandidates)) {
    const key = pairKey(candidate.activity.activityId, candidate.occurrenceDate ?? '');
    if (seen.has(key)) {
      warnings.push(`duplicate_occurrence:${candidate.activity.activityId}`);
      continue;
    }
    seen.set(key, candidate);
  }
  return [...seen.values()];
}

async function hydrateActionContexts(
  userId: string,
  candidates: readonly Omit<AgendaCandidate, 'actionContext' | 'reminders'>[],
  dependencies: AgendaDependencies,
): Promise<Map<string, AgendaActionContext>> {
  const activities = new Map(
    candidates.map((row) => [row.activity.activityId, row.activity]),
  );
  const parentIds = [
    ...new Set(
      [...activities.values()].flatMap((activity) => activity.parentActivityId ?? []),
    ),
  ];
  const parents = new Map(
    (await dependencies.batchActivities(parentIds)).map((parent) => [
      parent.activityId,
      parent,
    ]),
  );
  const participation = new Map<string, boolean>();
  await Promise.all(
    parentIds.map(async (parentId) => {
      const rows = await dependencies.listParticipants(parentId);
      participation.set(
        parentId,
        rows.some((row) => row.userId === userId),
      );
    }),
  );

  return new Map(
    [...activities.values()].map((activity) => {
      const parent =
        activity.parentActivityId === undefined
          ? undefined
          : parents.get(activity.parentActivityId);
      return [
        activity.activityId,
        {
          activity,
          callerId: userId,
          callerRole:
            activity.ownerId === userId ? ('owner' as const) : ('participant' as const),
          ...(parent === undefined ? {} : { parentOwnerId: parent.ownerId }),
          participatesInParent:
            parent !== undefined &&
            (parent.ownerId === userId || participation.get(parent.activityId) === true),
        },
      ];
    }),
  );
}

async function hydrateReminders(
  userId: string,
  candidates: readonly Omit<AgendaCandidate, 'actionContext' | 'reminders'>[],
  dependencies: AgendaDependencies,
): Promise<Map<string, readonly Reminder[]>> {
  const ids = [...new Set(candidates.map((row) => row.activity.activityId))];
  return new Map(
    await Promise.all(
      ids.map(
        async (activityId) =>
          [activityId, await dependencies.listReminders(activityId, userId)] as const,
      ),
    ),
  );
}

function partitionDays(
  input: AssembleAgendaInput,
  candidates: readonly AgendaCandidate[],
): AgendaAssemblyDay[] {
  const nowDate = formatInTimeZone(new Date(input.now), input.timezone, WALL_DATE);
  const nowTime = formatInTimeZone(new Date(input.now), input.timezone, WALL_TIME);
  return wallDates(input.from, input.to).map((date) => {
    const rows = candidates.filter((row) => row.viewerDate === date);
    const timed = rows.filter((row) => row.time !== undefined).sort(compareCandidates);
    const resolved = rows.filter((row) => RESOLVED.has(row.status));
    const earlier =
      date === nowDate
        ? [
            ...resolved,
            ...timed.filter(
              (row) =>
                !RESOLVED.has(row.status) && (row.endTime ?? row.time ?? '') < nowTime,
            ),
          ]
            .sort(compareCandidates)
            .reverse()
        : [];
    const schedule =
      date === nowDate
        ? timed.filter(
            (row) =>
              !RESOLVED.has(row.status) && (row.endTime ?? row.time ?? '') >= nowTime,
          )
        : timed;
    const anytime = rows
      .filter(
        (row) =>
          row.time === undefined && (date !== nowDate || !RESOLVED.has(row.status)),
      )
      .sort(compareAnytime);
    const upNext = schedule.find((row) => !RESOLVED.has(row.status));
    return {
      date,
      ...(upNext === undefined ? {} : { upNext }),
      schedule,
      anytime,
      earlier,
    };
  });
}

function compareAnytime(left: AgendaCandidate, right: AgendaCandidate): number {
  const leftGroup = left.overdueFromDate === undefined ? 1 : 0;
  const rightGroup = right.overdueFromDate === undefined ? 1 : 0;
  return (
    leftGroup - rightGroup ||
    (left.overdueFromDate ?? '').localeCompare(right.overdueFromDate ?? '') ||
    compareCandidates(left, right)
  );
}

function compareCandidates(
  left: Pick<AgendaCandidate, 'activity' | 'time' | 'viewerDate'>,
  right: Pick<AgendaCandidate, 'activity' | 'time' | 'viewerDate'>,
): number {
  return (
    left.viewerDate.localeCompare(right.viewerDate) ||
    (left.time ?? '').localeCompare(right.time ?? '') ||
    left.activity.activityId.localeCompare(right.activity.activityId)
  );
}
