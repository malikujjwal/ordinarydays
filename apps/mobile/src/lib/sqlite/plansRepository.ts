import {
  emptyPlansStore,
  mergePlansResponse,
  type PlansData,
  type PlansDateStore,
  type PlansRequest,
} from '@od/shared/client';
import { MAX_AGENDA_DAYS } from '@od/shared/constants';
import { addWallDays, toUtcInstant } from '@od/shared/recurrence';
import {
  agendaItem,
  instant,
  needsDateItem,
  parseWallDate,
  timeZone,
} from '@od/shared/schemas';
import { toWallDate, type WallDate } from '@od/shared/time';
import type { Activity, AgendaItem, OccurrenceDetailProjection } from '@od/shared/types';
import type { NeedsDateRowData } from '@/features/agenda/model/plansApply';
import { type SqliteDatabase, type SqliteReader, textColumn } from './database';
import type { RevisionedProjectionReader } from './projectionReader';
import type { RepositoryListener, RepositorySubscriptions } from './subscriptions';
import type { TransactionContext } from './transaction';

const PLANS_SCOPE = 'plans';
const AGENDA_SCOPE = 'agenda';

export interface NativePlansWindow {
  readonly from: WallDate;
  readonly through: WallDate;
  readonly nextFrom: WallDate | null;
}

export interface NativePlansProjection {
  readonly needsDate: readonly NeedsDateRowData[];
  readonly store: PlansDateStore;
  readonly upcomingWindow: NativePlansWindow;
  readonly pastCursor: string | undefined;
}

