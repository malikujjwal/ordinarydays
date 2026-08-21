import type { PatchActivityInput, ScheduleActivityInput } from '@od/shared/schemas';
import { activity as activitySchema } from '@od/shared/schemas';
import { systemClock } from '@od/shared/time';
import type {
  Activity,
  ActivityDetail,
  ActivityDetailTarget,
  Occurrence,
  OccurrenceDetailProjection,
  Reminder,
} from '@od/shared/types';
import type { SqliteExecutor, SqliteReader, SqliteRow } from '@/lib/sqlite/database';
import { projectionFromCanonicalOccurrence } from '@/lib/sqlite/occurrenceMaterialization';
import { readCanonicalOutboxGuards } from '@/lib/sqlite/outbox';
import type { RepositorySubscriptions } from '@/lib/sqlite/subscriptions';
import type { TransactionContext } from '@/lib/sqlite/transaction';

export type NativeRowState = 'canonical' | 'queued' | 'updating' | 'needs_attention';

export type CapabilityHydrationState = 'installed' | 'missing' | 'deferred';

function text(row: SqliteRow, column: string): string | undefined {
  const value = row[column];
  return typeof value === 'string' ? value : undefined;
}

function number(row: SqliteRow, column: string): number | undefined {
  const value = row[column];
  return typeof value === 'number' ? value : undefined;
}

function json<T>(value: string | undefined): T | undefined {
  return value === undefined ? undefined : (JSON.parse(value) as T);
}

function activityFromRow(row: SqliteRow): Activity {
  const scheduleDate = text(row, 'schedule_date');
  return activitySchema.parse({
    activityId: text(row, 'activity_id'),
    ownerId: text(row, 'owner_id'),
    objectKind: text(row, 'object_kind'),
    type: text(row, 'type'),
    status: text(row, 'status'),
    title: text(row, 'title'),
    ...(text(row, 'notes') === undefined ? {} : { notes: text(row, 'notes') }),
    ...(scheduleDate === undefined
      ? {}
      : {
          schedule: {
            date: scheduleDate,
            timezone: text(row, 'schedule_timezone'),
            ...(text(row, 'schedule_time') === undefined
              ? {}
              : { time: text(row, 'schedule_time') }),
            ...(text(row, 'schedule_end_time') === undefined
              ? {}
              : { endTime: text(row, 'schedule_end_time') }),
            ...(text(row, 'scheduled_at_utc') === undefined
              ? {}
              : { scheduledAtUtc: text(row, 'scheduled_at_utc') }),
            ...(text(row, 'end_at_utc') === undefined
              ? {}
              : { endAtUtc: text(row, 'end_at_utc') }),
          },
        }),
    ...(text(row, 'recurrence_json') === undefined
      ? {}
      : { recurrence: json(text(row, 'recurrence_json')) }),
    ...(text(row, 'location_json') === undefined
      ? {}
      : { location: json(text(row, 'location_json')) }),
    ...(text(row, 'parent_activity_id') === undefined
      ? {}
      : { parentActivityId: text(row, 'parent_activity_id') }),
    ...(text(row, 'list_item_id') === undefined
      ? {}
      : { listItemId: text(row, 'list_item_id') }),
    ...(text(row, 'list_id') === undefined ? {} : { listId: text(row, 'list_id') }),
    ...(text(row, 'source_url') === undefined
      ? {}
      : { sourceUrl: text(row, 'source_url') }),
    ...(text(row, 'primary_attachment_id') === undefined
      ? {}
      : { primaryAttachmentId: text(row, 'primary_attachment_id') }),
    participantCount: number(row, 'participant_count'),
    childCount: number(row, 'child_count'),
    expenseTotalCents: number(row, 'expense_total_cents'),
    visibility: text(row, 'visibility'),
    details: json(text(row, 'details_json')),
    ...(text(row, 'completed_at') === undefined
      ? {}
      : { completedAt: text(row, 'completed_at') }),
    ...(text(row, 'snoozed_until') === undefined
      ? {}
      : { snoozedUntil: text(row, 'snoozed_until') }),
    ...(text(row, 'outcome') === undefined ? {} : { outcome: text(row, 'outcome') }),
    icsSequence: number(row, 'ics_sequence'),
    createdAt: text(row, 'created_at'),
    lastActivityAt: text(row, 'last_activity_at'),
    updatedAt: text(row, 'updated_at'),
    schemaVersion: number(row, 'schema_version'),
  }) as Activity;
}

