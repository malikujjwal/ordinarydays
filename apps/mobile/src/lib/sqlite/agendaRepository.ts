import { addWallDays } from '@od/shared/recurrence';
import type { AgendaQuery } from '@od/shared/schemas';
import { agendaItem as agendaItemSchema } from '@od/shared/schemas';
import { systemClock } from '@od/shared/time';
import type {
  Activity,
  ActivityAgendaData,
  AgendaData,
  AgendaDay,
  AgendaItem,
  OccurrenceDetailProjection,
} from '@od/shared/types';
import { partitionAgenda } from '@/lib/agenda/partition';
import type { AgendaCoverage } from '@/lib/sqlite/agendaCoverage';
import type { SqliteExecutor, SqliteReader, SqliteRow } from '@/lib/sqlite/database';
import { readCanonicalOutboxGuards } from '@/lib/sqlite/outbox';
import type { RepositorySubscriptions } from '@/lib/sqlite/subscriptions';
import type { TransactionContext } from '@/lib/sqlite/transaction';

export type { AgendaCoverage } from '@/lib/sqlite/agendaCoverage';

function text(row: SqliteRow, column: string): string | undefined {
  const value = row[column];
  return typeof value === 'string' ? value : undefined;
}

function number(row: SqliteRow, column: string): number | undefined {
  const value = row[column];
  return typeof value === 'number' ? value : undefined;
}

function json<T>(value: string | undefined, fallback: T): T {
  return value === undefined ? fallback : (JSON.parse(value) as T);
}

function includeKey(include: string | undefined): string {
  return include ?? '';
}

function occurrenceIdentity(activityId: string, occurrenceDate?: string): string {
  return JSON.stringify([activityId, occurrenceDate ?? null]);
}

function rowIdFromParts(
  date: string,
  activityId: string,
  occurrenceDate?: string,
): string {
  /* Expo SQLite on iOS truncates bound text at NUL, so persisted keys must be NUL-free. */
  return JSON.stringify([date, activityId, occurrenceDate ?? null]);
}

function rowId(date: string, item: AgendaItem): string {
  return rowIdFromParts(date, item.activityId, item.occurrenceDate);
}

/**
 * Every item a day's response carries, `upNext` included. `upNext` may repeat an item that
 * is also in `schedule` — deliberate, and harmless to the set/upsert consumers here.
 * `insertDay` and `replaceLocalActivityRows` intentionally do NOT use this: they treat
 * `upNext` as an identity flag, not an extra item.
 */
function itemsOf(day: AgendaDay): readonly AgendaItem[] {
  return [
    ...(day.upNext === undefined ? [] : [day.upNext]),
    ...day.schedule,
    ...day.anytime,
    ...day.earlier,
  ];
}

function itemFromRow(row: SqliteRow): AgendaItem {
  return agendaItemSchema.parse({
    activityId: text(row, 'activity_id'),
    ...(text(row, 'occurrence_date') === undefined
      ? {}
      : { occurrenceDate: text(row, 'occurrence_date') }),
    ...(text(row, 'parent_activity_id') === undefined
      ? {}
      : { parentActivityId: text(row, 'parent_activity_id') }),
    type: text(row, 'type'),
    title: text(row, 'title'),
    status: text(row, 'status'),
    ...(text(row, 'time') === undefined ? {} : { time: text(row, 'time') }),
    ...(text(row, 'end_time') === undefined ? {} : { endTime: text(row, 'end_time') }),
    isRecurring: number(row, 'is_recurring') === 1,
    ...(text(row, 'recurrence_description') === undefined
      ? {}
      : { recurrenceDescription: text(row, 'recurrence_description') }),
    isSnoozed: number(row, 'is_snoozed') === 1,
    ...(text(row, 'original_time') === undefined
      ? {}
      : { originalTime: text(row, 'original_time') }),
    hasCheckbox: number(row, 'has_checkbox') === 1,
    capabilities: json(text(row, 'capabilities_json'), {
      complete: false,
      skip: false,
      snooze: false,
    }),
    participantAvatars: json(text(row, 'participant_avatars_json'), []),
    participantCount: number(row, 'participant_count'),
    ...(text(row, 'location_label') === undefined
      ? {}
      : { locationLabel: text(row, 'location_label') }),
    ...(text(row, 'subtitle') === undefined ? {} : { subtitle: text(row, 'subtitle') }),
    ...(text(row, 'note_excerpt') === undefined
      ? {}
      : { noteExcerpt: text(row, 'note_excerpt') }),
    isPast: number(row, 'is_past') === 1,
    ...(text(row, 'overdue_from_date') === undefined
      ? {}
      : { overdueFromDate: text(row, 'overdue_from_date') }),
  }) as AgendaItem;
}

