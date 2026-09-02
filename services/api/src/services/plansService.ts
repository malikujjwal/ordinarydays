import { MAX_ACTIVE_SERIES, MAX_AGENDA_DAYS, MAX_NEEDS_DATE_ROWS } from '@od/shared';
import { expandRecurrence } from '@od/shared/recurrence';
import { agendaParticipantAvatar, plansPastCursorPayload } from '@od/shared/schemas';
import type {
  Activity,
  AgendaItem,
  AgendaParticipantAvatar,
  NeedsDateItem,
  PlansData,
  PlansDay,
  PlansQuery,
  PlansWarning,
  RsvpSummary,
} from '@od/shared/types';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
  batchGetActivityMeta,
  listByBucket,
} from '../repositories/activityRepository.js';
import type { StoredItem } from '../repositories/migrate.js';
import { type AgendaProjectionClock, projectAgendaItem } from './agendaProjection.js';
import { assertSupportedTimezone } from './agendaQueryService.js';
import { assembleAgenda, oneOffCandidate, toViewerCandidate } from './agendaService.js';

/**
 * `GET /v1/plans` — the three-stage Plans tab (§P3-20, `api-contract.md` §2.2a).
 *
 * ## One mode, one set of streams
 *
 * Every request selects exactly one arm. `initial` starts four logical streams — `#P`, the
 * future slice of `#S`, the past slice of `#S`, and `#R`; a continuation starts only what its
 * stage needs. That is not an optimisation bolted on afterwards, it is the contract: a
 * response that read only past `#S` must not be able to *say* `upcoming: []`, because a client
 * merging it would erase a stage it never asked about.
 *
 * ## What this file refuses to do twice
 *
 * Bounded Upcoming and Past windows go through {@link assembleAgenda}, the same path Today
 * uses, so recurrence expansion, occurrence overrides, cross-day moves and the duplicate
 * diagnostics all behave identically on every dated screen and their warnings propagate
 * untouched. The open older-history continuation remains a cursor over stored `#S` rows;
 * visible Past ranges are authoritative only after their bounded `past_window` is assembled.
 *
 * ## What it never reads
 *
 * `#N`, ever: an undated Task is Today's business, and the rule is enforced by not querying
 * the bucket rather than by filtering afterwards. And no participant or suggestion row: Phase
 * 3 has neither, so `needsDate` carries the zero projection below. A Query per row here would
 * be the shape P6-40 then has to unpick.
 */

/** `initial`'s Upcoming window: today plus 61 days, inclusive — 62 dates. */
const INITIAL_WINDOW_DAYS = MAX_AGENDA_DAYS - 1;

/**
 * How far past a window's end the future stream will look for `nextFrom` before giving up.
 *
 * `nextFrom` may jump an empty gap, so the probe cannot stop at the next date — but it also
 * cannot scan a calendar to the end of time. Two years is far enough that a real later plan is
 * found and bounded enough that an empty account answers immediately. Beyond it the honest
 * answer is `null`: not "there is nothing", but "nothing within reach", and the client's next
 * scroll asks again from a later window.
 */
const NEXT_FROM_HORIZON_DAYS = 730;

/** One page of the bounded past scan. Small enough to refill, large enough to fill a screen. */
const PAST_PAGE_SIZE = 50;

/** Every needs-a-date row's RSVP block in this phase: nobody has been asked yet. */
const ZERO_RSVP: RsvpSummary = {
  interested: { count: 0, names: [] },
  maybe: { count: 0, names: [] },
  pass: { count: 0, names: [] },
  pending: { count: 0, names: [] },
};

export interface PlansDependencies {
  readonly listBucket: typeof listByBucket;
  readonly batchActivities: typeof batchGetActivityMeta;
  readonly assemble: typeof assembleAgenda;
  readonly expand: typeof expandRecurrence;
  readonly warn: (message: string, fields?: Record<string, unknown>) => void;
}

const DEFAULT_DEPENDENCIES: PlansDependencies = {
  listBucket: listByBucket,
  batchActivities: batchGetActivityMeta,
  assemble: assembleAgenda,
  expand: expandRecurrence,
  warn: (message, fields) => logger.warn(fields ?? {}, message),
};