function occurrenceFromRow(row: SqliteRow): OccurrenceDetailProjection {
  const time = text(row, 'time');
  const endTime = text(row, 'end_time');
  const completedAt = text(row, 'completed_at');
  return {
    nominalDate: text(row, 'nominal_date') ?? '',
    date: text(row, 'viewer_date') ?? '',
    ...(time === undefined ? {} : { time }),
    ...(endTime === undefined ? {} : { endTime }),
    status: text(row, 'status') as OccurrenceDetailProjection['status'],
    isSnoozed: number(row, 'is_snoozed') === 1,
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function occurrenceFromAgendaRow(row: SqliteRow): OccurrenceDetailProjection {
  const time = text(row, 'time');
  const endTime = text(row, 'end_time');
  return {
    nominalDate: text(row, 'occurrence_date') ?? '',
    date: text(row, 'viewer_date') ?? '',
    ...(time === undefined ? {} : { time }),
    ...(endTime === undefined ? {} : { endTime }),
    status: text(row, 'status') as OccurrenceDetailProjection['status'],
    isSnoozed: number(row, 'is_snoozed') === 1,
  };
}

function activityValues(
  activity: Activity,
  detail: ActivityDetail | undefined,
  canonicalVersion: string | null,
): readonly (string | number | null)[] {
  return [
    activity.activityId,
    activity.ownerId,
    activity.objectKind,
    activity.type,
    activity.status,
    activity.title,
    activity.notes ?? null,
    activity.schedule?.date ?? null,
    activity.schedule?.time ?? null,
    activity.schedule?.endTime ?? null,
    activity.schedule?.timezone ?? null,
    activity.schedule?.scheduledAtUtc ?? null,
    activity.schedule?.endAtUtc ?? null,
    activity.recurrence === undefined ? null : JSON.stringify(activity.recurrence),
    activity.location === undefined ? null : JSON.stringify(activity.location),
    activity.parentActivityId ?? null,
    activity.listItemId ?? null,
    activity.listId ?? null,
    activity.sourceUrl ?? null,
    activity.primaryAttachmentId ?? null,
    activity.participantCount,
    activity.childCount,
    activity.expenseTotalCents,
    activity.visibility,
    JSON.stringify(activity.details),
    activity.completedAt ?? null,
    activity.snoozedUntil ?? null,
    activity.outcome ?? null,
    activity.icsSequence,
    activity.createdAt,
    activity.lastActivityAt,
    activity.updatedAt,
    activity.schemaVersion,
    detail?.capabilities === undefined ? null : JSON.stringify(detail.capabilities),
    detail?.completedOccurrenceCount ?? null,
    canonicalVersion,
  ];
}

/** Local projections never manufacture a server-authored canonical version. */
function localActivityValues(activity: Activity): readonly (string | number | null)[] {
  return activityValues(activity, undefined, null);
}

/** Canonical installers explicitly source their fence from the server response. */
function canonicalActivityValues(
  detail: ActivityDetail,
): readonly (string | number | null)[] {
  return activityValues(detail.activity, detail, detail.activity.updatedAt);
}

const ACTIVITY_COLUMNS = `
  activity_id, owner_id, object_kind, type, status, title, notes,
  schedule_date, schedule_time, schedule_end_time, schedule_timezone,
  scheduled_at_utc, end_at_utc, recurrence_json, location_json,
  parent_activity_id, list_item_id, list_id, source_url, primary_attachment_id,
  participant_count, child_count, expense_total_cents, visibility, details_json,
  completed_at, snoozed_until, outcome, ics_sequence, created_at, last_activity_at,
  updated_at, schema_version, capabilities_json, completed_occurrence_count,
  canonical_version
`;

const ACTIVITY_PLACEHOLDERS = Array.from({ length: 36 }, () => '?').join(', ');

export class ActivityRepository {
  constructor(
    private readonly reader: SqliteReader,
    private readonly subscriptions: RepositorySubscriptions,
  ) {}

  scope(activityId: string): string {
    return `activity:${activityId}`;
  }

  subscribe(activityId: string, listener: () => void): () => void {
    return this.subscriptions.subscribe(this.scope(activityId), listener);
  }

  version(activityId: string): number {
    return this.subscriptions.version(this.scope(activityId));
  }

  /** Whether a server-authored authorisation projection has ever been installed. */
  async hasInstalledCapabilities(activityId: string): Promise<boolean> {
    const row = await this.reader.first(
      'SELECT capabilities_json FROM activities WHERE activity_id = ?;',
      [activityId],
    );
    return row !== undefined && text(row, 'capabilities_json') !== undefined;
  }

  /**
   * Presentation-only readiness check for targeted capability hydration.
   *
   * Capability provenance and local projection state are deliberately separate: an edit
   * preserves already-installed capabilities, while a genuinely missing projection must wait
   * until the same guards used by canonical installation no longer protect local work.
   */
  async capabilityHydrationState(activityId: string): Promise<CapabilityHydrationState> {
    const row = await this.reader.first(
      'SELECT capabilities_json, local_state FROM activities WHERE activity_id = ?;',
      [activityId],
    );
    if (row !== undefined && text(row, 'capabilities_json') !== undefined) {
      return 'installed';
    }
    if (row !== undefined && text(row, 'local_state') !== 'canonical') {
      return 'deferred';
    }
    const guards = await readCanonicalOutboxGuards(this.reader);
    return guards.protectedActivityIds.has(activityId) ||
      guards.reconcilingActivityIds.has(activityId)
      ? 'deferred'
      : 'missing';
  }

  async read(target: ActivityDetailTarget): Promise<ActivityDetail | undefined> {
    const row = await this.reader.first(
      'SELECT * FROM activities WHERE activity_id = ?;',
      [target.activityId],
    );
    if (row === undefined) return undefined;
    const reminders = await this.readReminders(target.activityId);
    const storedCapabilities = json<ActivityDetail['capabilities']>(
      text(row, 'capabilities_json'),
    );
    const completedOccurrenceCount = number(row, 'completed_occurrence_count');
    if (target.kind === 'activity') {
      return {
        activity: activityFromRow(row),
        reminders,
        ...(storedCapabilities === undefined ? {} : { capabilities: storedCapabilities }),
        ...(completedOccurrenceCount === undefined ? {} : { completedOccurrenceCount }),
      };
    }
    const occurrenceRow = await this.reader.first(
      'SELECT * FROM activity_occurrences WHERE activity_id = ? AND nominal_date = ?;',
      [target.activityId, target.date],
    );
    /*
     * Agenda is already an authoritative materialized occurrence projection. A collection
     * pull can arrive before this occurrence's targeted detail read, so use that committed row
     * instead of falling back to the series anchor date and series-level capabilities.
     */
    const agendaRow = await this.reader.first(
      `SELECT * FROM agenda_rows
       WHERE activity_id = ? AND occurrence_date = ?
       ORDER BY CASE WHEN local_state = 'canonical' THEN 1 ELSE 0 END, viewer_date
       LIMIT 1;`,
      [target.activityId, target.date],
    );
    const occurrence =
      occurrenceRow === undefined
        ? agendaRow === undefined
          ? undefined
          : occurrenceFromAgendaRow(agendaRow)
        : occurrenceFromRow(occurrenceRow);
    const occurrenceCapabilities =
      agendaRow === undefined
        ? undefined
        : json<ActivityDetail['capabilities']>(text(agendaRow, 'capabilities_json'));
    const capabilities = occurrenceCapabilities ?? storedCapabilities;
    return {
      activity: activityFromRow(row),
      reminders,
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(completedOccurrenceCount === undefined ? {} : { completedOccurrenceCount }),
      ...(occurrence === undefined ? {} : { occurrence }),
    };
  }

  async putCanonical(
    transaction: TransactionContext,
    detail: ActivityDetail,
  ): Promise<boolean> {
    const guards = await readCanonicalOutboxGuards(transaction.database);
    if (guards.deletedActivityIds.has(detail.activity.activityId)) return false;
    const existing = await transaction.database.first(
      'SELECT canonical_version, local_state FROM activities WHERE activity_id = ?;',
      [detail.activity.activityId],
    );
    const existingVersion =
      existing === undefined ? undefined : text(existing, 'canonical_version');
    const localState = existing === undefined ? undefined : text(existing, 'local_state');
    if (existingVersion !== undefined && existingVersion > detail.activity.updatedAt)
      return false;
    if (localState !== undefined && localState !== 'canonical') return false;
    return this.installCanonicalDetail(transaction, detail, {
      preserveLocalReminders: true,
      guards,
    });
  }

  /**
   * Installs the exact authoritative Activity acknowledged by a durable write.
   *
   * The sync owner checks for a later intent before calling this operation. Unlike a
   * background detail pull, the row is expected to still be local because the acknowledged
   * intent owns that projection. The row becomes canonical only as part of the successful
   * authoritative upsert.
   */
  async installAcknowledgedActivity(
    transaction: TransactionContext,
    activity: Activity,
    enrichment?: ActivityDetail,
  ): Promise<boolean> {
    const current = await this.readWithin(transaction.database, activity.activityId);
    const usableEnrichment =
      enrichment?.activity.activityId === activity.activityId &&
      enrichment.activity.updatedAt >= activity.updatedAt
        ? enrichment
        : undefined;
    const authoritativeActivity = usableEnrichment?.activity ?? activity;
    const detail: ActivityDetail = {
      activity: authoritativeActivity,
      reminders: usableEnrichment?.reminders ?? current?.reminders ?? [],
      ...(usableEnrichment?.capabilities === undefined
        ? current?.capabilities === undefined
          ? {}
          : { capabilities: current.capabilities }
        : { capabilities: usableEnrichment.capabilities }),
      ...(usableEnrichment?.completedOccurrenceCount === undefined
        ? current?.completedOccurrenceCount === undefined
          ? {}
          : { completedOccurrenceCount: current.completedOccurrenceCount }
        : { completedOccurrenceCount: usableEnrichment.completedOccurrenceCount }),
      ...(usableEnrichment?.occurrence === undefined
        ? {}
        : { occurrence: usableEnrichment.occurrence }),
    };
    return this.installCanonicalDetail(transaction, detail, {
      preserveLocalReminders: false,
    });
  }

  /** Restores server truth after a permanent rejection without bypassing via local_state. */
  async restoreCanonicalAfterRejection(
    transaction: TransactionContext,
    detail: ActivityDetail,
  ): Promise<boolean> {
    return this.installCanonicalDetail(transaction, detail, {
      preserveLocalReminders: false,
    });
  }

  private async installCanonicalDetail(
    transaction: TransactionContext,
    detail: ActivityDetail,
    options: {
      readonly preserveLocalReminders: boolean;
      readonly guards?: Awaited<ReturnType<typeof readCanonicalOutboxGuards>>;
    },
  ): Promise<boolean> {
    const existing = await transaction.database.first(
      'SELECT canonical_version FROM activities WHERE activity_id = ?;',
      [detail.activity.activityId],
    );
    const existingVersion =
      existing === undefined ? undefined : text(existing, 'canonical_version');
    if (existingVersion !== undefined && existingVersion > detail.activity.updatedAt) {
      return false;
    }
    await transaction.database.run(
      `INSERT INTO activities (${ACTIVITY_COLUMNS}, local_state)
       VALUES (${ACTIVITY_PLACEHOLDERS}, 'canonical')
       ON CONFLICT(activity_id) DO UPDATE SET
         owner_id=excluded.owner_id, object_kind=excluded.object_kind, type=excluded.type,
         status=excluded.status, title=excluded.title, notes=excluded.notes,
         schedule_date=excluded.schedule_date, schedule_time=excluded.schedule_time,
         schedule_end_time=excluded.schedule_end_time,
         schedule_timezone=excluded.schedule_timezone,
         scheduled_at_utc=excluded.scheduled_at_utc, end_at_utc=excluded.end_at_utc,
         recurrence_json=excluded.recurrence_json, location_json=excluded.location_json,
         parent_activity_id=excluded.parent_activity_id, list_item_id=excluded.list_item_id,
         list_id=excluded.list_id, source_url=excluded.source_url,
         primary_attachment_id=excluded.primary_attachment_id,
         participant_count=excluded.participant_count, child_count=excluded.child_count,
         expense_total_cents=excluded.expense_total_cents, visibility=excluded.visibility,
         details_json=excluded.details_json, completed_at=excluded.completed_at,
         snoozed_until=excluded.snoozed_until, outcome=excluded.outcome,
         ics_sequence=excluded.ics_sequence, created_at=excluded.created_at,
         last_activity_at=excluded.last_activity_at, updated_at=excluded.updated_at,
         schema_version=excluded.schema_version, capabilities_json=excluded.capabilities_json,
         completed_occurrence_count=excluded.completed_occurrence_count,
         canonical_version=excluded.canonical_version, local_state='canonical';`,
      canonicalActivityValues(detail),
    );
    await this.replaceReminders(
      transaction.database,
      detail.activity.activityId,
      detail.reminders,
      'canonical',
      options.preserveLocalReminders,
    );
    if (detail.occurrence !== undefined) {
      const occurrenceKey = `${detail.activity.activityId}:${detail.occurrence.nominalDate}`;
      if (options.guards?.protectedOccurrenceKeys.has(occurrenceKey) !== true) {
        await this.putOccurrenceProjection(
          transaction.database,
          detail.activity,
          detail.occurrence,
        );
      }
    }
    transaction.changed(this.scope(detail.activity.activityId));
    transaction.changed('reminders');
    return true;
  }

  /** Applies an authoritative detail 404 without deleting unresolved local work. */
  async acceptCanonicalDeletion(
    transaction: TransactionContext,
    activityId: string,
  ): Promise<boolean> {
    const guards = await readCanonicalOutboxGuards(transaction.database);
    if (guards.protectedActivityIds.has(activityId)) return false;
    const existing = await transaction.database.first(
      'SELECT local_state FROM activities WHERE activity_id = ?;',
      [activityId],
    );
    if (existing !== undefined && text(existing, 'local_state') !== 'canonical') {
      return false;
    }
    await transaction.database.run(
      'DELETE FROM activity_reminders WHERE activity_id = ?;',
      [activityId],
    );
    await transaction.database.run(
      'DELETE FROM activity_occurrences WHERE activity_id = ?;',
      [activityId],
    );
    await transaction.database.run('DELETE FROM agenda_rows WHERE activity_id = ?;', [
      activityId,
    ]);
    await transaction.database.run('DELETE FROM activities WHERE activity_id = ?;', [
      activityId,
    ]);
    await this.recordTombstone(transaction.database, activityId, systemClock.now());
    transaction.changed(this.scope(activityId));
    transaction.changed('agenda');
    transaction.changed('reminders');
    return true;
  }

  /**
   * Append-once by design: the delete acknowledgement and an authoritative detail 404
   * record the same shape, and whichever lands second must be a no-op.
   */
  async recordTombstone(
    database: SqliteExecutor,
    activityId: string,
    acknowledgedAt: string,
  ): Promise<void> {
    await database.run(
      `INSERT OR IGNORE INTO activity_tombstones (activity_id, acknowledged_at)
       VALUES (?, ?);`,
      [activityId, acknowledgedAt],
    );
  }

  async putLocal(
    transaction: TransactionContext,
    activity: Activity,
    reminders: readonly Reminder[],
    state: NativeRowState = 'queued',
  ): Promise<void> {
    await transaction.database.run(
      `INSERT INTO activities (${ACTIVITY_COLUMNS}, local_state)
       VALUES (${ACTIVITY_PLACEHOLDERS}, ?)
       ON CONFLICT(activity_id) DO UPDATE SET
         status=excluded.status, title=excluded.title, notes=excluded.notes,
         schedule_date=excluded.schedule_date, schedule_time=excluded.schedule_time,
         schedule_end_time=excluded.schedule_end_time,
         schedule_timezone=excluded.schedule_timezone, recurrence_json=excluded.recurrence_json,
         location_json=excluded.location_json, details_json=excluded.details_json,
         completed_at=excluded.completed_at, snoozed_until=excluded.snoozed_until,
         outcome=excluded.outcome, updated_at=excluded.updated_at, local_state=excluded.local_state;`,
      [...localActivityValues(activity), state],
    );
    await this.replaceReminders(
      transaction.database,
      activity.activityId,
      reminders,
      state,
    );
    transaction.changed(this.scope(activity.activityId));
    transaction.changed('reminders');
  }

  async patchLocal(
    transaction: TransactionContext,
    activityId: string,
    input: PatchActivityInput,
    state: NativeRowState,
  ): Promise<Activity> {
    const detail = await this.readWithin(transaction.database, activityId);
    if (detail === undefined) throw new Error('No activity loaded to patch.');
    const current = detail.activity;
    const next = activitySchema.parse({
      ...current,
      ...input,
      ...(input.location === null ? { location: undefined } : {}),
      ...(input.sourceUrl === null ? { sourceUrl: undefined } : {}),
      ...(input.parentActivityId === null ? { parentActivityId: undefined } : {}),
      ...(input.recurrence === null ? { recurrence: undefined } : {}),
      updatedAt: current.updatedAt,
    }) as Activity;
    await this.putLocal(transaction, next, detail.reminders, state);
    return next;
  }

  async scheduleLocal(
    transaction: TransactionContext,
    activityId: string,
    input: ScheduleActivityInput,
  ): Promise<Activity> {
    const detail = await this.readWithin(transaction.database, activityId);
    if (detail === undefined) throw new Error('No activity loaded to schedule.');
    const { occurrenceDate: _occurrenceDate, ...schedule } = input;
    const next = activitySchema.parse({
      ...detail.activity,
      schedule: input.date === null ? undefined : schedule,
      snoozedUntil: undefined,
      status: input.date === null ? 'saved' : 'scheduled',
    }) as Activity;
    await this.putLocal(transaction, next, detail.reminders);
    return next;
  }

  async setLocalState(
    transaction: TransactionContext,
    activityId: string,
    state: NativeRowState,
  ): Promise<void> {
    await transaction.database.run(
      'UPDATE activities SET local_state = ? WHERE activity_id = ?;',
      [state, activityId],
    );
    transaction.changed(this.scope(activityId));
  }

  async acceptCanonicalOccurrence(
    transaction: TransactionContext,
    activity: Activity,
    nominalDate: string,
    occurrence: Occurrence | undefined,
    authoritative?: OccurrenceDetailProjection,
  ): Promise<OccurrenceDetailProjection> {
    const row = await transaction.database.first(
      'SELECT * FROM activity_occurrences WHERE activity_id = ? AND nominal_date = ?;',
      [activity.activityId, nominalDate],
    );
    const projection =
      authoritative ??
      projectionFromCanonicalOccurrence(
        activity,
        nominalDate,
        occurrence,
        row === undefined ? undefined : occurrenceFromRow(row),
      );
    if (projection.nominalDate !== nominalDate) {
      throw new Error('Canonical occurrence identity did not match the durable action.');
    }
    await this.putOccurrenceProjection(transaction.database, activity, projection);
    transaction.changed(this.scope(activity.activityId));
    return projection;
  }

  private async putOccurrenceProjection(
    database: SqliteExecutor,
    activity: Activity,
    projection: OccurrenceDetailProjection,
  ): Promise<void> {
    await database.run(
      `INSERT INTO activity_occurrences (
        activity_id, nominal_date, viewer_date, time, end_time, status,
        is_snoozed, completed_at, local_state, canonical_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'canonical', ?)
      ON CONFLICT(activity_id, nominal_date) DO UPDATE SET
        viewer_date=excluded.viewer_date, time=excluded.time, end_time=excluded.end_time,
        status=excluded.status, is_snoozed=excluded.is_snoozed,
        completed_at=excluded.completed_at, local_state='canonical',
        canonical_version=excluded.canonical_version;`,
      [
        activity.activityId,
        projection.nominalDate,
        projection.date,
        projection.time ?? null,
        projection.endTime ?? null,
        projection.status,
        projection.isSnoozed ? 1 : 0,
        projection.completedAt ?? null,
        activity.updatedAt,
      ],
    );
  }

  async setStatusLocal(
    transaction: TransactionContext,
    activityId: string,
    status: Activity['status'],
    outcome?: Activity['outcome'],
    completedAt?: string,
  ): Promise<void> {
    await transaction.database.run(
      `UPDATE activities SET status = ?, outcome = ?, completed_at = ?,
        local_state = 'queued' WHERE activity_id = ?;`,
      [status, outcome ?? null, completedAt ?? null, activityId],
    );
    transaction.changed(this.scope(activityId));
  }

  private async readWithin(
    database: SqliteReader,
    activityId: string,
  ): Promise<ActivityDetail | undefined> {
    const row = await database.first('SELECT * FROM activities WHERE activity_id = ?;', [
      activityId,
    ]);
    if (row === undefined) return undefined;
    const reminders = await this.readReminders(activityId, database);
    const capabilities = json<ActivityDetail['capabilities']>(
      text(row, 'capabilities_json'),
    );
    const completedOccurrenceCount = number(row, 'completed_occurrence_count');
    return {
      activity: activityFromRow(row),
      reminders,
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(completedOccurrenceCount === undefined ? {} : { completedOccurrenceCount }),
    };
  }

  private async readReminders(
    activityId: string,
    database: SqliteReader = this.reader,
  ): Promise<Reminder[]> {
    const rows = await database.all(
      'SELECT * FROM activity_reminders WHERE activity_id = ? ORDER BY reminder_id;',
      [activityId],
    );
    return rows.map((row) => ({
      reminderId: text(row, 'reminder_id') ?? '',
      activityId,
      userId: text(row, 'owner_user_id') ?? '',
      offsetMinutes: number(row, 'offset_minutes') ?? 0,
      channel: 'push',
    })) as Reminder[];
  }

  private async replaceReminders(
    database: SqliteExecutor,
    activityId: string,
    reminders: readonly Reminder[],
    state: NativeRowState = 'canonical',
    preserveLocal = false,
  ): Promise<void> {
    const guards = preserveLocal ? await readCanonicalOutboxGuards(database) : undefined;
    await database.run(
      preserveLocal
        ? "DELETE FROM activity_reminders WHERE activity_id = ? AND local_state = 'canonical';"
        : 'DELETE FROM activity_reminders WHERE activity_id = ?;',
      [activityId],
    );
    for (const reminder of reminders) {
      if (
        guards?.deletedReminderIds.has(reminder.reminderId) === true ||
        guards?.createdReminderIds.has(reminder.reminderId) === true
      ) {
        continue;
      }
      await database.run(
        `INSERT INTO activity_reminders
          (reminder_id, activity_id, owner_user_id, offset_minutes, channel, local_state)
         VALUES (?, ?, ?, ?, 'push', ?)
         ON CONFLICT(reminder_id) DO UPDATE SET
           activity_id=excluded.activity_id, owner_user_id=excluded.owner_user_id,
           offset_minutes=excluded.offset_minutes, local_state=excluded.local_state
         WHERE activity_reminders.local_state = 'canonical';`,
        [reminder.reminderId, activityId, reminder.userId, reminder.offsetMinutes, state],
      );
    }
  }
}