function itemValues(
  date: string,
  section: 'schedule' | 'anytime' | 'earlier',
  order: number,
  item: AgendaItem,
  state: 'canonical' | 'queued' | 'updating' | 'needs_attention',
  isUpNext: boolean,
  canonicalVersion?: string,
): readonly (string | number | null)[] {
  return [
    rowId(date, item),
    date,
    section,
    order,
    isUpNext ? 1 : 0,
    item.activityId,
    item.occurrenceDate ?? null,
    item.parentActivityId ?? null,
    item.type,
    item.title,
    item.status,
    item.time ?? null,
    item.endTime ?? null,
    item.isRecurring ? 1 : 0,
    item.recurrenceDescription ?? null,
    item.isSnoozed ? 1 : 0,
    item.originalTime ?? null,
    item.hasCheckbox ? 1 : 0,
    JSON.stringify(item.capabilities),
    JSON.stringify(item.participantAvatars),
    item.participantCount,
    item.locationLabel ?? null,
    item.subtitle ?? null,
    item.noteExcerpt ?? null,
    item.isPast ? 1 : 0,
    item.overdueFromDate ?? null,
    state,
    canonicalVersion ?? null,
  ];
}

const AGENDA_ROW_COLUMNS = `
  row_id, viewer_date, section, sort_order, is_up_next, activity_id, occurrence_date,
  parent_activity_id, type, title, status, time, end_time, is_recurring,
  recurrence_description, is_snoozed, original_time, has_checkbox,
  capabilities_json, participant_avatars_json, participant_count, location_label,
  subtitle, note_excerpt, is_past, overdue_from_date, local_state, canonical_version
`;
const AGENDA_ROW_PLACEHOLDERS = Array.from({ length: 28 }, () => '?').join(', ');
const INSERT_ROW = `INSERT INTO agenda_rows (${AGENDA_ROW_COLUMNS})
  VALUES (${AGENDA_ROW_PLACEHOLDERS});`;
const INSERT_CHUNK_SIZE = 25;

export class AgendaRepository {
  constructor(
    private readonly reader: SqliteReader,
    private readonly subscriptions: RepositorySubscriptions,
  ) {}

  scope(coverage: AgendaCoverage): string {
    return `agenda:${coverage.from}:${coverage.to}:${coverage.timezone}:${includeKey(coverage.include)}`;
  }

  subscribe(_coverage: AgendaCoverage, listener: () => void): () => void {
    return this.subscriptions.subscribe('agenda', listener);
  }

  version(_coverage: AgendaCoverage): number {
    return this.subscriptions.version('agenda');
  }

  async read(coverage: AgendaCoverage): Promise<AgendaData> {
    return this.readWith(this.reader, coverage);
  }

  async coverage(): Promise<readonly AgendaCoverage[]> {
    const rows = await this.reader.all(
      'SELECT from_date, to_date, timezone, include_key FROM agenda_coverage ORDER BY from_date, to_date;',
    );
    return rows.map((row) => {
      const include = text(row, 'include_key');
      return {
        from: text(row, 'from_date') ?? '',
        to: text(row, 'to_date') ?? '',
        timezone: text(row, 'timezone') ?? 'UTC',
        ...(include === '' || include === undefined ? {} : { include }),
      };
    });
  }

