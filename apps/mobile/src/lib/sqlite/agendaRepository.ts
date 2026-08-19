import { addWallDays } from '@od/shared/recurrence';
import type { AgendaQuery } from '@od/shared/schemas';
import { agendaItem as agendaItemSchema } from '@od/shared/schemas';
import type {
  Activity,
  AgendaData,
  AgendaDay,
  AgendaItem,
  OccurrenceDetailProjection,
} from '@od/shared/types';
import type { SqliteExecutor, SqliteReader, SqliteRow } from '@/lib/sqlite/database';
import { readCanonicalOutboxGuards } from '@/lib/sqlite/outbox';
import type { RepositorySubscriptions } from '@/lib/sqlite/subscriptions';
import type { TransactionContext } from '@/lib/sqlite/transaction';

export interface AgendaCoverage {
  readonly from: string;
  readonly to: string;
  readonly timezone: string;
  readonly include?: string;
}

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

function rowId(date: string, item: AgendaItem): string {
  return `${date}\u0000${item.activityId}\u0000${item.occurrenceDate ?? ''}`;
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

const INSERT_ROW = `INSERT INTO agenda_rows (
  row_id, viewer_date, section, sort_order, is_up_next, activity_id, occurrence_date,
  parent_activity_id, type, title, status, time, end_time, is_recurring,
  recurrence_description, is_snoozed, original_time, has_checkbox,
  capabilities_json, participant_avatars_json, participant_count, location_label,
  subtitle, note_excerpt, is_past, overdue_from_date, local_state, canonical_version
) VALUES (${Array.from({ length: 28 }, () => '?').join(', ')});`;

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
    refreshedAt = new Date().toISOString(),
  ): Promise<void> {
    const guards = await readCanonicalOutboxGuards(transaction.database);
    const coveredActivityIds = new Set<string>();
    for (const row of await transaction.database.all(
      'SELECT DISTINCT activity_id FROM agenda_rows WHERE viewer_date BETWEEN ? AND ?;',
      [request.from, request.to],
    )) {
      const activityId = text(row, 'activity_id');
      if (activityId !== undefined) coveredActivityIds.add(activityId);
    }
    await transaction.database.run(
      `DELETE FROM agenda_rows
       WHERE viewer_date BETWEEN ? AND ? AND local_state = 'canonical';`,
      [request.from, request.to],
    );
    const versions = new Map(
      (data.projectionVersions ?? []).map((entry) => [entry.activityId, entry.version]),
    );
    for (const day of data.days) {
      await this.insertDay(
        transaction.database,
        day,
        'canonical',
        (item) => versions.get(item.activityId),
        true,
        guards.deletedActivityIds,
      );
      for (const item of [
        ...(day.upNext === undefined ? [] : [day.upNext]),
        ...day.schedule,
        ...day.anytime,
        ...day.earlier,
      ]) {
        coveredActivityIds.add(item.activityId);
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
          [
            ...(day.upNext === undefined ? [] : [day.upNext]),
            ...day.schedule,
            ...day.anytime,
            ...day.earlier,
          ].flatMap((item) =>
            (item.reminders ?? []).map((reminder) => reminder.reminderId),
          ),
        ),
      );
      for (const activityId of coveredActivityIds) {
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
        data.projectionVersions === undefined
          ? null
          : JSON.stringify(data.projectionVersions),
      ],
    );
    await transaction.database.run('DELETE FROM native_sync_errors WHERE scope = ?;', [
      this.scope({
        from: request.from,
        to: request.to,
        timezone: request.tz,
        ...(request.include === undefined ? {} : { include: request.include }),
      }),
    ]);
    transaction.changed('agenda');
    if (request.include === 'reminders') transaction.changed('reminders');
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
    for (const day of data.days) {
      const onlyActivity: AgendaDay = {
        date: day.date,
        schedule: day.schedule.filter((item) => item.activityId === activityId),
        anytime: day.anytime.filter((item) => item.activityId === activityId),
        earlier: day.earlier.filter((item) => item.activityId === activityId),
        ...(day.upNext?.activityId === activityId ? { upNext: day.upNext } : {}),
      };
      await this.insertDay(
        transaction.database,
        onlyActivity,
        state,
        () => undefined,
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
        `${projection.date}\u0000${activity.activityId}\u0000${projection.nominalDate}`,
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
      [this.scope(coverage), message, new Date().toISOString()],
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
        : `${day.upNext.activityId}\u0000${day.upNext.occurrenceDate ?? ''}`;
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
            `${item.activityId}\u0000${item.occurrenceDate ?? ''}` === upNextIdentity,
            version(item),
          ),
        );
      }
    }
  }
}
