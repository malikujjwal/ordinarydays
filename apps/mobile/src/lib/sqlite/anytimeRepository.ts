import { activityListItem } from '@od/shared/schemas';
import type { Activity, ActivityListItem } from '@od/shared/types';
import type { SqliteReader, SqliteRow } from '@/lib/sqlite/database';
import type { RevisionedProjectionReader } from '@/lib/sqlite/projectionReader';
import type {
  RepositoryInvalidationMetadata,
  RepositorySubscriptions,
} from '@/lib/sqlite/subscriptions';
import type { TransactionContext } from '@/lib/sqlite/transaction';

function text(row: SqliteRow, column: string): string | undefined {
  const value = row[column];
  return typeof value === 'string' ? value : undefined;
}

function number(row: SqliteRow, column: string): number {
  const value = row[column];
  return typeof value === 'number' ? value : 0;
}

function fromRow(row: SqliteRow): ActivityListItem {
  return activityListItem.parse({
    activityId: text(row, 'activity_id'),
    type: text(row, 'type'),
    title: text(row, 'title'),
    status: text(row, 'status'),
    ...(text(row, 'time') === undefined ? {} : { time: text(row, 'time') }),
    ...(text(row, 'end_time') === undefined ? {} : { endTime: text(row, 'end_time') }),
    isRecurring: number(row, 'is_recurring') === 1,
    participantCount: number(row, 'participant_count'),
    ...(text(row, 'location_label') === undefined
      ? {}
      : { locationLabel: text(row, 'location_label') }),
    ...(text(row, 'subtitle') === undefined ? {} : { subtitle: text(row, 'subtitle') }),
  }) as ActivityListItem;
}

function fromActivity(activity: Activity): ActivityListItem {
  return activityListItem.parse({
    activityId: activity.activityId,
    type: activity.type,
    title: activity.title,
    status: activity.status,
    ...(activity.schedule?.time === undefined ? {} : { time: activity.schedule.time }),
    ...(activity.schedule?.endTime === undefined
      ? {}
      : { endTime: activity.schedule.endTime }),
    isRecurring: activity.recurrence !== undefined,
    participantCount: activity.participantCount,
    ...(activity.location?.label === undefined
      ? {}
      : { locationLabel: activity.location.label }),
  }) as ActivityListItem;
}

function belongsInAnytime(activity: Activity): boolean {
  return (
    activity.objectKind === 'task' &&
    activity.status === 'saved' &&
    activity.schedule === undefined
  );
}

async function readAnytimeItems(
  reader: SqliteReader,
): Promise<readonly ActivityListItem[]> {
  const canonical = await reader.all('SELECT * FROM anytime_rows;');
  const rows = new Map<string, ActivityListItem>();
  for (const row of canonical) {
    const item = fromRow(row);
    rows.set(item.activityId, item);
  }
  const localActivities = await reader.all(
    `SELECT activity_id, object_kind, type, title, status, schedule_date,
            schedule_time AS time, schedule_end_time AS end_time,
            CASE WHEN recurrence_json IS NULL THEN 0 ELSE 1 END AS is_recurring,
            participant_count, json_extract(location_json, '$.label') AS location_label,
            NULL AS subtitle
     FROM activities
     WHERE local_state <> 'canonical';`,
  );
  for (const row of localActivities) {
    const activityId = text(row, 'activity_id');
    if (activityId === undefined) continue;
    const inAnytime =
      text(row, 'object_kind') === 'task' &&
      text(row, 'status') === 'saved' &&
      text(row, 'schedule_date') === undefined;
    if (inAnytime) rows.set(activityId, fromRow(row));
    else rows.delete(activityId);
  }
  for (const row of await reader.all(
    `SELECT entity_id FROM outbox_intents
     WHERE status IN ('queued', 'in_flight', 'needs_attention')
       AND json_extract(mutation_key_json, '$[0]') = 'activity'
       AND json_extract(mutation_key_json, '$[1]') = 'delete';`,
  )) {
    const activityId = text(row, 'entity_id');
    if (activityId !== undefined) rows.delete(activityId);
  }
  return [...rows.values()].sort(
    (left, right) =>
      left.title.localeCompare(right.title) ||
      left.activityId.localeCompare(right.activityId),
  );
}

export interface AnytimeCommittedSnapshot {
  readonly items: readonly ActivityListItem[];
  readonly commitRevision: number;
}

/** Complete, SQLite-owned saved-task index behind the native Anytime screen. */
export class AnytimeRepository {
  private readonly scope = 'anytime';

  constructor(
    private readonly reader: SqliteReader,
    private readonly subscriptions: RepositorySubscriptions,
    private readonly projections?: RevisionedProjectionReader,
  ) {}

  subscribe(listener: (metadata: RepositoryInvalidationMetadata) => void): () => void {
    return this.subscriptions.subscribe(this.scope, listener);
  }

  async read(): Promise<readonly ActivityListItem[]> {
    return readAnytimeItems(this.reader);
  }

  /** Presentation-only rows and revision from one WAL snapshot. */
  async readSnapshot(): Promise<AnytimeCommittedSnapshot> {
    if (this.projections === undefined) {
      return { items: await this.read(), commitRevision: 0 };
    }
    const snapshot = await this.projections.snapshot(readAnytimeItems);
    return { items: snapshot.data, commitRevision: snapshot.commitRevision };
  }

  async replaceCanonical(
    transaction: TransactionContext,
    items: readonly ActivityListItem[],
  ): Promise<void> {
    await transaction.database.run('DELETE FROM anytime_rows;');
    for (const item of items) {
      await transaction.database.run(
        `INSERT INTO anytime_rows (
          activity_id, type, title, status, time, end_time, is_recurring,
          participant_count, location_label, subtitle
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          item.activityId,
          item.type,
          item.title,
          item.status,
          item.time ?? null,
          item.endTime ?? null,
          item.isRecurring ? 1 : 0,
          item.participantCount,
          item.locationLabel ?? null,
          item.subtitle ?? null,
        ],
      );
    }
    transaction.changed(this.scope);
  }

  async acceptCanonicalActivity(
    transaction: TransactionContext,
    activity: Activity,
  ): Promise<void> {
    if (!belongsInAnytime(activity)) {
      await this.removeCanonical(transaction, activity.activityId);
      return;
    }
    const item = fromActivity(activity);
    await transaction.database.run(
      `INSERT INTO anytime_rows (
        activity_id, type, title, status, time, end_time, is_recurring,
        participant_count, location_label, subtitle
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(activity_id) DO UPDATE SET type=excluded.type, title=excluded.title,
        status=excluded.status, time=excluded.time, end_time=excluded.end_time,
        is_recurring=excluded.is_recurring, participant_count=excluded.participant_count,
        location_label=excluded.location_label, subtitle=excluded.subtitle;`,
      [
        item.activityId,
        item.type,
        item.title,
        item.status,
        item.time ?? null,
        item.endTime ?? null,
        item.isRecurring ? 1 : 0,
        item.participantCount,
        item.locationLabel ?? null,
        item.subtitle ?? null,
      ],
    );
    transaction.changed(this.scope);
  }

  async removeCanonical(
    transaction: TransactionContext,
    activityId: string,
  ): Promise<void> {
    await transaction.database.run('DELETE FROM anytime_rows WHERE activity_id = ?;', [
      activityId,
    ]);
    transaction.changed(this.scope);
  }
}