  async hasCoverage(coverage: AgendaCoverage): Promise<boolean> {
    return (
      (await this.reader.first(
        `SELECT 1 AS found FROM agenda_coverage
         WHERE from_date = ? AND to_date = ? AND timezone = ? AND include_key = ?;`,
        [coverage.from, coverage.to, coverage.timezone, includeKey(coverage.include)],
      )) !== undefined
    );
  }

  async installCanonical(
    transaction: TransactionContext,
    request: AgendaQuery,
    data: AgendaData,
    refreshedAt: string = systemClock.now(),
  ): Promise<void> {
    const guards = await readCanonicalOutboxGuards(transaction.database);
    const coveredActivityIds = new Set<string>();
    const previousVersions = new Map<string, string>();
    for (const row of await transaction.database.all(
      `SELECT activity_id, canonical_version FROM agenda_rows
       WHERE viewer_date BETWEEN ? AND ?;`,
      [request.from, request.to],
    )) {
      const activityId = text(row, 'activity_id');
      if (activityId === undefined) continue;
      coveredActivityIds.add(activityId);
      const version = text(row, 'canonical_version');
      const previous = previousVersions.get(activityId);
      if (version !== undefined && (previous === undefined || version > previous)) {
        previousVersions.set(activityId, version);
      }
    }
    const versions = new Map(
      (data.projectionVersions ?? []).map((entry) => [entry.activityId, entry.version]),
    );
    const returnedActivityIds = new Set(
      data.days.flatMap((day) => itemsOf(day).map((item) => item.activityId)),
    );
    const staleActivityIds = new Set<string>();
    for (const activityId of returnedActivityIds) {
      const previous = previousVersions.get(activityId);
      const incoming = versions.get(activityId);
      if (previous !== undefined && (incoming === undefined || previous > incoming)) {
        staleActivityIds.add(activityId);
      }
    }
    const preservedActivityIds = new Set([
      ...guards.protectedActivityIds,
      ...staleActivityIds,
    ]);
    if (__DEV__) {
      console.info('native_agenda_install_guards', {
        request,
        returnedRows: data.days.reduce(
          (count, day) =>
            count + day.schedule.length + day.anytime.length + day.earlier.length,
          0,
        ),
        returnedActivities: returnedActivityIds.size,
        existingActivities: coveredActivityIds.size,
        protectedActivities: guards.protectedActivityIds.size,
        staleActivities: staleActivityIds.size,
        deletedActivities: guards.deletedActivityIds.size,
        reconcilingActivities: guards.reconcilingActivityIds.size,
      });
    }
    for (const activityId of coveredActivityIds) {
      if (preservedActivityIds.has(activityId)) continue;
      /* Absence is authoritative only inside this exact covered range. */
      await transaction.database.run(
        `DELETE FROM agenda_rows
         WHERE activity_id = ? AND viewer_date BETWEEN ? AND ?
           AND local_state = 'canonical';`,
        [activityId, request.from, request.to],
      );
    }
    await this.insertCanonicalDays(
      transaction.database,
      data.days,
      (item) => versions.get(item.activityId),
      new Set([...guards.deletedActivityIds, ...preservedActivityIds]),
    );
    for (const day of data.days) {
      for (const item of itemsOf(day)) {
        coveredActivityIds.add(item.activityId);
        if (preservedActivityIds.has(item.activityId)) continue;
        if (guards.deletedActivityIds.has(item.activityId)) continue;
        for (const reminder of item.reminders ?? []) {
          if (
            guards.deletedReminderIds.has(reminder.reminderId) ||
            guards.createdReminderIds.has(reminder.reminderId)
          ) {
            continue;
          }
          await transaction.database.run(
            `INSERT INTO activity_reminders (
              reminder_id, activity_id, owner_user_id, offset_minutes, channel, local_state
            ) VALUES (?, ?, ?, ?, 'push', 'canonical')
            ON CONFLICT(reminder_id) DO UPDATE SET
              activity_id=excluded.activity_id, owner_user_id=excluded.owner_user_id,
              offset_minutes=excluded.offset_minutes, local_state='canonical'
            WHERE activity_reminders.local_state = 'canonical';`,
            [
              reminder.reminderId,
              item.activityId,
              reminder.userId,
              reminder.offsetMinutes,
            ],
          );
        }
      }
    }
    if (request.include?.split(',').includes('reminders') === true) {
      const returnedReminderIds = new Set(
        data.days.flatMap((day) =>
          itemsOf(day).flatMap((item) =>
            (item.reminders ?? []).map((reminder) => reminder.reminderId),
          ),
        ),
      );
      for (const activityId of coveredActivityIds) {
        if (preservedActivityIds.has(activityId)) continue;
        if (guards.deletedActivityIds.has(activityId)) {
          await transaction.database.run(
            'DELETE FROM activity_reminders WHERE activity_id = ?;',
            [activityId],
          );
          continue;
        }
        const canonical = await transaction.database.all(
          `SELECT reminder_id FROM activity_reminders
           WHERE activity_id = ? AND local_state = 'canonical';`,
          [activityId],
        );
        for (const row of canonical) {
          const reminderId = text(row, 'reminder_id');
          if (reminderId !== undefined && !returnedReminderIds.has(reminderId)) {
            await transaction.database.run(
              "DELETE FROM activity_reminders WHERE reminder_id = ? AND local_state = 'canonical';",
              [reminderId],
            );
          }
        }
      }
    }
    await transaction.database.run(
      `INSERT INTO agenda_coverage (
        from_date, to_date, timezone, include_key, refreshed_at,
        warnings_json, projection_versions_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(from_date, to_date, timezone, include_key) DO UPDATE SET
        refreshed_at=excluded.refreshed_at, warnings_json=excluded.warnings_json,
        projection_versions_json=excluded.projection_versions_json;`,
      [
        request.from,
        request.to,
        request.tz,
        includeKey(request.include),
        refreshedAt,
        JSON.stringify(data.warnings),
        (() => {
          if (data.projectionVersions === undefined && staleActivityIds.size === 0) {
            return null;
          }
          const installedVersions = new Map(versions);
          for (const activityId of staleActivityIds) {
            const previous = previousVersions.get(activityId);
            if (previous !== undefined) installedVersions.set(activityId, previous);
          }
          return JSON.stringify(
            [...installedVersions].map(([activityId, version]) => ({
              activityId,
              version,
            })),
          );
        })(),
      ],
    );
    if (guards.reconcilingActivityIds.size === 0) {
      await transaction.database.run('DELETE FROM native_sync_errors WHERE scope = ?;', [
        this.scope({
          from: request.from,
          to: request.to,
          timezone: request.tz,
          ...(request.include === undefined ? {} : { include: request.include }),
        }),
      ]);
    }
    transaction.changed('agenda');
    if (request.include?.split(',').includes('reminders') === true) {
      transaction.changed('reminders');
    }
  }