export async function getPlans(
  userId: string,
  query: PlansQuery,
  now: string,
  dependencies: PlansDependencies = DEFAULT_DEPENDENCIES,
): Promise<PlansData> {
  assertSupportedTimezone(query.tz);
  const today = formatInTimeZone(new Date(now), query.tz, 'yyyy-MM-dd');

  switch (query.mode) {
    case 'initial': {
      const from = today;
      const through = addWallDays(today, INITIAL_WINDOW_DAYS);
      /**
       * Concurrent, because they are four independent streams and the screen needs all of
       * them. Sequential would make the tab as slow as the sum of its stages.
       */
      const [needsDate, upcoming, past] = await Promise.all([
        readNeedsDate(userId, query.tz, now, today, dependencies),
        readUpcoming(userId, query.tz, now, from, through, dependencies),
        readPast(userId, query.tz, now, today, { kind: 'open' }, dependencies),
      ]);

      return {
        mode: 'initial',
        needsDate: needsDate.items,
        upcoming: upcoming.days,
        upcomingWindow: { from, through, nextFrom: upcoming.nextFrom },
        past: past.days,
        pastPage: past.cursor === undefined ? {} : { nextCursor: past.cursor },
        warnings: [...needsDate.warnings, ...upcoming.warnings],
      };
    }

    case 'upcoming_window': {
      const upcoming = await readUpcoming(
        userId,
        query.tz,
        now,
        query.upcomingFrom,
        query.upcomingTo,
        dependencies,
      );
      return {
        mode: 'upcoming_window',
        upcoming: upcoming.days,
        upcomingWindow: {
          from: query.upcomingFrom,
          through: query.upcomingTo,
          nextFrom: upcoming.nextFrom,
        },
        warnings: upcoming.warnings,
      };
    }

    case 'past_window': {
      const requestedThrough = addWallDays(query.pastBefore, -1);
      if (query.cursor !== undefined) {
        // Accept only a legacy continuation issued for these exact bounds. Shared assembly
        // exhausts the whole bounded window now, so no replacement cursor is emitted.
        decodePastCursor(query.cursor, userId, 'past_window', {
          from: query.pastFrom,
          before: query.pastBefore,
        });
      }

      const past = await readPastWindow(
        userId,
        query.tz,
        now,
        today,
        query.pastFrom,
        requestedThrough,
        dependencies,
      );

      return {
        mode: 'past_window',
        past: past.days,
        pastCoverage: {
          requestedFrom: query.pastFrom,
          requestedThrough,
          coveredFrom: query.pastFrom,
          coveredThrough: requestedThrough,
          complete: true,
        },
        warnings: past.warnings,
      };
    }

    case 'past_cursor': {
      const resumed = decodePastCursor(query.cursor, userId, 'past_cursor');
      const past = await readPast(
        userId,
        query.tz,
        now,
        today,
        { kind: 'open', resumed },
        dependencies,
      );
      return {
        mode: 'past_cursor',
        past: past.days,
        pastPage: past.cursor === undefined ? {} : { nextCursor: past.cursor },
        warnings: [],
      };
    }

    default:
      throw new AppError('validation_failed', 'Unsupported Plans mode.');
  }
}

interface NeedsDateResult {
  readonly items: NeedsDateItem[];
  readonly warnings: PlansWarning[];
}

/**
 * The `#P` bucket, most recently discussed first (access pattern 2b).
 *
 * Read one row past the cap so the warning is a fact rather than a guess: a page that comes
 * back exactly full is indistinguishable from one that is merely full, and the extra row is
 * what tells them apart. It is dropped before projection.
 */
async function readNeedsDate(
  userId: string,
  timezone: string,
  now: string,
  today: string,
  dependencies: PlansDependencies,
): Promise<NeedsDateResult> {
  const page = await dependencies.listBucket(userId, 'P', {
    ascending: false,
    limit: MAX_NEEDS_DATE_ROWS + 1,
  });

  const warnings: PlansWarning[] = [];
  const rows = page.items.slice(0, MAX_NEEDS_DATE_ROWS);
  if (page.items.length > MAX_NEEDS_DATE_ROWS || page.nextCursor !== undefined) {
    warnings.push('needs_date_limit_exceeded');
  }

  const indexByActivityId = new Map<string, StoredItem>();
  for (const row of rows) {
    if (typeof row.activityId === 'string') indexByActivityId.set(row.activityId, row);
  }

  const activities =
    indexByActivityId.size === 0
      ? []
      : await dependencies.batchActivities([...indexByActivityId.keys()]);
  const byId = new Map(activities.map((entry) => [entry.activityId, entry]));
  const clock: AgendaProjectionClock = { now, timezone, today };

  const items: NeedsDateItem[] = [];
  // The GSI order is the answer; re-sorting here would substitute a second opinion for it.
  for (const activityId of indexByActivityId.keys()) {
    const activity = byId.get(activityId);
    if (activity === undefined) continue;
    /**
     * A resolved plan is not undecided. Both statuses can still sit in `#P` — completing an
     * undated plan does not move its bucket — so the stage filters them rather than trusting
     * the bucket to mean "needs a date" on its own.
     */
    if (activity.status === 'cancelled' || activity.status === 'completed') continue;

    items.push({
      ...projectNeedsDateBase(activity, indexByActivityId.get(activityId), userId, clock),
      lastActivityAt: activity.lastActivityAt,
      rsvpSummary: ZERO_RSVP,
      suggestionCount: 0,
    });
  }

  return { items, warnings };
}

