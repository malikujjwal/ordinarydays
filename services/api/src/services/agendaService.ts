import { MAX_ACTIVE_SERIES, OVERDUE_WINDOW_DAYS } from '@od/shared/constants';
import { addWallDays, expandRecurrence, toUtcInstant } from '@od/shared/recurrence';
import { agendaParticipantAvatar, ianaTimezone, ulidId } from '@od/shared/schemas';
import type {
  Activity,
  AgendaParticipantAvatar,
  AgendaWarning,
  Occurrence,
  RecurrenceSegment,
  Reminder,
} from '@od/shared/types';
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
import type { ActionCapabilityContext } from './actionCapabilities.js';

const WALL_DATE = 'yyyy-MM-dd';
const WALL_TIME = 'HH:mm';
const FAN_OUT_CONCURRENCY = 10;
const activityIdSchema = ulidId('act');
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

export interface AgendaActionContext extends ActionCapabilityContext {
  readonly parentTitle?: string;
}

export interface AgendaCandidate {
  readonly activity: Activity;
  readonly occurrenceDate?: string;
  readonly status: AgendaCandidateStatus;
  readonly viewerDate: string;
  readonly time?: string;
  readonly endTime?: string;
  readonly isSnoozed: boolean;
  readonly originalTime?: string;
  readonly movedFromDate?: string;
  readonly overdueFromDate?: string;
  readonly reminders?: readonly Reminder[];
  readonly completedAt?: string;
  readonly participantAvatars: readonly AgendaParticipantAvatar[];
  readonly actionContext: AgendaActionContext;
}

type UnhydratedAgendaCandidate = Omit<
  AgendaCandidate,
  'actionContext' | 'participantAvatars' | 'reminders'
>;

export interface AgendaAssemblyDay {
  readonly date: string;
  readonly upNext?: AgendaCandidate;
  readonly schedule: readonly AgendaCandidate[];
  readonly anytime: readonly AgendaCandidate[];
  readonly earlier: readonly AgendaCandidate[];
}

export interface AgendaAssembly {
  readonly days: readonly AgendaAssemblyDay[];
  readonly warnings: readonly AgendaWarning[];
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
  const warnings: AgendaWarning[] = [];

  const [scheduledRows, seriesPage, anytimeRows, overdue] = await Promise.all([
    listBucketToExhaustion(
      input.userId,
      'S',
      {
        between: [`${widenedFrom}T00:00`, `${widenedTo}T23:59`],
      },
      dependencies,
    ),
    dependencies.listBucket(input.userId, 'R', { limit: MAX_ACTIVE_SERIES }),
    input.includeAnytimeUnscheduled === true
      ? listBucketToExhaustion(input.userId, 'N', { ascending: false }, dependencies)
      : Promise.resolve([]),
    input.includeOverdue === true
      ? rollForwardOverdue(input.userId, today, dependencies)
      : Promise.resolve([]),
  ]);

  if (seriesPage.nextCursor !== undefined) warnings.push('series_limit_exceeded');

  const scheduledIndex = indexByActivity(scheduledRows, dependencies, 'scheduled');
  const seriesIndex = indexByActivity(seriesPage.items, dependencies, 'series');
  const anytimeIndex = indexByActivity(anytimeRows, dependencies, 'anytime');
  const presentationIndex = new Map([...scheduledIndex, ...seriesIndex, ...anytimeIndex]);
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
    if (
      activity.status === 'cancelled' ||
      activity.status === 'skipped' ||
      activity.schedule === undefined
    )
      continue;
    const index = scheduledIndex.get(activity.activityId);
    raw.push(oneOffCandidate(activity, index?.timezone));
  }
  for (const activity of anytime) {
    if (activity.status === 'cancelled' || activity.status === 'skipped') continue;
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
      participantAvatars: projectedParticipantAvatars(
        presentationIndex.get(candidate.activity.activityId),
      ),
      actionContext: contexts.get(candidate.activity.activityId) ?? {
        activity: candidate.activity,
        callerId: input.userId,
        callerRole: 'none',
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
): Promise<UnhydratedAgendaCandidate[]> {
  const from = addWallDays(today, -OVERDUE_WINDOW_DAYS);
  const to = addWallDays(today, -1);
  const index = indexByActivity(
    await dependencies.listOverdue(userId, from, to),
    dependencies,
    'overdue',
  );
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
        ...(activity.completedAt === undefined
          ? {}
          : { completedAt: activity.completedAt }),
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
  readonly originalDate?: string;
  readonly originalTime?: string;
  readonly endTime?: string;
  readonly isSnoozed: boolean;
  readonly movedFromDate?: string;
  readonly completedAt?: string;
}

interface ExpandedNominal {
  readonly activity: Activity;
  readonly date: string;
  readonly time?: string;
}

function wallDates(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addWallDays(date, 1)) dates.push(date);
  return dates;
}