  async replaceLocalActivityRows(
    transaction: TransactionContext,
    activityId: string,
    data: AgendaData,
    state: 'queued' | 'updating' | 'needs_attention' = 'queued',
  ): Promise<void> {
    await transaction.database.run('DELETE FROM agenda_rows WHERE activity_id = ?;', [
      activityId,
    ]);
    const onlyActivityDays = data.days.map<AgendaDay>((day) => ({
      date: day.date,
      schedule: day.schedule.filter((item) => item.activityId === activityId),
      anytime: day.anytime.filter((item) => item.activityId === activityId),
      earlier: day.earlier.filter((item) => item.activityId === activityId),
      ...(day.upNext?.activityId === activityId ? { upNext: day.upNext } : {}),
    }));
    await this.insertMaterializedDays(
      transaction.database,
      onlyActivityDays,
      state,
      () => undefined,
    );
    transaction.changed('agenda');
  }

  /**
   * Reads the one materialized day needed to project an explicit Activity/occurrence action.
   *
   * Completion and Undo used to read every retained coverage day, then rewrite every row for
   * the Activity. The target identity first narrows this to one viewer day; reading the rest of
   * that day preserves section ordering and `upNext` without making a one-row action scale with
   * the 62-day recurrence window.
   */
  async readMaterializedTargetDay(
    database: SqliteReader,
    activityId: string,
    occurrenceDate?: string,
  ): Promise<AgendaData> {
    const target = await database.first(
      `SELECT viewer_date FROM agenda_rows
       WHERE activity_id = ? AND occurrence_date IS ?
       ORDER BY viewer_date
       LIMIT 1;`,
      [activityId, occurrenceDate ?? null],
    );
    const date = target === undefined ? undefined : text(target, 'viewer_date');
    if (date === undefined) return { days: [], warnings: [] };
    return this.readWith(database, { from: date, to: date, timezone: 'UTC' });
  }