function parsedJson(value: string | undefined, label: string): unknown {
  if (value === undefined) throw new Error(`Native Plans ${label} is missing.`);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Native Plans ${label} is not valid JSON.`);
  }
}

function readNeedsDate(value: string | undefined): NeedsDateRowData {
  const parsed = needsDateItem.parse(parsedJson(value, 'needs-date row'));
  // The wire schema permits explicit undefined optionals; the domain model uses absence.
  return parsed as NeedsDateRowData;
}

function readAgendaItem(value: string | undefined): AgendaItem {
  const parsed = agendaItem.parse(parsedJson(value, 'dated row'));
  return parsed as AgendaItem;
}

function viewerDateFor(
  activity: Activity,
  viewerTimezone: string,
  occurrence?: OccurrenceDetailProjection,
): WallDate | undefined {
  const date = occurrence?.date ?? activity.schedule?.date;
  if (date === undefined) return undefined;
  const time = occurrence?.time ?? activity.schedule?.time;
  if (time === undefined) return parseWallDate(date);
  const sourceTimezone = activity.schedule?.timezone;
  if (sourceTimezone === undefined) return parseWallDate(date);
  return toWallDate(
    instant.parse(toUtcInstant(date, time, sourceTimezone)),
    timeZone.parse(viewerTimezone),
  );
}

/** Consecutive bounded windows, avoiding a huge fetch when the two affected dates are far apart. */
function dateWindows(dates: readonly WallDate[]): Array<{
  readonly from: WallDate;
  readonly through: WallDate;
}> {
  const sorted = [...new Set(dates)].sort();
  const windows: Array<{ from: WallDate; through: WallDate }> = [];
  let current: { from: WallDate; through: WallDate; days: number } | undefined;
  for (const date of sorted) {
    const consecutive = current !== undefined && addWallDays(current.through, 1) === date;
    if (current !== undefined && consecutive && current.days < MAX_AGENDA_DAYS) {
      current = { ...current, through: date, days: current.days + 1 };
      continue;
    }
    if (current !== undefined) {
      windows.push({ from: current.from, through: current.through });
    }
    current = { from: date, through: date, days: 1 };
  }
  if (current !== undefined) {
    windows.push({ from: current.from, through: current.through });
  }
  return windows;
}

/**
 * Typed SQLite authority for the native Plans tab.
 *
 * HTTP responses enter only through {@link install}; UI reads reconstruct the date store from
 * constrained rows. Agenda status is joined at read time so a locally accepted completion is
 * visible without a second optimistic store, and Activity.lastActivityAt is the monotonic
 * Needs-a-date floor while the server's GSI projection catches up.
 */
export class PlansRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly subscriptions: RepositorySubscriptions,
    private readonly projections?: RevisionedProjectionReader,
  ) {}

  subscribe(listener: RepositoryListener): () => void {
    const stopPlans = this.subscriptions.subscribe(PLANS_SCOPE, listener);
    const stopAgenda = this.subscriptions.subscribe(AGENDA_SCOPE, listener);
    return () => {
      stopPlans();
      stopAgenda();
    };
  }

  version(): number {
    return (
      this.subscriptions.version(PLANS_SCOPE) + this.subscriptions.version(AGENDA_SCOPE)
    );
  }

  /**
   * UI reads go through the account's serialized projection reader, like every other
   * projection. A bare `readTransaction` on the writer connection is not serialized, so two
   * overlapping Plans reads (the hook issues two on mount) nest `BEGIN` on one connection and
   * surface on the device as "cannot rollback - no transaction is active".
   */
  async read(timezone: string): Promise<NativePlansProjection | undefined> {
    if (this.projections === undefined) {
      return this.database.readTransaction((reader) => this.readFrom(reader, timezone));
    }
    const snapshot = await this.projections.snapshot((reader) =>
      this.readFrom(reader, timezone),
    );
    return snapshot.data;
  }

  async install(
    transaction: TransactionContext,
    timezone: string,
    data: PlansData,
  ): Promise<void> {
    const current = await this.readFrom(transaction.database, timezone);
    if (data.mode !== 'initial' && current === undefined) {
      throw new Error('Native Plans continuation arrived before its initial projection.');
    }

    const store = mergePlansResponse(current?.store ?? emptyPlansStore, data);
    /**
     * `initial` is the whole window. A later `upcoming_window` chunk — a scroll page or the
     * calendar's jump — only ever **extends** it: `from` stays where the list starts, `through`
     * is monotonic, and the sentinel follows the furthest window because it names the row
     * after it. Installing the chunk's own bounds would hide every plan between today and the
     * chunk from Upcoming, which is what the web hook's merge already guards against.
     */
    const held = current?.upcomingWindow;
    const upcomingWindow =
      data.mode === 'initial' || (data.mode === 'upcoming_window' && held === undefined)
        ? {
            from: data.upcomingWindow.from as WallDate,
            through: data.upcomingWindow.through as WallDate,
            nextFrom: data.upcomingWindow.nextFrom as WallDate | null,
          }
        : data.mode === 'upcoming_window' && held !== undefined
          ? held.through > (data.upcomingWindow.through as WallDate)
            ? held
            : {
                from: held.from,
                through: data.upcomingWindow.through as WallDate,
                nextFrom: data.upcomingWindow.nextFrom as WallDate | null,
              }
          : held;
    if (upcomingWindow === undefined) {
      throw new Error('Native Plans projection has no upcoming window.');
    }
    const pastCursor =
      data.mode === 'initial' || data.mode === 'past_cursor'
        ? data.pastPage.nextCursor
        : current?.pastCursor;

    await transaction.database.run(
      `INSERT INTO native_plans_state (
         timezone, upcoming_from, upcoming_through, upcoming_next_from, past_cursor
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(timezone) DO UPDATE SET
         upcoming_from=excluded.upcoming_from,
         upcoming_through=excluded.upcoming_through,
         upcoming_next_from=excluded.upcoming_next_from,
         past_cursor=excluded.past_cursor;`,
      [
        timezone,
        upcomingWindow.from,
        upcomingWindow.through,
        upcomingWindow.nextFrom,
        pastCursor ?? null,
      ],
    );

    if (data.mode === 'initial') {
      await transaction.database.run(
        'DELETE FROM native_plans_needs_date WHERE timezone = ?;',
        [timezone],
      );
      for (const [ordinal, row] of data.needsDate.entries()) {
        await transaction.database.run(
          `INSERT INTO native_plans_needs_date (
             timezone, ordinal, activity_id, last_activity_at, item_json
           ) VALUES (?, ?, ?, ?, ?);`,
          [timezone, ordinal, row.activityId, row.lastActivityAt, JSON.stringify(row)],
        );
      }
    }

    await transaction.database.run(
      'DELETE FROM native_plans_date_rows WHERE timezone = ?;',
      [timezone],
    );
    for (const [date, rows] of store.byDate) {
      for (const [ordinal, row] of rows.entries()) {
        await transaction.database.run(
          `INSERT INTO native_plans_date_rows (
             timezone, date, ordinal, activity_id, occurrence_date, status, item_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
          [
            timezone,
            date,
            ordinal,
            row.activityId,
            row.occurrenceDate ?? null,
            row.status,
            JSON.stringify(row),
          ],
        );
      }
    }
    await transaction.database.run(
      'DELETE FROM native_plans_coverage WHERE timezone = ?;',
      [timezone],
    );
    for (const [ordinal, interval] of store.covered.entries()) {
      await transaction.database.run(
        `INSERT INTO native_plans_coverage (
           timezone, ordinal, covered_from, covered_through
         ) VALUES (?, ?, ?, ?);`,
        [timezone, ordinal, interval.from, interval.through],
      );
    }
    transaction.changed(PLANS_SCOPE);
  }

  /**
   * The authoritative Plans reads required after a schedule acknowledgement.
   *
   * Old viewer-local dates come from the installed projection rather than from the Activity's
   * source timezone. The canonical result is converted into each installed viewer timezone.
   * That pair is what prevents a move from leaving the old bucket behind or omitting the new
   * one. A whole-series schedule change widens one day around its installed run because a time
   * or timezone edit can shift every recurrence across a viewer-local midnight.
   */
  async scheduleReconciliationRequests(
    activity: Activity,
    occurrenceDate?: string,
    occurrence?: OccurrenceDetailProjection,
  ): Promise<readonly PlansRequest[]> {
    const read = async (reader: SqliteReader): Promise<PlansRequest[]> => {
      const states = await reader.all(
        `SELECT timezone, upcoming_from FROM native_plans_state ORDER BY timezone;`,
      );
      if (states.length === 0) return [];
      const dateRows = await reader.all(
        `SELECT timezone, date, occurrence_date FROM native_plans_date_rows
         WHERE activity_id = ? ORDER BY timezone, date;`,
        [activity.activityId],
      );
      const needsRows = await reader.all(
        `SELECT timezone FROM native_plans_needs_date WHERE activity_id = ?;`,
        [activity.activityId],
      );
      const needsTimezones = new Set(
        needsRows
          .map((row) => textColumn(row, 'timezone'))
          .filter((value): value is string => value !== undefined),
      );
      const requests: PlansRequest[] = [];
      for (const state of states) {
        const timezone = textColumn(state, 'timezone');
        const upcomingFrom = textColumn(state, 'upcoming_from') as WallDate | undefined;
        if (timezone === undefined || upcomingFrom === undefined) {
          throw new Error('Native Plans reconciliation state is incomplete.');
        }
        const affected = dateRows
          .filter(
            (row) =>
              textColumn(row, 'timezone') === timezone &&
              (occurrenceDate === undefined ||
                textColumn(row, 'occurrence_date') === occurrenceDate),
          )
          .map((row) => textColumn(row, 'date'))
          .filter((value): value is string => value !== undefined)
          .map(parseWallDate);
        const resultingDate =
          occurrenceDate !== undefined && occurrence === undefined
            ? undefined
            : viewerDateFor(activity, timezone, occurrence);
        if (resultingDate !== undefined) affected.push(resultingDate);
        if (
          activity.recurrence !== undefined &&
          occurrenceDate === undefined &&
          affected.length > 0
        ) {
          affected.sort();
          affected.push(
            parseWallDate(addWallDays(affected[0] as WallDate, -1)),
            parseWallDate(addWallDays(affected[affected.length - 1] as WallDate, 1)),
          );
        }
        if (needsTimezones.has(timezone) || activity.schedule === undefined) {
          requests.push({ mode: 'initial', tz: timezone });
        }
        const past = affected.filter((date) => date < upcomingFrom);
        const upcoming = affected.filter((date) => date >= upcomingFrom);
        for (const window of dateWindows(past)) {
          requests.push({
            mode: 'past_window',
            tz: timezone,
            pastFrom: window.from,
            pastBefore: parseWallDate(addWallDays(window.through, 1)),
          });
        }
        for (const window of dateWindows(upcoming)) {
          requests.push({
            mode: 'upcoming_window',
            tz: timezone,
            upcomingFrom: window.from,
            upcomingTo: window.through,
          });
        }
      }
      return requests;
    };
    if (this.projections === undefined) {
      return this.database.readTransaction(read);
    }
    return (await this.projections.snapshot(read)).data;
  }

  private async readFrom(
    reader: SqliteReader,
    timezone: string,
  ): Promise<NativePlansProjection | undefined> {
    const state = await reader.first(
      `SELECT upcoming_from, upcoming_through, upcoming_next_from, past_cursor
       FROM native_plans_state WHERE timezone = ?;`,
      [timezone],
    );
    if (state === undefined) return undefined;

    const needsRows = await reader.all(
      `SELECT p.ordinal, p.last_activity_at, p.item_json,
              a.last_activity_at AS activity_floor
       FROM native_plans_needs_date p
       LEFT JOIN activities a ON a.activity_id = p.activity_id
       WHERE p.timezone = ? ORDER BY p.ordinal;`,
      [timezone],
    );
    let floorChanged = false;
    const needsDate = needsRows.map((row) => {
      const item = readNeedsDate(textColumn(row, 'item_json'));
      const persisted = textColumn(row, 'last_activity_at') ?? item.lastActivityAt;
      const activityFloor = textColumn(row, 'activity_floor');
      const lastActivityAt =
        activityFloor !== undefined && activityFloor > persisted
          ? activityFloor
          : persisted;
      if (lastActivityAt === item.lastActivityAt) return item;
      floorChanged = true;
      return { ...item, lastActivityAt };
    });
    if (floorChanged) {
      needsDate.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    }

    const dateRows = await reader.all(
      `SELECT p.date, p.item_json,
              COALESCE(a.status, p.status) AS effective_status
       FROM native_plans_date_rows p
       LEFT JOIN agenda_rows a
         ON a.activity_id = p.activity_id
        AND a.viewer_date = p.date
        AND (
          a.occurrence_date = p.occurrence_date OR
          (a.occurrence_date IS NULL AND p.occurrence_date IS NULL)
        )
       WHERE p.timezone = ?
       ORDER BY p.date, p.ordinal;`,
      [timezone],
    );
    const byDate = new Map<WallDate, AgendaItem[]>();
    for (const row of dateRows) {
      const date = textColumn(row, 'date') as WallDate | undefined;
      const status = textColumn(row, 'effective_status') as AgendaItem['status'];
      if (date === undefined || status === undefined) {
        throw new Error('Native Plans dated row is incomplete.');
      }
      const item = readAgendaItem(textColumn(row, 'item_json'));
      const rows = byDate.get(date) ?? [];
      rows.push(item.status === status ? item : { ...item, status });
      byDate.set(date, rows);
    }
    const coverageRows = await reader.all(
      `SELECT covered_from, covered_through FROM native_plans_coverage
       WHERE timezone = ? ORDER BY ordinal;`,
      [timezone],
    );
    const from = textColumn(state, 'upcoming_from') as WallDate | undefined;
    const through = textColumn(state, 'upcoming_through') as WallDate | undefined;
    if (from === undefined || through === undefined) {
      throw new Error('Native Plans window is incomplete.');
    }
    return {
      needsDate,
      store: {
        byDate,
        covered: coverageRows.map((row) => {
          const coveredFrom = textColumn(row, 'covered_from') as WallDate | undefined;
          const coveredThrough = textColumn(row, 'covered_through') as
            | WallDate
            | undefined;
          if (coveredFrom === undefined || coveredThrough === undefined) {
            throw new Error('Native Plans coverage is incomplete.');
          }
          return { from: coveredFrom, through: coveredThrough };
        }),
      },
      upcomingWindow: {
        from,
        through,
        nextFrom:
          (textColumn(state, 'upcoming_next_from') as WallDate | undefined) ?? null,
      },
      pastCursor: textColumn(state, 'past_cursor'),
    };
  }
}