function indexByActivity(
  rows: readonly StoredItem[],
  dependencies: AgendaDependencies,
  source: string,
): Map<string, StoredItem> {
  const indexed = new Map<string, StoredItem>();
  for (const row of rows) {
    const activityId = activityIdSchema.safeParse(row.activityId);
    if (activityId.success) {
      indexed.set(activityId.data, row);
    } else {
      dependencies.warn('Agenda dropped an index row with an invalid activityId.', {
        source,
      });
    }
  }
  return indexed;
}

type Bucket = Parameters<AgendaDependencies['listBucket']>[1];
type BucketOptions = NonNullable<Parameters<AgendaDependencies['listBucket']>[2]>;

async function listBucketToExhaustion(
  userId: string,
  bucket: Bucket,
  options: Omit<BucketOptions, 'cursor' | 'limit'>,
  dependencies: AgendaDependencies,
): Promise<StoredItem[]> {
  const items: StoredItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await dependencies.listBucket(userId, bucket, {
      ...options,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
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
      activity.status === 'skipped' ||
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
  const parsedTimezone = ianaTimezone.safeParse(projectedTimezone);
  return {
    activity,
    status: activity.status,
    effectiveDate: schedule.date,
    ...(snooze?.includes('T') === true
      ? { effectiveInstant: snooze }
      : effectiveTime === undefined
        ? {}
        : { effectiveTime }),
    sourceTimezone: parsedTimezone.success ? parsedTimezone.data : schedule.timezone,
    ...(snooze === undefined || schedule.time === undefined
      ? {}
      : { originalDate: schedule.date, originalTime: schedule.time }),
    ...(schedule.endTime === undefined ? {} : { endTime: schedule.endTime }),
    isSnoozed: snooze !== undefined,
    ...(activity.completedAt === undefined ? {} : { completedAt: activity.completedAt }),
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
    ...(override?.status !== 'snoozed' || entry.time === undefined
      ? {}
      : { originalDate: entry.date, originalTime: entry.time }),
    ...(entry.activity.schedule?.endTime === undefined
      ? {}
      : { endTime: entry.activity.schedule.endTime }),
    isSnoozed: override?.status === 'snoozed',
    ...(override?.completedAt === undefined ? {} : { completedAt: override.completedAt }),
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
      const originalTime = timeForDate(activity, sourceDate);
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
        ...(override.status !== 'snoozed' || originalTime === undefined
          ? {}
          : { originalDate: sourceDate, originalTime }),
        isSnoozed: override.status === 'snoozed',
        movedFromDate: sourceDate,
        ...(override.completedAt === undefined
          ? {}
          : { completedAt: override.completedAt }),
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
): UnhydratedAgendaCandidate {
  if (candidate.effectiveInstant !== undefined) {
    const instant = new Date(candidate.effectiveInstant);
    const time = formatInTimeZone(instant, viewerTimezone, WALL_TIME);
    const originalTime = viewerOriginalTime(candidate, viewerTimezone, time);
    return {
      activity: candidate.activity,
      ...(candidate.occurrenceDate === undefined
        ? {}
        : { occurrenceDate: candidate.occurrenceDate }),
      status: candidate.status,
      viewerDate: formatInTimeZone(instant, viewerTimezone, WALL_DATE),
      time,
      ...(originalTime === undefined ? {} : { originalTime }),
      isSnoozed: candidate.isSnoozed,
      ...(candidate.completedAt === undefined
        ? {}
        : { completedAt: candidate.completedAt }),
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
      ...(candidate.completedAt === undefined
        ? {}
        : { completedAt: candidate.completedAt }),
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
  const time = formatInTimeZone(instant, viewerTimezone, WALL_TIME);
  const originalTime = viewerOriginalTime(candidate, viewerTimezone, time);
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
    time,
    ...(originalTime === undefined ? {} : { originalTime }),
    ...(viewerEndTime === undefined ? {} : { endTime: viewerEndTime }),
    isSnoozed: candidate.isSnoozed,
    ...(candidate.completedAt === undefined
      ? {}
      : { completedAt: candidate.completedAt }),
    ...(candidate.movedFromDate === undefined
      ? {}
      : { movedFromDate: candidate.movedFromDate }),
  };
}

function viewerOriginalTime(
  candidate: RawCandidate,
  viewerTimezone: string,
  effectiveTime: string,
): string | undefined {
  if (candidate.originalTime === undefined) return undefined;
  const originalInstant = toUtcInstant(
    candidate.originalDate ?? candidate.effectiveDate,
    candidate.originalTime,
    candidate.sourceTimezone ?? 'UTC',
  );
  const originalTime = formatInTimeZone(originalInstant, viewerTimezone, WALL_TIME);
  return originalTime === effectiveTime ? undefined : originalTime;
}

function dedupe(
  candidates: readonly UnhydratedAgendaCandidate[],
  warnings: AgendaWarning[],
): UnhydratedAgendaCandidate[] {
  const seen = new Map<string, UnhydratedAgendaCandidate>();
  for (const candidate of [...candidates].sort(compareDedupe)) {
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
  candidates: readonly UnhydratedAgendaCandidate[],
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
  const parents = new Map<string, Activity>();
  for (const parent of await dependencies.batchActivities(parentIds)) {
    parents.set(parent.activityId, parent);
  }
  const participation = new Map<string, boolean>();
  const participationRows = await mapWithConcurrency(
    parentIds,
    FAN_OUT_CONCURRENCY,
    async (parentId) => {
      const rows = await dependencies.listParticipants(parentId);
      return {
        parentId,
        participates: rows.some((row) => row.userId === userId),
      };
    },
  );
  for (const row of participationRows) {
    participation.set(row.parentId, row.participates);
  }

  const contexts = new Map<string, AgendaActionContext>();
  for (const activity of activities.values()) {
    const parent =
      activity.parentActivityId === undefined
        ? undefined
        : parents.get(activity.parentActivityId);
    const context: AgendaActionContext = {
      activity,
      callerId: userId,
      callerRole: activity.ownerId === userId ? 'owner' : 'participant',
      ...(parent === undefined ? {} : { parentOwnerId: parent.ownerId }),
      ...(parent === undefined ? {} : { parentTitle: parent.title }),
      participatesInParent:
        parent !== undefined &&
        (parent.ownerId === userId || participation.get(parent.activityId) === true),
    };
    contexts.set(activity.activityId, context);
  }
  return contexts;
}

async function hydrateReminders(
  userId: string,
  candidates: readonly UnhydratedAgendaCandidate[],
  dependencies: AgendaDependencies,
): Promise<Map<string, readonly Reminder[]>> {
  const ids = [...new Set(candidates.map((row) => row.activity.activityId))];
  const rows = await mapWithConcurrency(ids, FAN_OUT_CONCURRENCY, async (activityId) => ({
    activityId,
    reminders: await dependencies.listReminders(activityId, userId),
  }));
  const reminders = new Map<string, readonly Reminder[]>();
  for (const row of rows) reminders.set(row.activityId, row.reminders);
  return reminders;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < values.length; start += concurrency) {
    results.push(
      ...(await Promise.all(values.slice(start, start + concurrency).map(mapper))),
    );
  }
  return results;
}

function projectedParticipantAvatars(
  item: StoredItem | undefined,
): AgendaParticipantAvatar[] {
  if (!Array.isArray(item?.participantAvatars)) return [];
  return item.participantAvatars.flatMap((value) => {
    return isAgendaParticipantAvatar(value) ? [value] : [];
  });
}

function isAgendaParticipantAvatar(value: unknown): value is AgendaParticipantAvatar {
  return agendaParticipantAvatar.safeParse(value).success;
}

function partitionDays(
  input: AssembleAgendaInput,
  candidates: readonly AgendaCandidate[],
): AgendaAssemblyDay[] {
  const nowDate = formatInTimeZone(new Date(input.now), input.timezone, WALL_DATE);
  const nowTime = formatInTimeZone(new Date(input.now), input.timezone, WALL_TIME);
  return wallDates(input.from, input.to).map((date) => {
    const rows = candidates.filter((row) => row.viewerDate === date);
    const timed = rows.filter((row) => row.time !== undefined);
    const resolved = rows.filter((row) => RESOLVED.has(row.status));
    const earlier =
      date === nowDate
        ? [
            ...resolved,
            ...timed.filter(
              (row) =>
                !RESOLVED.has(row.status) && (row.endTime ?? row.time ?? '') < nowTime,
            ),
          ].sort((left, right) => compareEarlier(left, right, input.timezone))
        : [];
    const schedule =
      date === nowDate
        ? timed.filter(
            (row) =>
              !RESOLVED.has(row.status) && (row.endTime ?? row.time ?? '') >= nowTime,
          )
        : timed;
    schedule.sort(compareSchedule);
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
  const leftGroup = anytimeGroup(left);
  const rightGroup = anytimeGroup(right);
  if (leftGroup !== rightGroup) return leftGroup - rightGroup;
  if (leftGroup === 0) {
    return (
      (left.overdueFromDate ?? '').localeCompare(right.overdueFromDate ?? '') ||
      left.activity.activityId.localeCompare(right.activity.activityId)
    );
  }
  if (leftGroup === 1) {
    return left.activity.activityId.localeCompare(right.activity.activityId);
  }
  return (
    right.activity.createdAt.localeCompare(left.activity.createdAt) ||
    right.activity.activityId.localeCompare(left.activity.activityId)
  );
}

function anytimeGroup(candidate: AgendaCandidate): number {
  if (candidate.overdueFromDate !== undefined) return 0;
  return candidate.activity.schedule === undefined ? 2 : 1;
}

function compareSchedule(left: AgendaCandidate, right: AgendaCandidate): number {
  return (
    (left.time ?? '').localeCompare(right.time ?? '') ||
    left.activity.activityId.localeCompare(right.activity.activityId) ||
    (left.occurrenceDate ?? '').localeCompare(right.occurrenceDate ?? '')
  );
}

function compareEarlier(
  left: AgendaCandidate,
  right: AgendaCandidate,
  timezone: string,
): number {
  return (
    effectiveStart(right, timezone).localeCompare(effectiveStart(left, timezone)) ||
    right.activity.activityId.localeCompare(left.activity.activityId)
  );
}

function effectiveStart(candidate: AgendaCandidate, timezone: string): string {
  if (candidate.time !== undefined) return candidate.time;
  return candidate.completedAt === undefined
    ? ''
    : formatInTimeZone(new Date(candidate.completedAt), timezone, WALL_TIME);
}

function compareDedupe(
  left: Pick<AgendaCandidate, 'activity' | 'time' | 'viewerDate' | 'occurrenceDate'>,
  right: Pick<AgendaCandidate, 'activity' | 'time' | 'viewerDate' | 'occurrenceDate'>,
): number {
  return (
    left.viewerDate.localeCompare(right.viewerDate) ||
    (left.time ?? '').localeCompare(right.time ?? '') ||
    left.activity.activityId.localeCompare(right.activity.activityId) ||
    (left.occurrenceDate ?? '').localeCompare(right.occurrenceDate ?? '')
  );
}
