import type { PatchActivityInput, ScheduleActivityInput } from '@od/shared/schemas';
import { activity as activitySchema } from '@od/shared/schemas';
import type {
  Activity,
  ActivityDetail,
  ActivityDetailTarget,
  Reminder,
} from '@od/shared/types';
import type { SqliteExecutor, SqliteReader, SqliteRow } from '@/lib/sqlite/database';
import type { RepositorySubscriptions } from '@/lib/sqlite/subscriptions';
import type { TransactionContext } from '@/lib/sqlite/transaction';

export type NativeRowState = 'canonical' | 'queued' | 'updating' | 'needs_attention';

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

function valuesFor(
  activity: Activity,
  detail?: ActivityDetail,
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
    activity.updatedAt,
  ];
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

  async read(target: ActivityDetailTarget): Promise<ActivityDetail | undefined> {
    const row = await this.reader.first(
      'SELECT * FROM activities WHERE activity_id = ?;',
      [target.activityId],
    );
    if (row === undefined) return undefined;
    const reminders = await this.readReminders(target.activityId);
    const capabilities = json<ActivityDetail['capabilities']>(
      text(row, 'capabilities_json'),
    );
    const completedOccurrenceCount = number(row, 'completed_occurrence_count');
    const detail: ActivityDetail = {
      activity: activityFromRow(row),
      reminders,
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(completedOccurrenceCount === undefined ? {} : { completedOccurrenceCount }),
    };
    if (target.kind === 'activity') return detail;
    const occurrence = await this.reader.first(
      'SELECT * FROM activity_occurrences WHERE activity_id = ? AND nominal_date = ?;',
      [target.activityId, target.date],
    );
    const occurrenceTime =
      occurrence === undefined ? undefined : text(occurrence, 'time');
    const occurrenceEndTime =
      occurrence === undefined ? undefined : text(occurrence, 'end_time');
    const occurrenceCompletedAt =
      occurrence === undefined ? undefined : text(occurrence, 'completed_at');
    return occurrence === undefined
      ? detail
      : {
          ...detail,
          occurrence: {
            nominalDate: target.date,
            date: text(occurrence, 'viewer_date') ?? target.date,
            ...(occurrenceTime === undefined ? {} : { time: occurrenceTime }),
            ...(occurrenceEndTime === undefined ? {} : { endTime: occurrenceEndTime }),
            status: text(occurrence, 'status') as NonNullable<
              ActivityDetail['occurrence']
            >['status'],
            isSnoozed: number(occurrence, 'is_snoozed') === 1,
            ...(occurrenceCompletedAt === undefined
              ? {}
              : { completedAt: occurrenceCompletedAt }),
          },
        };
  }

  async putCanonical(
    transaction: TransactionContext,
    detail: ActivityDetail,
  ): Promise<boolean> {
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
      valuesFor(detail.activity, detail),
    );
    await this.replaceReminders(
      transaction.database,
      detail.activity.activityId,
      detail.reminders,
    );
    transaction.changed(this.scope(detail.activity.activityId));
    transaction.changed('reminders');
    return true;
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
      [...valuesFor(activity), state],
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

  async acceptCanonicalResponse(
    transaction: TransactionContext,
    activity: Activity,
  ): Promise<void> {
    const current = await this.readWithin(transaction.database, activity.activityId);
    await transaction.database.run(
      "UPDATE activities SET local_state = 'canonical' WHERE activity_id = ?;",
      [activity.activityId],
    );
    await this.putCanonical(transaction, {
      activity,
      reminders: current?.reminders ?? [],
      ...(current?.capabilities === undefined
        ? {}
        : { capabilities: current.capabilities }),
      ...(current?.completedOccurrenceCount === undefined
        ? {}
        : { completedOccurrenceCount: current.completedOccurrenceCount }),
    });
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
  ): Promise<void> {
    await database.run('DELETE FROM activity_reminders WHERE activity_id = ?;', [
      activityId,
    ]);
    for (const reminder of reminders) {
      await database.run(
        `INSERT INTO activity_reminders
          (reminder_id, activity_id, owner_user_id, offset_minutes, channel, local_state)
         VALUES (?, ?, ?, ?, 'push', ?);`,
        [reminder.reminderId, activityId, reminder.userId, reminder.offsetMinutes, state],
      );
    }
  }
}