  /** Replaces only one explicit materialized identity after its local transaction commits. */
  async replaceLocalTargetRows(
    transaction: TransactionContext,
    activityId: string,
    occurrenceDate: string | undefined,
    data: AgendaData,
    state: 'queued' | 'needs_attention' = 'queued',
  ): Promise<void> {
    await transaction.database.run(
      'DELETE FROM agenda_rows WHERE activity_id = ? AND occurrence_date IS ?;',
      [activityId, occurrenceDate ?? null],
    );
    const isTarget = (item: AgendaItem): boolean =>
      item.activityId === activityId && item.occurrenceDate === occurrenceDate;
    const targetDays = data.days.map<AgendaDay>((day) => ({
      date: day.date,
      schedule: day.schedule.filter(isTarget),
      anytime: day.anytime.filter(isTarget),
      earlier: day.earlier.filter(isTarget),
      ...(day.upNext !== undefined && isTarget(day.upNext) ? { upNext: day.upNext } : {}),
    }));
    await this.insertMaterializedDays(
      transaction.database,
      targetDays,
      state,
      () => undefined,
    );
    transaction.changed('agenda');
  }

  /** Strongly replaces one Activity inside one materialized coverage, including zero rows. */
  async replaceCanonicalActivityRows(
    transaction: TransactionContext,
    request: AgendaQuery,
    canonical: ActivityAgendaData,
    clock: { readonly today: string; readonly currentMinute: string },
  ): Promise<void> {
    await transaction.database.run(
      `DELETE FROM agenda_rows
       WHERE activity_id = ? AND viewer_date BETWEEN ? AND ?;`,
      [canonical.activityId, request.from, request.to],
    );
    const itemsByDate = new Map<string, AgendaItem[]>();
    for (const row of canonical.rows) {
      if (
        row.item.activityId !== canonical.activityId ||
        row.date < request.from ||
        row.date > request.to
      ) {
        continue;
      }
      const items = itemsByDate.get(row.date) ?? [];
      items.push(row.item);
      itemsByDate.set(row.date, items);
    }
    for (const [date, items] of itemsByDate) {
      const sections = partitionAgenda(
        items,
        date < clock.today ? '23:59' : date > clock.today ? '00:00' : clock.currentMinute,
        true,
      );
      await this.insertDay(
        transaction.database,
        {
          date,
          schedule: sections.schedule,
          anytime: sections.anytime,
          earlier: sections.earlier,
          ...(sections.upNext[0] === undefined ? {} : { upNext: sections.upNext[0] }),
        },
        'canonical',
        () => canonical.activityVersion,
        false,
      );
    }
    transaction.changed('agenda');
  }

  async markActivityRows(
    transaction: TransactionContext,
    activityId: string,
    state: 'queued' | 'updating' | 'needs_attention',
  ): Promise<void> {
    await transaction.database.run(
      'UPDATE agenda_rows SET local_state = ? WHERE activity_id = ?;',
      [state, activityId],
    );
    transaction.changed('agenda');
  }

