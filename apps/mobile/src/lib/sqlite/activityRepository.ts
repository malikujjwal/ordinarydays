import type { PatchActivityInput, ScheduleActivityInput } from '@od/shared/schemas';
import {
  activity as activitySchema,
  activityUpdate as activityUpdateSchema,
} from '@od/shared/schemas';
import { systemClock } from '@od/shared/time';
import type {
  Activity,
  ActivityChild,
  ActivityDetail,
  ActivityDetailTarget,
  ActivityUpdate,
  ActivityUpdatePage,
  Occurrence,
  OccurrenceDetailProjection,
  PostActivityUpdateResult,
  Reminder,
  SourceListSummary,
} from '@od/shared/types';
import type { SqliteExecutor, SqliteReader, SqliteRow } from '@/lib/sqlite/database';
import { projectionFromCanonicalOccurrence } from '@/lib/sqlite/occurrenceMaterialization';
import { readCanonicalOutboxGuards } from '@/lib/sqlite/outbox';
import type { RepositorySubscriptions } from '@/lib/sqlite/subscriptions';
import type { TransactionContext } from '@/lib/sqlite/transaction';

export type NativeRowState = 'canonical' | 'queued' | 'updating' | 'needs_attention';

export type CapabilityHydrationState = 'installed' | 'missing' | 'deferred';

export interface DurablePendingUpdate {
  readonly localId: string;
  readonly body: string;
}

export interface ActivityUpdatesProjection extends ActivityUpdatePage {
  readonly pending: readonly DurablePendingUpdate[];
}

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