/**
 * One needs-a-date row as an `AgendaItem`, built without a single extra read.
 *
 * `participantAvatars` comes off the index row's own projection, which is why the stage costs
 * one Query and one `BatchGetItem` however many rows it holds. `viewerDate` is today because
 * an undated plan has no date of its own and `isPast` must answer false; nothing renders the
 * field on this stage.
 */
function projectNeedsDateBase(
  activity: Activity,
  indexRow: StoredItem | undefined,
  userId: string,
  clock: AgendaProjectionClock,
): AgendaItem {
  return projectAgendaItem(
    {
      activity,
      status: activity.status,
      viewerDate: clock.today,
      isSnoozed: false,
      participantAvatars: projectedAvatars(indexRow),
      actionContext: {
        activity,
        callerId: userId,
        callerRole: activity.ownerId === userId ? 'owner' : 'participant',
        participatesInParent: false,
      },
    },
    clock,
  );
}

function projectedAvatars(row: StoredItem | undefined): AgendaParticipantAvatar[] {
  const avatars = row?.participantAvatars;
  if (!Array.isArray(avatars)) return [];
  return avatars.filter(isAgendaParticipantAvatar);
}

function isAgendaParticipantAvatar(value: unknown): value is AgendaParticipantAvatar {
  return agendaParticipantAvatar.safeParse(value).success;
}

interface UpcomingResult {
  readonly days: PlansDay[];
  readonly nextFrom: string | null;
  readonly warnings: PlansWarning[];
}

/**
 * Upcoming: the shared agenda path, regrouped for Plans.
 *
 * `assembleAgenda` already reads the widened future `#S` slice and all bounded `#R` rows,
 * expands only inside the window, applies overrides and converts before filtering. Plans wants
 * the same rows in a different shape — one flat list per date rather than Today's
 * schedule/anytime/earlier bands — so this regroups rather than re-derives.
 *
 * `upNext` is deliberately not read: it is a **second reference** to a row already in
 * `schedule`, and including it would render that row twice.
 */
async function readUpcoming(
  userId: string,
  timezone: string,
  now: string,
  from: string,
  through: string,
  dependencies: PlansDependencies,
): Promise<UpcomingResult> {
  const assembly = await dependencies.assemble({
    userId,
    from,
    to: through,
    timezone,
    now,
    /** `#N` is never queried. Today owns undated tasks; Plans does not show them. */
    includeAnytimeUnscheduled: false,
    includeOverdue: false,
    includeReminders: false,
  });

  const clock: AgendaProjectionClock = { now, timezone, today: from };
  const days: PlansDay[] = [];
  for (const day of assembly.days) {
    const candidates = [...day.schedule, ...day.anytime, ...day.earlier];
    if (candidates.length === 0) continue;
    days.push({
      date: day.date,
      items: candidates
        .map((candidate) => projectAgendaItem(candidate, clock))
        .sort(compareWithinDay),
    });
  }

  const nextFrom = await findNextFrom(userId, timezone, through, dependencies);
  return { days, nextFrom, warnings: [...assembly.warnings] };
}

/** Untimed first, then by time, then by id — the §1.3 order, stable across pages. */
function compareWithinDay(left: AgendaItem, right: AgendaItem): number {
  const leftTime = left.time ?? '';
  const rightTime = right.time ?? '';
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  return left.activityId < right.activityId ? -1 : 1;
}

interface PastWindowResult {
  readonly days: PlansDay[];
  readonly warnings: PlansWarning[];
}