  async acceptCanonicalOccurrence(
    transaction: TransactionContext,
    activity: Activity,
    projection: OccurrenceDetailProjection,
  ): Promise<void> {
    await transaction.database.run(
      `UPDATE agenda_rows SET
         row_id = ?, viewer_date = ?, status = ?, time = ?, end_time = ?,
         is_snoozed = ?, local_state = 'canonical', canonical_version = ?
       WHERE activity_id = ? AND occurrence_date = ?;`,
      [
        rowIdFromParts(projection.date, activity.activityId, projection.nominalDate),
        projection.date,
        projection.status,
        projection.time ?? null,
        projection.endTime ?? null,
        projection.isSnoozed ? 1 : 0,
        activity.updatedAt,
        activity.activityId,
        projection.nominalDate,
      ],
    );
    transaction.changed('agenda');
  }

  async readMaterializedWindow(
    database: SqliteReader = this.reader,
  ): Promise<AgendaData> {
    const bounds = await database.first(
      'SELECT MIN(from_date) AS from_date, MAX(to_date) AS to_date FROM agenda_coverage;',
    );
    const from = bounds === undefined ? undefined : text(bounds, 'from_date');
    const to = bounds === undefined ? undefined : text(bounds, 'to_date');
    if (from === undefined || to === undefined) return { days: [], warnings: [] };
    return this.readWith(database, { from, to, timezone: 'UTC' });
  }

  async recordSyncError(
    transaction: TransactionContext,
    coverage: AgendaCoverage,
    message: string,
  ): Promise<void> {
    await transaction.database.run(
      `INSERT INTO native_sync_errors (scope, message, retryable, recorded_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(scope) DO UPDATE SET message=excluded.message,
         retryable=1, recorded_at=excluded.recorded_at;`,
      [this.scope(coverage), message, systemClock.now()],
    );
    transaction.changed('agenda');
  }

  async syncError(coverage: AgendaCoverage): Promise<string | undefined> {
    const row = await this.reader.first(
      'SELECT message FROM native_sync_errors WHERE scope = ?;',
      [this.scope(coverage)],
    );
    return row === undefined ? undefined : text(row, 'message');
  }

  private async readWith(
    database: SqliteReader,
    coverage: AgendaCoverage,
  ): Promise<AgendaData> {
    const rows = await database.all(
      `SELECT * FROM agenda_rows
       WHERE viewer_date BETWEEN ? AND ?
       ORDER BY viewer_date, section, sort_order, activity_id;`,
      [coverage.from, coverage.to],
    );
    const byDate = new Map<string, AgendaDay>();
    for (let date = coverage.from; date <= coverage.to; date = addWallDays(date, 1)) {
      byDate.set(date, { date, schedule: [], anytime: [], earlier: [] });
    }
    for (const row of rows) {
      const date = text(row, 'viewer_date');
      const section = text(row, 'section');
      if (date === undefined || section === undefined) continue;
      const day = byDate.get(date);
      if (day === undefined) continue;
      const item = itemFromRow(row);
      if (section === 'schedule') day.schedule.push(item);
      else if (section === 'anytime') day.anytime.push(item);
      else if (section === 'earlier') day.earlier.push(item);
    }
    const days = [...byDate.values()].map((day) => {
      const upNext = day.schedule.find((item) =>
        rows.some(
          (row) =>
            text(row, 'viewer_date') === day.date &&
            text(row, 'activity_id') === item.activityId &&
            text(row, 'occurrence_date') === item.occurrenceDate &&
            number(row, 'is_up_next') === 1,
        ),
      );
      return upNext === undefined ? day : { ...day, upNext };
    });
    const metadata = await database.first(
      `SELECT warnings_json, projection_versions_json FROM agenda_coverage
       WHERE from_date = ? AND to_date = ? AND timezone = ? AND include_key = ?;`,
      [coverage.from, coverage.to, coverage.timezone, includeKey(coverage.include)],
    );
    return {
      days,
      warnings: json(text(metadata ?? {}, 'warnings_json'), []),
      ...(text(metadata ?? {}, 'projection_versions_json') === undefined
        ? {}
        : {
            projectionVersions: json(
              text(metadata ?? {}, 'projection_versions_json'),
              [],
            ),
          }),
    };
  }