function activityUpdateFromRow(row: SqliteRow): ActivityUpdate {
  return activityUpdateSchema.parse({
    updateId: text(row, 'update_id'),
    activityId: text(row, 'activity_id'),
    kind: text(row, 'kind'),
    ...(text(row, 'author_user_id') === undefined
      ? {}
      : { authorUserId: text(row, 'author_user_id') }),
    body: text(row, 'body'),
    createdAt: text(row, 'created_at'),
    schemaVersion: number(row, 'schema_version'),
  });
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

  updatesScope(activityId: string): string {
    return `activity-updates:${activityId}`;
  }

  subscribeUpdates(activityId: string, listener: () => void): () => void {
    return this.subscriptions.subscribe(this.updatesScope(activityId), listener);
  }

  updatesVersion(activityId: string): number {
    return this.subscriptions.version(this.updatesScope(activityId));
  }

  async readChildRestoredStatus(
    parentActivityId: string,
    childActivityId: string,
  ): Promise<'saved' | 'scheduled' | undefined> {
    const row = await this.reader.first(
      `SELECT restored_status FROM activity_children
       WHERE parent_activity_id = ? AND child_activity_id = ?;`,
      [parentActivityId, childActivityId],
    );
    const status = row === undefined ? undefined : text(row, 'restored_status');
    return status === 'saved' || status === 'scheduled' ? status : undefined;
  }

  /** The stored parent of a Prep task, so a completion from any screen can reach its section. */
  async readParentActivityId(
    database: SqliteExecutor,
    activityId: string,
  ): Promise<string | undefined> {
    const row = await database.first(
      'SELECT parent_activity_id FROM activities WHERE activity_id = ?;',
      [activityId],
    );
    return row === undefined ? undefined : text(row, 'parent_activity_id');
  }

  /**
   * Mirrors a child's status onto its parent's installed Prep projection. `required` is for
   * the parent's own section acting on a row it just showed; a completion that reached the
   * child by another route (its detail screen, Today's checkbox, an acknowledgement) must
   * not fail because this device never installed the parent's detail.
   */
  async setChildStatusLocal(
    transaction: TransactionContext,
    parentActivityId: string,
    childActivityId: string,
    status: ActivityChild['status'],
    options: { readonly required?: boolean } = {},
  ): Promise<void> {
    const changed = await transaction.database.run(
      `UPDATE activity_children SET status = ?,
         restored_status = CASE
           WHEN ? IN ('saved', 'scheduled') THEN ? ELSE restored_status END
       WHERE parent_activity_id = ? AND child_activity_id = ?;`,
      [status, status, status, parentActivityId, childActivityId],
    );
    if (changed.changes !== 1) {
      if (options.required !== false) {
        throw new Error('The parent no longer contains this Prep task.');
      }
      return;
    }
    transaction.changed(this.scope(parentActivityId));
  }

  async acceptCanonicalChildStatus(
    transaction: TransactionContext,
    parentActivityId: string,
    activity: Activity,
  ): Promise<void> {
    await this.setChildStatusLocal(
      transaction,
      parentActivityId,
      activity.activityId,
      activity.status,
      { required: false },
    );
  }

  async readUpdates(activityId: string): Promise<ActivityUpdatePage> {
    const rows = await this.reader.all(
      `SELECT * FROM activity_updates
       WHERE activity_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM activity_update_operations operation
           WHERE operation.activity_id = activity_updates.activity_id
             AND operation.operation = 'delete'
             AND operation.target_update_id = activity_updates.update_id
         )
       ORDER BY created_at DESC, update_id DESC;`,
      [activityId],
    );
    const state = await this.reader.first(
      'SELECT next_cursor FROM activity_update_feed_state WHERE activity_id = ?;',
      [activityId],
    );
    const cursor = state === undefined ? undefined : text(state, 'next_cursor');
    return {
      updates: rows.map(activityUpdateFromRow),
      ...(cursor === undefined ? {} : { cursor }),
    };
  }

  async readUpdatesProjection(activityId: string): Promise<ActivityUpdatesProjection> {
    const [page, operations] = await Promise.all([
      this.readUpdates(activityId),
      this.reader.all(
        `SELECT intent_id, body FROM activity_update_operations
         WHERE activity_id = ? AND operation = 'post'
         ORDER BY created_at DESC, intent_id DESC;`,
        [activityId],
      ),
    ]);
    return {
      ...page,
      pending: operations.map((row) => ({
        localId: text(row, 'intent_id') ?? '',
        body: text(row, 'body') ?? '',
      })),
    };
  }

  async queueUpdatePost(
    transaction: TransactionContext,
    activityId: string,
    intentId: string,
    body: string,
    createdAt: number,
  ): Promise<void> {
    const activity = await transaction.database.first(
      'SELECT activity_id FROM activities WHERE activity_id = ?;',
      [activityId],
    );
    if (activity === undefined) throw new Error('No Activity is loaded for this update.');
    await transaction.database.run(
      `INSERT OR IGNORE INTO activity_update_operations
         (intent_id, activity_id, operation, body, target_update_id, created_at)
       VALUES (?, ?, 'post', ?, NULL, ?);`,
      [intentId, activityId, body, createdAt],
    );
    transaction.changed(this.updatesScope(activityId));
  }

  async queueUpdateDelete(
    transaction: TransactionContext,
    activityId: string,
    updateId: string,
    intentId: string,
    createdAt: number,
  ): Promise<void> {
    const update = await transaction.database.first(
      `SELECT kind FROM activity_updates
       WHERE activity_id = ? AND update_id = ?;`,
      [activityId, updateId],
    );
    if (text(update ?? {}, 'kind') !== 'user') {
      throw new Error('Only a saved user update can be deleted.');
    }
    await transaction.database.run(
      `INSERT OR IGNORE INTO activity_update_operations
         (intent_id, activity_id, operation, body, target_update_id, created_at)
       VALUES (?, ?, 'delete', NULL, ?, ?);`,
      [intentId, activityId, updateId, createdAt],
    );
    transaction.changed(this.updatesScope(activityId));
  }

  async settlePostedUpdate(
    transaction: TransactionContext,
    intentId: string,
    result: PostActivityUpdateResult,
  ): Promise<void> {
    const operation = await transaction.database.first(
      `SELECT activity_id FROM activity_update_operations
       WHERE intent_id = ? AND operation = 'post';`,
      [intentId],
    );
    if (text(operation ?? {}, 'activity_id') !== result.update.activityId) {
      throw new Error('Update acknowledgement crossed its durable Activity boundary.');
    }
    await this.installConfirmedUpdate(transaction, result);
    await transaction.database.run(
      'DELETE FROM activity_update_operations WHERE intent_id = ?;',
      [intentId],
    );
    transaction.changed(this.updatesScope(result.update.activityId));
  }

  async settleDeletedUpdate(
    transaction: TransactionContext,
    intentId: string,
    activityId: string,
    updateId: string,
  ): Promise<void> {
    const operation = await transaction.database.first(
      `SELECT activity_id, target_update_id FROM activity_update_operations
       WHERE intent_id = ? AND operation = 'delete';`,
      [intentId],
    );
    if (
      text(operation ?? {}, 'activity_id') !== activityId ||
      text(operation ?? {}, 'target_update_id') !== updateId
    ) {
      throw new Error('Delete acknowledgement crossed its durable update boundary.');
    }
    await this.deleteConfirmedUpdate(transaction, activityId, updateId);
    await transaction.database.run(
      'DELETE FROM activity_update_operations WHERE intent_id = ?;',
      [intentId],
    );
    transaction.changed(this.updatesScope(activityId));
  }

  async rollbackUpdateOperation(
    transaction: TransactionContext,
    intentId: string,
    activityId: string,
  ): Promise<void> {
    await transaction.database.run(
      'DELETE FROM activity_update_operations WHERE intent_id = ?;',
      [intentId],
    );
    transaction.changed(this.updatesScope(activityId));
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
    const feedState = await this.reader.first(
      'SELECT next_cursor FROM activity_update_feed_state WHERE activity_id = ?;',
      [target.activityId],
    );
    const feed =
      feedState === undefined ? undefined : await this.readUpdates(target.activityId);
    const bounded = await this.readBoundedDetail(target.activityId, this.reader);
    if (target.kind === 'activity') {
      return {
        activity: activityFromRow(row),
        reminders,
        ...(storedCapabilities === undefined ? {} : { capabilities: storedCapabilities }),
        ...(completedOccurrenceCount === undefined ? {} : { completedOccurrenceCount }),
        ...(feed === undefined ? {} : { updates: feed.updates }),
        ...(feed?.cursor === undefined ? {} : { updatesCursor: feed.cursor }),
        ...bounded,
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
    /*
     * A committed local Agenda row owns the occurrence presentation until acknowledgement.
     * After reconciliation, its canonical version also wins over an older targeted occurrence
     * projection. Otherwise an all-future time edit reverts in detail as soon as both rows are
     * canonical, even while every Agenda row correctly shows the acknowledged time.
     */
    const occurrenceVersion =
      occurrenceRow === undefined ? undefined : text(occurrenceRow, 'canonical_version');
    const agendaVersion =
      agendaRow === undefined ? undefined : text(agendaRow, 'canonical_version');
    const agendaOwnsProjection =
      agendaRow !== undefined &&
      (text(agendaRow, 'local_state') !== 'canonical' ||
        (agendaVersion !== undefined &&
          (occurrenceVersion === undefined || agendaVersion > occurrenceVersion)));
    const occurrence =
      agendaOwnsProjection && agendaRow !== undefined
        ? occurrenceFromAgendaRow(agendaRow)
        : occurrenceRow === undefined
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
      ...(feed === undefined ? {} : { updates: feed.updates }),
      ...(feed?.cursor === undefined ? {} : { updatesCursor: feed.cursor }),
      ...bounded,
    };
  }

  /**
   * Appends one older canonical page. The page is installed only while the feed still sits at
   * the cursor that requested it; a head that arrived in between restarted the chain and the
   * caller simply reads the current feed.
   */
  async installUpdatePage(
    transaction: TransactionContext,
    activityId: string,
    expectedCursor: string,
    page: ActivityUpdatePage,
  ): Promise<boolean> {
    const current = await transaction.database.first(
      'SELECT next_cursor FROM activity_update_feed_state WHERE activity_id = ?;',
      [activityId],
    );
    if (current === undefined || text(current, 'next_cursor') !== expectedCursor) {
      return false;
    }
    for (const update of page.updates) {
      if (update.activityId !== activityId) {
        throw new Error('Activity update page crossed activity boundary.');
      }
      await this.putUpdate(transaction.database, update);
    }
    await this.putUpdateCursor(transaction.database, activityId, page.cursor);
    transaction.changed(this.updatesScope(activityId));
    return true;
  }

  /**
   * Installs the POST acknowledgement and raises the Plans ordering key atomically.
   * An eventual detail/GSI response may later match this value but may never lower it.
   */
  async installConfirmedUpdate(
    transaction: TransactionContext,
    result: PostActivityUpdateResult,
  ): Promise<void> {
    const activityId = result.update.activityId;
    await this.putUpdate(transaction.database, result.update);
    const raised = await transaction.database.run(
      `UPDATE activities
       SET last_activity_at = CASE
         WHEN last_activity_at >= ? THEN last_activity_at ELSE ? END
       WHERE activity_id = ?;`,
      [result.lastActivityAt, result.lastActivityAt, activityId],
    );
    if (raised.changes !== 1) {
      throw new Error('Cannot install an update before its Activity projection.');
    }
    transaction.changed(this.scope(activityId));
    transaction.changed(this.updatesScope(activityId));
    transaction.changed('plans');
  }

  async deleteConfirmedUpdate(
    transaction: TransactionContext,
    activityId: string,
    updateId: string,
  ): Promise<void> {
    await transaction.database.run(
      'DELETE FROM activity_updates WHERE activity_id = ? AND update_id = ?;',
      [activityId, updateId],
    );
    transaction.changed(this.updatesScope(activityId));
  }

  /**
   * `updatesVersion` is the Updates subscription version the caller read before its network
   * request. If a local write settled while that response was in flight, the response's feed
   * page predates the write and is not installed; the rest of the detail is, and the next
   * detail read converges the feed. A settled write is canonical the moment it lands, and only
   * a stale in-flight page could contradict it, so no overlay bookkeeping is needed.
   */
  async putCanonical(
    transaction: TransactionContext,
    detail: ActivityDetail,
    options: { readonly updatesVersion?: number } = {},
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
    if (
      localState !== undefined &&
      localState !== 'canonical' &&
      guards.protectedActivityIds.has(detail.activity.activityId)
    ) {
      return false;
    }
    return this.installCanonicalDetail(transaction, detail, {
      preserveLocalReminders: true,
      guards,
      installUpdates:
        options.updatesVersion === undefined ||
        options.updatesVersion === this.updatesVersion(detail.activity.activityId),
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
    options: { readonly preserveLocalReminders?: boolean } = {},
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
      ...(usableEnrichment?.children === undefined
        ? current?.children === undefined
          ? {}
          : { children: current.children }
        : { children: usableEnrichment.children }),
      ...(usableEnrichment?.sourceLists === undefined
        ? current?.sourceLists === undefined
          ? {}
          : { sourceLists: current.sourceLists }
        : { sourceLists: usableEnrichment.sourceLists }),
    };
    return this.installCanonicalDetail(transaction, detail, {
      preserveLocalReminders: options.preserveLocalReminders ?? false,
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
      /** False when a local write settled after this detail was fetched (see putCanonical). */
      readonly installUpdates?: boolean;
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
         last_activity_at=CASE
           WHEN activities.last_activity_at > excluded.last_activity_at
             THEN activities.last_activity_at
           ELSE excluded.last_activity_at
         END,
         updated_at=excluded.updated_at,
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
    if (detail.updates !== undefined && options.installUpdates !== false) {
      // The embedded head is the authoritative first page: it replaces every locally held
      // canonical row and restarts the continuation chain. Pending posts and delete masks live
      // in activity_update_operations and are untouched.
      await transaction.database.run(
        'DELETE FROM activity_updates WHERE activity_id = ?;',
        [detail.activity.activityId],
      );
      for (const update of detail.updates) {
        await this.putUpdate(transaction.database, update);
      }
      await this.putUpdateCursor(
        transaction.database,
        detail.activity.activityId,
        detail.updatesCursor,
      );
      transaction.changed(this.updatesScope(detail.activity.activityId));
    }
    await this.replaceBoundedDetail(transaction.database, detail);
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
    await this.restoreCanonicalAbsenceAfterRejection(transaction, activityId);
    return true;
  }

  /**
   * Installs a strong Activity-detail 404 while retiring a rejected-write recovery receipt.
   *
   * The ordinary deletion path above must respect unresolved outbox guards. Recovery already
   * fenced the exact receipt inside the serialized writer, so this variant deliberately removes
   * every projection regardless of its local state. The caller clears that receipt in the same
   * transaction; exposing this as a repository operation keeps the all-or-nothing delete set in
   * one place.
   */
  async restoreCanonicalAbsenceAfterRejection(
    transaction: TransactionContext,
    activityId: string,
  ): Promise<void> {
    await transaction.database.run(
      'DELETE FROM activity_reminders WHERE activity_id = ?;',
      [activityId],
    );
    await transaction.database.run(
      'DELETE FROM activity_occurrences WHERE activity_id = ?;',
      [activityId],
    );
    await transaction.database.run(
      'DELETE FROM activity_updates WHERE activity_id = ?;',
      [activityId],
    );
    await transaction.database.run(
      'DELETE FROM activity_update_feed_state WHERE activity_id = ?;',
      [activityId],
    );
    await transaction.database.run(
      'DELETE FROM activity_update_operations WHERE activity_id = ?;',
      [activityId],
    );
    await transaction.database.run(
      'DELETE FROM activity_children WHERE parent_activity_id = ?;',
      [activityId],
    );
    await transaction.database.run(
      'DELETE FROM activity_source_lists WHERE activity_id = ?;',
      [activityId],
    );
    await transaction.database.run(
      'DELETE FROM activity_detail_projection_state WHERE activity_id = ?;',
      [activityId],
    );
    await transaction.database.run('DELETE FROM agenda_rows WHERE activity_id = ?;', [
      activityId,
    ]);
    await transaction.database.run(
      'DELETE FROM agenda_projection_fences WHERE activity_id = ?;',
      [activityId],
    );
    await transaction.database.run('DELETE FROM anytime_rows WHERE activity_id = ?;', [
      activityId,
    ]);
    await transaction.database.run('DELETE FROM activities WHERE activity_id = ?;', [
      activityId,
    ]);
    await this.recordTombstone(transaction.database, activityId, systemClock.now());
    transaction.changed(this.scope(activityId));
    transaction.changed(this.updatesScope(activityId));
    transaction.changed('agenda');
    transaction.changed('anytime');
    transaction.changed('reminders');
  }

  private async putUpdate(
    database: SqliteExecutor,
    update: ActivityUpdate,
  ): Promise<void> {
    await database.run(
      `INSERT INTO activity_updates
         (update_id, activity_id, kind, author_user_id, body, created_at, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(update_id) DO UPDATE SET
         activity_id=excluded.activity_id, kind=excluded.kind,
         author_user_id=excluded.author_user_id, body=excluded.body,
         created_at=excluded.created_at, schema_version=excluded.schema_version;`,
      [
        update.updateId,
        update.activityId,
        update.kind,
        update.authorUserId ?? null,
        update.body,
        update.createdAt,
        update.schemaVersion,
      ],
    );
  }

  private async putUpdateCursor(
    database: SqliteExecutor,
    activityId: string,
    cursor: string | undefined,
  ): Promise<void> {
    await database.run(
      `INSERT INTO activity_update_feed_state (activity_id, next_cursor)
       VALUES (?, ?)
       ON CONFLICT(activity_id) DO UPDATE SET next_cursor=excluded.next_cursor;`,
      [activityId, cursor ?? null],
    );
  }

  /** Removes only the durable occurrence projection proven absent by a strong detail 404. */
  async restoreCanonicalOccurrenceAbsenceAfterRejection(
    transaction: TransactionContext,
    activityId: string,
    nominalDate: string,
  ): Promise<void> {
    await transaction.database.run(
      `DELETE FROM activity_occurrences
       WHERE activity_id = ? AND nominal_date = ?;`,
      [activityId, nominalDate],
    );
    transaction.changed(this.scope(activityId));
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
  ): Promise<ActivityDetail> {
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
    return { ...detail, activity: next };
  }

  /** Moves the complete local Activity projection after an ambiguous-create Retry. */
  async remapPendingCreateIdentity(
    transaction: TransactionContext,
    previousActivityId: string,
    freshActivityId: string,
  ): Promise<void> {
    const occupied = await transaction.database.first(
      `SELECT activity_id FROM activities WHERE activity_id = ?
       UNION ALL SELECT activity_id FROM activity_occurrences WHERE activity_id = ?
       UNION ALL SELECT activity_id FROM activity_reminders WHERE activity_id = ?
       UNION ALL SELECT activity_id FROM anytime_rows WHERE activity_id = ?
       UNION ALL SELECT activity_id FROM activity_tombstones WHERE activity_id = ?
       LIMIT 1;`,
      [
        freshActivityId,
        freshActivityId,
        freshActivityId,
        freshActivityId,
        freshActivityId,
      ],
    );
    if (occupied !== undefined) {
      throw new Error('The fresh Activity identity is already in use.');
    }
    await transaction.database.run(
      'UPDATE activities SET parent_activity_id = ? WHERE parent_activity_id = ?;',
      [freshActivityId, previousActivityId],
    );
    const moved = await transaction.database.run(
      `UPDATE activities SET activity_id = ?, local_state = 'queued'
       WHERE activity_id = ?;`,
      [freshActivityId, previousActivityId],
    );
    if (moved.changes !== 1) {
      throw new Error('The collided local Activity projection is missing.');
    }
    await transaction.database.run(
      `UPDATE activity_occurrences SET activity_id = ?, local_state = 'queued'
       WHERE activity_id = ?;`,
      [freshActivityId, previousActivityId],
    );
    await transaction.database.run(
      `UPDATE activity_reminders SET activity_id = ?, local_state = 'queued'
       WHERE activity_id = ?;`,
      [freshActivityId, previousActivityId],
    );
    await transaction.database.run(
      'UPDATE anytime_rows SET activity_id = ? WHERE activity_id = ?;',
      [freshActivityId, previousActivityId],
    );
    await transaction.database.run(
      'UPDATE reminder_tombstones SET activity_id = ? WHERE activity_id = ?;',
      [freshActivityId, previousActivityId],
    );
    transaction.changed(this.scope(previousActivityId));
    transaction.changed(this.scope(freshActivityId));
    transaction.changed('reminders');
    transaction.changed('anytime');
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
    const bounded = await this.readBoundedDetail(activityId, database);
    return {
      activity: activityFromRow(row),
      reminders,
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(completedOccurrenceCount === undefined ? {} : { completedOccurrenceCount }),
      ...bounded,
    };
  }

  private async readBoundedDetail(
    activityId: string,
    database: SqliteReader,
  ): Promise<Pick<ActivityDetail, 'children' | 'sourceLists'>> {
    const state = await database.first(
      `SELECT children_installed, source_lists_installed
       FROM activity_detail_projection_state WHERE activity_id = ?;`,
      [activityId],
    );
    if (state === undefined) return {};
    const children: ActivityChild[] =
      number(state, 'children_installed') === 1
        ? (
            await database.all(
              `SELECT * FROM activity_children
               WHERE parent_activity_id = ? ORDER BY ordinal;`,
              [activityId],
            )
          ).map((row) => ({
            activityId: text(row, 'child_activity_id') ?? '',
            title: text(row, 'title') ?? '',
            status: (text(row, 'status') ?? 'saved') as ActivityChild['status'],
            restoredStatus: (text(row, 'restored_status') ??
              'saved') as ActivityChild['restoredStatus'],
            isRecurring: number(row, 'is_recurring') === 1,
          }))
        : [];
    const sourceLists: SourceListSummary[] =
      number(state, 'source_lists_installed') === 1
        ? (
            await database.all(
              `SELECT * FROM activity_source_lists
               WHERE activity_id = ? ORDER BY ordinal;`,
              [activityId],
            )
          ).map((row) => ({
            listId: text(row, 'list_id') ?? '',
            title: text(row, 'title') ?? '',
            icon: text(row, 'icon') ?? '',
            itemCount: number(row, 'item_count') ?? 0,
            doneCount: number(row, 'done_count') ?? 0,
          }))
        : [];
    return {
      ...(number(state, 'children_installed') === 1 ? { children } : {}),
      ...(number(state, 'source_lists_installed') === 1 ? { sourceLists } : {}),
    };
  }

  private async replaceBoundedDetail(
    database: SqliteExecutor,
    detail: ActivityDetail,
  ): Promise<void> {
    const activityId = detail.activity.activityId;
    if (detail.children !== undefined) {
      await database.run('DELETE FROM activity_children WHERE parent_activity_id = ?;', [
        activityId,
      ]);
      for (const [ordinal, child] of detail.children.entries()) {
        await database.run(
          `INSERT INTO activity_children
             (parent_activity_id, child_activity_id, ordinal, title, status, is_recurring,
              restored_status)
           VALUES (?, ?, ?, ?, ?, ?, ?);`,
          [
            activityId,
            child.activityId,
            ordinal,
            child.title,
            child.status,
            child.isRecurring ? 1 : 0,
            child.restoredStatus,
          ],
        );
      }
    }
    if (detail.sourceLists !== undefined) {
      await database.run('DELETE FROM activity_source_lists WHERE activity_id = ?;', [
        activityId,
      ]);
      for (const [ordinal, source] of detail.sourceLists.entries()) {
        await database.run(
          `INSERT INTO activity_source_lists
             (activity_id, list_id, ordinal, title, icon, item_count, done_count)
           VALUES (?, ?, ?, ?, ?, ?, ?);`,
          [
            activityId,
            source.listId,
            ordinal,
            source.title,
            source.icon,
            source.itemCount,
            source.doneCount,
          ],
        );
      }
    }
    if (detail.children !== undefined || detail.sourceLists !== undefined) {
      await database.run(
        `INSERT INTO activity_detail_projection_state
           (activity_id, children_installed, source_lists_installed)
         VALUES (?, ?, ?)
         ON CONFLICT(activity_id) DO UPDATE SET
           children_installed=CASE WHEN ? = 1 THEN 1 ELSE children_installed END,
           source_lists_installed=CASE WHEN ? = 1 THEN 1 ELSE source_lists_installed END;`,
        [
          activityId,
          detail.children === undefined ? 0 : 1,
          detail.sourceLists === undefined ? 0 : 1,
          detail.children === undefined ? 0 : 1,
          detail.sourceLists === undefined ? 0 : 1,
        ],
      );
    }
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