/**
 * A bounded Past calendar range through the same recurrence and override assembly as Today.
 *
 * The assembler returns dates ascending for agenda rendering. Past uses the identical
 * candidates but reverses the date groups after projection, preserving the Plans ordering
 * inside each day. This is also the authoritative path for historical recurring occurrences:
 * virtual `#R` dates do not exist in the open stored-row cursor below.
 */
async function readPastWindow(
  userId: string,
  timezone: string,
  now: string,
  today: string,
  from: string,
  through: string,
  dependencies: PlansDependencies,
): Promise<PastWindowResult> {
  const assembly = await dependencies.assemble({
    userId,
    from,
    to: through,
    timezone,
    now,
    includeAnytimeUnscheduled: false,
    includeOverdue: false,
    includeReminders: false,
  });

  const clock: AgendaProjectionClock = { now, timezone, today };
  const rows = assembly.days.flatMap((day) =>
    [...day.schedule, ...day.anytime, ...day.earlier].map((candidate) => ({
      date: day.date,
      item: projectAgendaItem(candidate, clock),
    })),
  );

  return { days: groupDescending(rows), warnings: [...assembly.warnings] };
}

/**
 * The earliest viewer-local date after `through`, from either source, or `null`.
 *
 * Two sources, because either can be the answer and neither can be assumed. The one-off probe
 * **continues the future stream** above the window and stops at the first candidate that
 * converts to a date after `through` — converted, never the raw key date, because a row stored
 * in another zone can cross the boundary on conversion and a key-date answer would send the
 * next window to the wrong day. The recurring side asks each bounded series for its own next
 * occurrence, so an empty six-month gap costs arithmetic rather than a scan.
 */
async function findNextFrom(
  userId: string,
  timezone: string,
  through: string,
  dependencies: PlansDependencies,
): Promise<string | null> {
  const horizonStart = addWallDays(through, -1);
  const horizonEnd = addWallDays(through, NEXT_FROM_HORIZON_DAYS);

  const [oneOff, series] = await Promise.all([
    nextOneOffAfter(userId, timezone, through, horizonStart, horizonEnd, dependencies),
    nextSeriesAfter(userId, timezone, through, horizonEnd, dependencies),
  ]);

  const candidates = [oneOff, series].filter((date): date is string => date !== null);
  if (candidates.length === 0) return null;
  return candidates.sort()[0] ?? null;
}