  private async insertDay(
    database: SqliteExecutor,
    day: AgendaDay,
    state: 'canonical' | 'queued' | 'updating' | 'needs_attention',
    version: (item: AgendaItem) => string | undefined,
    preserveLocal: boolean,
    suppressedActivityIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const sections = [
      ['schedule', day.schedule],
      ['anytime', day.anytime],
      ['earlier', day.earlier],
    ] as const;
    const upNextIdentity =
      day.upNext === undefined
        ? undefined
        : occurrenceIdentity(day.upNext.activityId, day.upNext.occurrenceDate);
    for (const [section, items] of sections) {
      for (const [order, item] of items.entries()) {
        if (suppressedActivityIds.has(item.activityId)) continue;
        if (preserveLocal) {
          const existing = await database.first(
            'SELECT local_state, canonical_version FROM agenda_rows WHERE row_id = ?;',
            [rowId(day.date, item)],
          );
          if (existing !== undefined && text(existing, 'local_state') !== 'canonical')
            continue;
          const previousVersion =
            existing === undefined ? undefined : text(existing, 'canonical_version');
          const nextVersion = version(item);
          if (
            previousVersion !== undefined &&
            nextVersion !== undefined &&
            previousVersion > nextVersion
          ) {
            continue;
          }
          await database.run('DELETE FROM agenda_rows WHERE row_id = ?;', [
            rowId(day.date, item),
          ]);
        }
        await database.run(
          INSERT_ROW,
          itemValues(
            day.date,
            section,
            order,
            item,
            state,
            occurrenceIdentity(item.activityId, item.occurrenceDate) === upNextIdentity,
            version(item),
          ),
        );
      }
    }
  }

  private async insertCanonicalDays(
    database: SqliteExecutor,
    days: readonly AgendaDay[],
    version: (item: AgendaItem) => string | undefined,
    suppressedActivityIds: ReadonlySet<string>,
  ): Promise<void> {
    await this.insertMaterializedDays(
      database,
      days,
      'canonical',
      version,
      suppressedActivityIds,
    );
  }

  /** Inserts already-materialized rows in bounded bridge calls after their owner deleted them. */
  private async insertMaterializedDays(
    database: SqliteExecutor,
    days: readonly AgendaDay[],
    state: 'canonical' | 'queued' | 'updating' | 'needs_attention',
    version: (item: AgendaItem) => string | undefined,
    suppressedActivityIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const rows: Array<readonly (string | number | null)[]> = [];
    for (const day of days) {
      const sections = [
        ['schedule', day.schedule],
        ['anytime', day.anytime],
        ['earlier', day.earlier],
      ] as const;
      const upNextIdentity =
        day.upNext === undefined
          ? undefined
          : occurrenceIdentity(day.upNext.activityId, day.upNext.occurrenceDate);
      for (const [section, items] of sections) {
        for (const [order, item] of items.entries()) {
          if (suppressedActivityIds.has(item.activityId)) continue;
          rows.push(
            itemValues(
              day.date,
              section,
              order,
              item,
              state,
              occurrenceIdentity(item.activityId, item.occurrenceDate) === upNextIdentity,
              version(item),
            ),
          );
        }
      }
    }
    for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK_SIZE) {
      const chunk = rows.slice(offset, offset + INSERT_CHUNK_SIZE);
      await database.run(
        `INSERT INTO agenda_rows (${AGENDA_ROW_COLUMNS}) VALUES ${chunk
          .map(() => `(${AGENDA_ROW_PLACEHOLDERS})`)
          .join(', ')} ON CONFLICT DO NOTHING;`,
        chunk.flat(),
      );
    }
  }
}