async function nextOneOffAfter(
  userId: string,
  timezone: string,
  through: string,
  horizonStart: string,
  horizonEnd: string,
  dependencies: PlansDependencies,
): Promise<string | null> {
  let cursor: string | undefined;

  do {
    const page = await dependencies.listBucket(userId, 'S', {
      between: [`${horizonStart}T00:00`, `${horizonEnd}T23:59`],
      limit: PAST_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });

    const activities = await hydrateIndexed(page.items, dependencies);
    const dates = activities
      .flatMap(({ activity, indexRow }) =>
        activity.schedule === undefined || isResolvedAway(activity)
          ? []
          : [viewerDateOf(activity, indexRow, timezone)],
      )
      .filter((date) => date > through)
      .sort();

    if (dates[0] !== undefined) return dates[0];
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return null;
}

async function nextSeriesAfter(
  userId: string,
  timezone: string,
  through: string,
  horizonEnd: string,
  dependencies: PlansDependencies,
): Promise<string | null> {
  const page = await dependencies.listBucket(userId, 'R', { limit: MAX_ACTIVE_SERIES });
  const activities = await hydrateIndexed(page.items, dependencies);

  const dates: string[] = [];
  for (const { activity, indexRow } of activities) {
    if (activity.recurrence === undefined || activity.schedule === undefined) continue;
    if (isResolvedAway(activity)) continue;
    const zone = projectedTimezone(indexRow) ?? activity.schedule.timezone;
    /**
     * Expanded from the day after `through` in the **series'** own zone, then converted, so a
     * series stored in Tokyo answers with the date its viewer actually sees.
     */
    for (const date of dependencies.expand(
      activity.recurrence,
      addWallDays(through, 1),
      horizonEnd,
      zone,
    )) {
      const viewerDate = convertWallDate(date, activity.schedule.time, zone, timezone);
      if (viewerDate > through) {
        dates.push(viewerDate);
        break;
      }
    }
  }

  return dates.sort()[0] ?? null;
}

type PastScan =
  | { readonly kind: 'open'; readonly resumed?: ResumedCursor }
  | {
      readonly kind: 'window';
      readonly from: string;
      readonly before: string;
      readonly resumed?: ResumedCursor;
    };

interface PastResult {
  readonly days: PlansDay[];
  readonly cursor?: string;
  readonly coveredFrom?: string;
  readonly coveredThrough?: string;
}

/**
 * Open Past pagination: stored `#S` rows, newest first, below viewer-local today.
 *
 * Recurring occurrences are virtual rather than stored in `#S`; the bounded window above is
 * therefore the authoritative source for every visible Past range. This cursor remains useful
 * for discovering older stored one-offs without inventing a second recurrence materialisation.
 *
 * The scan **refills**. A page can come back entirely made of rows that convert out of range —
 * boundary candidates from the two-day overlap, or dates below a window's floor — and
 * returning an empty page with a cursor would make the client page an unknown number of times
 * to find out whether anything is there. So it keeps reading until it has rows, exhausts the
 * range, or hits its page budget.
 */
async function readPast(
  userId: string,
  timezone: string,
  now: string,
  today: string,
  scan: PastScan,
  dependencies: PlansDependencies,
): Promise<PastResult> {
  const ceiling = scan.kind === 'window' ? addWallDays(scan.before, -1) : today;
  const floor = scan.kind === 'window' ? scan.from : undefined;

  /** Access pattern 1's two-day overlap, on both ends of the stored-key range. */
  const keyHigh = addWallDays(ceiling, 2);
  const keyLow = floor === undefined ? '0000-01-01' : addWallDays(floor, -2);

  const clock: AgendaProjectionClock = { now, timezone, today };
  const collected: { date: string; item: AgendaItem }[] = [];
  let cursor = scan.resumed?.key;
  let pages = 0;
  let exhausted = true;
  let lowestSeen: string | undefined;

  do {
    const page = await dependencies.listBucket(userId, 'S', {
      between: [`${keyLow}T00:00`, `${keyHigh}T23:59`],
      ascending: false,
      limit: PAST_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    pages += 1;

    const activities = await hydrateIndexed(page.items, dependencies);
    for (const { activity, indexRow } of activities) {
      if (activity.schedule === undefined || isResolvedAway(activity)) continue;
      const viewerDate = viewerDateOf(activity, indexRow, timezone);
      if (viewerDate >= (scan.kind === 'window' ? scan.before : today)) continue;
      if (floor !== undefined && viewerDate < floor) continue;

      lowestSeen =
        lowestSeen === undefined || viewerDate < lowestSeen ? viewerDate : lowestSeen;
      collected.push({
        date: viewerDate,
        item: projectAgendaItem(
          {
            ...toViewerCandidate(
              oneOffCandidate(activity, projectedTimezone(indexRow)),
              timezone,
            ),
            participantAvatars: projectedAvatars(indexRow),
            actionContext: {
              activity,
              callerId: userId,
              callerRole: activity.ownerId === userId ? 'owner' : 'participant',
              participatesInParent: false,
            },
          },
          clock,
        ),
      });
    }

    cursor = page.nextCursor;
    if (cursor === undefined) break;
    /**
     * Stop refilling once there is something to show. A page budget rather than a row budget:
     * the point is to bound the work, and a caller that wants more asks with the cursor.
     */
    if (collected.length > 0 || pages >= 4) {
      exhausted = false;
      break;
    }
  } while (cursor !== undefined);

  const days = groupDescending(collected);
  const coverage =
    scan.kind === 'window'
      ? {
          coveredFrom: exhausted ? scan.from : (lowestSeen ?? ceiling),
          coveredThrough: scan.resumed?.coveredThrough ?? ceiling,
        }
      : {};

  return {
    days,
    ...(exhausted || cursor === undefined
      ? {}
      : {
          cursor: encodePastCursor({
            mode: scan.kind === 'window' ? 'past_window' : 'past_cursor',
            ...(scan.kind === 'window'
              ? { bounds: { from: scan.from, before: scan.before } }
              : {}),
            key: cursor,
            ...(coverage.coveredFrom === undefined
              ? {}
              : { coveredThrough: coverage.coveredFrom }),
            userId,
          }),
        }),
    ...coverage,
  };
}

/** Newest date first; rows inside a date keep the §1.3 ordering. */
function groupDescending(rows: { date: string; item: AgendaItem }[]): PlansDay[] {
  const byDate = new Map<string, AgendaItem[]>();
  for (const row of rows) {
    const bucket = byDate.get(row.date) ?? [];
    bucket.push(row.item);
    byDate.set(row.date, bucket);
  }
  return [...byDate.keys()]
    .sort()
    .reverse()
    .map((date) => ({
      date,
      items: (byDate.get(date) ?? []).sort(compareWithinDay),
    }));
}

interface IndexedActivity {
  readonly activity: Activity;
  readonly indexRow: StoredItem | undefined;
}

/** Hydrates a page of index rows, keeping each row beside the Activity it points at. */
async function hydrateIndexed(
  rows: readonly StoredItem[],
  dependencies: PlansDependencies,
): Promise<IndexedActivity[]> {
  const byId = new Map<string, StoredItem>();
  for (const row of rows) {
    if (typeof row.activityId === 'string') byId.set(row.activityId, row);
  }
  // An empty page needs no hydration. `BatchGetItem` with no keys is a round trip that can
  // only return nothing, and the past scan refills — so it is a page's worth of them.
  if (byId.size === 0) return [];
  const activities = await dependencies.batchActivities([...byId.keys()]);
  return activities.map((activity) => ({
    activity,
    indexRow: byId.get(activity.activityId),
  }));
}

/** `cancelled` and `skipped` rows are not part of either dated stage. */
function isResolvedAway(activity: Activity): boolean {
  return activity.status === 'cancelled' || activity.status === 'skipped';
}

function projectedTimezone(row: StoredItem | undefined): string | undefined {
  return typeof row?.timezone === 'string' ? row.timezone : undefined;
}

/** The viewer-local date for a stored one-off, through the shared conversion. */
function viewerDateOf(
  activity: Activity,
  indexRow: StoredItem | undefined,
  timezone: string,
): string {
  return toViewerCandidate(
    oneOffCandidate(activity, projectedTimezone(indexRow)),
    timezone,
  ).viewerDate;
}

/**
 * A stored wall date/time in one zone, as the viewer's date.
 *
 * An **untimed** date never moves: a date with no time has no instant, so there is nothing to
 * convert and inventing a midnight would shift rows across the boundary for no reason — the
 * same rule `deriveScheduleInstants` states from the other side.
 *
 * `fromZonedTime` reads the zone's real offset for that date, so a series crossing a DST
 * boundary converts with the offset in force **then** rather than the one in force today.
 */
function convertWallDate(
  date: string,
  time: string | undefined,
  from: string,
  to: string,
): string {
  if (time === undefined || from === to) return date;
  return formatInTimeZone(fromZonedTime(`${date}T${time}:00`, from), to, 'yyyy-MM-dd');
}

function addWallDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

interface ResumedCursor {
  readonly key: string;
  readonly coveredThrough?: string;
}

const CURSOR_REJECTED = 'That cursor was not issued for this request.';

function encodePastCursor(payload: {
  mode: 'initial' | 'past_window' | 'past_cursor';
  bounds?: { from: string; before: string };
  key: string;
  coveredThrough?: string;
  userId: string;
}): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Opens a cursor and refuses one that belongs somewhere else.
 *
 * Scope is checked, not assumed: the caller, the mode that issued it and — for a window — the
 * exact bounds. A cursor replayed against different bounds would page a range it was never
 * measured for and report coverage the client would then trust.
 */
function decodePastCursor(
  raw: string,
  userId: string,
  mode: 'past_window' | 'past_cursor',
  bounds?: { from: string; before: string },
): ResumedCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new AppError('validation_failed', CURSOR_REJECTED, [
      { path: 'cursor', message: CURSOR_REJECTED },
    ]);
  }

  const payload = plansPastCursorPayload.safeParse(parsed);
  if (!payload.success || payload.data.userId !== userId) {
    throw new AppError('validation_failed', CURSOR_REJECTED, [
      { path: 'cursor', message: CURSOR_REJECTED },
    ]);
  }

  const issued = payload.data;
  const acceptable =
    mode === 'past_window'
      ? issued.mode === 'past_window' &&
        issued.bounds?.from === bounds?.from &&
        issued.bounds?.before === bounds?.before
      : issued.mode === 'initial' || issued.mode === 'past_cursor';

  if (!acceptable) {
    throw new AppError('validation_failed', CURSOR_REJECTED, [
      { path: 'cursor', message: CURSOR_REJECTED },
    ]);
  }

  return {
    key: issued.key,
    ...(issued.coveredThrough === undefined
      ? {}
      : { coveredThrough: issued.coveredThrough }),
  };
}
