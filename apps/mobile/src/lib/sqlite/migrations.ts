import { systemClock } from '@od/shared/time';
import type { SqliteDatabase, SqliteExecutor } from '@/lib/sqlite/database';
import { numberColumn, textColumn } from '@/lib/sqlite/database';

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  apply(database: SqliteExecutor): Promise<void>;
}

export class SqliteMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqliteMigrationError';
  }
}

export const FOUNDATION_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: 'legacy-import-receipts',
    apply: (database) =>
      database.exec(`
        CREATE TABLE legacy_import_receipts (
          source_id TEXT PRIMARY KEY NOT NULL,
          source_fingerprint TEXT NOT NULL,
          imported_base_count INTEGER NOT NULL,
          imported_intent_count INTEGER NOT NULL,
          imported_dependency_count INTEGER NOT NULL,
          requires_sync INTEGER NOT NULL CHECK (requires_sync IN (0, 1)),
          imported_at TEXT NOT NULL
        );
      `),
  },
  {
    version: 2,
    name: 'activity-agenda-transactional-outbox',
    apply: (database) =>
      database.exec(`
        CREATE TABLE activities (
          activity_id TEXT PRIMARY KEY NOT NULL,
          owner_id TEXT NOT NULL,
          object_kind TEXT NOT NULL CHECK (object_kind IN ('task', 'plan')),
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          title TEXT NOT NULL,
          notes TEXT,
          schedule_date TEXT,
          schedule_time TEXT,
          schedule_end_time TEXT,
          schedule_timezone TEXT,
          scheduled_at_utc TEXT,
          end_at_utc TEXT,
          recurrence_json TEXT,
          location_json TEXT,
          parent_activity_id TEXT,
          list_item_id TEXT,
          list_id TEXT,
          source_url TEXT,
          primary_attachment_id TEXT,
          participant_count INTEGER NOT NULL,
          child_count INTEGER NOT NULL,
          expense_total_cents INTEGER NOT NULL,
          visibility TEXT NOT NULL,
          details_json TEXT NOT NULL,
          completed_at TEXT,
          snoozed_until TEXT,
          outcome TEXT,
          ics_sequence INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          last_activity_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          capabilities_json TEXT,
          completed_occurrence_count INTEGER,
          local_state TEXT NOT NULL DEFAULT 'canonical'
            CHECK (local_state IN ('canonical', 'queued', 'updating', 'needs_attention')),
          canonical_version TEXT
        );
        CREATE INDEX activities_schedule
          ON activities (schedule_date, schedule_time, activity_id);
        CREATE INDEX activities_status
          ON activities (status, last_activity_at DESC, activity_id);
        CREATE INDEX activities_parent
          ON activities (parent_activity_id, activity_id);

        CREATE TABLE activity_occurrences (
          activity_id TEXT NOT NULL,
          nominal_date TEXT NOT NULL,
          viewer_date TEXT NOT NULL,
          time TEXT,
          end_time TEXT,
          status TEXT NOT NULL,
          is_snoozed INTEGER NOT NULL CHECK (is_snoozed IN (0, 1)),
          completed_at TEXT,
          local_state TEXT NOT NULL DEFAULT 'canonical'
            CHECK (local_state IN ('canonical', 'queued', 'updating', 'needs_attention')),
          canonical_version TEXT,
          PRIMARY KEY (activity_id, nominal_date)
        );
        CREATE INDEX activity_occurrences_viewer_date
          ON activity_occurrences (viewer_date, activity_id, nominal_date);

        CREATE TABLE activity_reminders (
          reminder_id TEXT PRIMARY KEY NOT NULL,
          activity_id TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          offset_minutes INTEGER NOT NULL,
          channel TEXT NOT NULL CHECK (channel = 'push'),
          local_state TEXT NOT NULL DEFAULT 'canonical'
            CHECK (local_state IN ('canonical', 'queued', 'needs_attention'))
        );
        CREATE INDEX activity_reminders_activity_owner
          ON activity_reminders (activity_id, owner_user_id, reminder_id);

        CREATE TABLE agenda_rows (
          row_id TEXT PRIMARY KEY NOT NULL,
          viewer_date TEXT NOT NULL,
          section TEXT NOT NULL CHECK (section IN ('up_next', 'schedule', 'anytime', 'earlier')),
          sort_order INTEGER NOT NULL,
          is_up_next INTEGER NOT NULL CHECK (is_up_next IN (0, 1)),
          activity_id TEXT NOT NULL,
          occurrence_date TEXT,
          parent_activity_id TEXT,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          time TEXT,
          end_time TEXT,
          is_recurring INTEGER NOT NULL CHECK (is_recurring IN (0, 1)),
          recurrence_description TEXT,
          is_snoozed INTEGER NOT NULL CHECK (is_snoozed IN (0, 1)),
          original_time TEXT,
          has_checkbox INTEGER NOT NULL CHECK (has_checkbox IN (0, 1)),
          capabilities_json TEXT NOT NULL,
          participant_avatars_json TEXT NOT NULL,
          participant_count INTEGER NOT NULL,
          location_label TEXT,
          subtitle TEXT,
          note_excerpt TEXT,
          is_past INTEGER NOT NULL CHECK (is_past IN (0, 1)),
          overdue_from_date TEXT,
          local_state TEXT NOT NULL DEFAULT 'canonical'
            CHECK (local_state IN ('canonical', 'queued', 'updating', 'needs_attention')),
          canonical_version TEXT
        );
        CREATE UNIQUE INDEX agenda_rows_identity
          ON agenda_rows (viewer_date, activity_id, COALESCE(occurrence_date, ''));
        CREATE INDEX agenda_rows_window
          ON agenda_rows (viewer_date, section, sort_order, activity_id);
        CREATE INDEX agenda_rows_activity
          ON agenda_rows (activity_id, viewer_date, occurrence_date);

        CREATE TABLE agenda_coverage (
          from_date TEXT NOT NULL,
          to_date TEXT NOT NULL,
          timezone TEXT NOT NULL,
          include_key TEXT NOT NULL,
          refreshed_at TEXT NOT NULL,
          warnings_json TEXT NOT NULL,
          projection_versions_json TEXT,
          PRIMARY KEY (from_date, to_date, timezone, include_key)
        );
        CREATE INDEX agenda_coverage_dates
          ON agenda_coverage (from_date, to_date);

        CREATE TABLE outbox_meta (
          singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
          next_seq INTEGER NOT NULL,
          clock_witness INTEGER NOT NULL
        );
        INSERT INTO outbox_meta (singleton, next_seq, clock_witness) VALUES (1, 1, 0);

        CREATE TABLE outbox_intents (
          intent_id TEXT PRIMARY KEY NOT NULL,
          mutation_key_json TEXT NOT NULL,
          variables_json TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          ordering_key TEXT NOT NULL,
          status TEXT NOT NULL
            CHECK (status IN ('queued', 'in_flight', 'acknowledged', 'needs_attention')),
          created_at INTEGER NOT NULL,
          seq INTEGER NOT NULL UNIQUE,
          attempts INTEGER NOT NULL DEFAULT 0,
          attention_kind TEXT CHECK (attention_kind IN ('rejected', 'parked')),
          attention_reason TEXT,
          attention_status INTEGER,
          attention_code TEXT,
          attention_details_json TEXT,
          last_error TEXT,
          reconciliation_version TEXT,
          depends_on_intent_id TEXT REFERENCES outbox_intents(intent_id)
            DEFERRABLE INITIALLY DEFERRED,
          compensation_for_intent_id TEXT REFERENCES outbox_intents(intent_id)
            DEFERRABLE INITIALLY DEFERRED,
          semantic_key TEXT NOT NULL
        );
        CREATE INDEX outbox_intents_replay
          ON outbox_intents (status, seq);
        CREATE INDEX outbox_intents_ordering_barrier
          ON outbox_intents (ordering_key, seq);
        CREATE INDEX outbox_intents_entity
          ON outbox_intents (entity_id, seq);
        CREATE INDEX outbox_intents_dependency
          ON outbox_intents (depends_on_intent_id, status);

        CREATE TABLE native_sync_errors (
          scope TEXT PRIMARY KEY NOT NULL,
          message TEXT NOT NULL,
          retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
          recorded_at TEXT NOT NULL
        );

        CREATE TABLE native_reminder_profile (
          singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
          timezone TEXT NOT NULL,
          all_day_reminder_hour INTEGER,
          quiet_hours_json TEXT,
          refreshed_at TEXT NOT NULL
        );

        CREATE TABLE legacy_domain_imports (
          source_id TEXT NOT NULL,
          record_key TEXT NOT NULL,
          domain TEXT NOT NULL,
          server_version TEXT NOT NULL,
          PRIMARY KEY (source_id, record_key)
        );

        CREATE TABLE legacy_intent_imports (
          source_id TEXT NOT NULL,
          record_key TEXT NOT NULL,
          intent_id TEXT NOT NULL,
          ordering_key TEXT NOT NULL,
          imported_status TEXT NOT NULL,
          depends_on_intent_id TEXT,
          compensation_for_intent_id TEXT,
          PRIMARY KEY (source_id, record_key)
        );
      `),
  },
  {
    version: 3,
    name: 'activity-reminder-canonical-tombstones',
    apply: (database) =>
      database.exec(`
        CREATE TABLE activity_tombstones (
          activity_id TEXT PRIMARY KEY NOT NULL,
          acknowledged_at TEXT NOT NULL
        );
        CREATE TABLE reminder_tombstones (
          reminder_id TEXT PRIMARY KEY NOT NULL,
          activity_id TEXT NOT NULL,
          acknowledged_at TEXT NOT NULL
        );
        CREATE INDEX reminder_tombstones_activity
          ON reminder_tombstones (activity_id, reminder_id);
      `),
  },
  {
    version: 4,
    name: 'native-anytime-index',
    apply: (database) =>
      database.exec(`
        CREATE TABLE anytime_rows (
          activity_id TEXT PRIMARY KEY NOT NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          time TEXT,
          end_time TEXT,
          is_recurring INTEGER NOT NULL CHECK (is_recurring IN (0, 1)),
          participant_count INTEGER NOT NULL,
          location_label TEXT,
          subtitle TEXT
        );
        CREATE INDEX anytime_rows_title
          ON anytime_rows (title COLLATE NOCASE, activity_id);
      `),
  },
  {
    version: 5,
    name: 'agenda-target-lookup-index',
    apply: (database) =>
      database.exec(`
        DROP INDEX agenda_rows_activity;
        CREATE INDEX agenda_rows_activity
          ON agenda_rows (activity_id, occurrence_date, viewer_date);
      `),
  },
  {
    version: 6,
    name: 'outbox-active-write-indexes',
    apply: (database) =>
      database.exec(`
        CREATE INDEX outbox_intents_active_entity_mutation
          ON outbox_intents (
            entity_id,
            json_extract(mutation_key_json, '$[0]'),
            json_extract(mutation_key_json, '$[1]'),
            seq
          )
          WHERE status IN ('queued', 'in_flight', 'needs_attention');
      `),
  },
  {
    version: 7,
    name: 'account-commit-revision',
    apply: (database) =>
      database.exec(`
        CREATE TABLE native_commit_state (
          singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
          commit_revision INTEGER NOT NULL CHECK (commit_revision >= 0)
        );
        INSERT INTO native_commit_state (singleton, commit_revision) VALUES (1, 0);
      `),
  },
  {
    version: 8,
    name: 'local-activity-canonical-version-repair',
    apply: async (database) => {
      await database.run(
        `UPDATE activities SET canonical_version = NULL
         WHERE canonical_version IS NOT NULL
           AND (
             (
               local_state = 'canonical'
               AND capabilities_json IS NULL
             )
             OR EXISTS (
               SELECT 1 FROM outbox_intents
               WHERE outbox_intents.entity_id = activities.activity_id
                 AND outbox_intents.status IN ('queued', 'in_flight', 'needs_attention')
                 AND json_extract(outbox_intents.mutation_key_json, '$[0]') = 'activity'
                 AND json_extract(outbox_intents.mutation_key_json, '$[1]') = 'create'
             )
           );`,
      );
    },
  },
];

function validatePlan(migrations: readonly SqliteMigration[]): void {
  for (const [index, migration] of migrations.entries()) {
    const expected = index + 1;
    if (migration.version !== expected || migration.name.length === 0) {
      throw new SqliteMigrationError(
        `SQLite migrations must be contiguous from version 1; expected ${expected}.`,
      );
    }
  }
}

export async function runMigrations(
  database: SqliteDatabase,
  migrations: readonly SqliteMigration[] = FOUNDATION_MIGRATIONS,
  appliedAt: () => string = () => systemClock.now(),
): Promise<void> {
  validatePlan(migrations);
  await database.transaction((transaction) =>
    transaction.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `),
  );
  const appliedRows = await database.all(
    'SELECT version, name FROM schema_migrations ORDER BY version;',
  );
  for (const [index, row] of appliedRows.entries()) {
    const version = numberColumn(row, 'version');
    const name = textColumn(row, 'name');
    if (version !== index + 1) {
      throw new SqliteMigrationError(
        'Stored SQLite migration history is not contiguous.',
      );
    }
    const migration = version === undefined ? undefined : migrations[version - 1];
    if (migration === undefined || migration.name !== name) {
      throw new SqliteMigrationError(
        'Stored SQLite migration history does not match this build.',
      );
    }
  }
  for (const migration of migrations.slice(appliedRows.length)) {
    await database.transaction(async (transaction) => {
      await migration.apply(transaction);
      await transaction.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?);',
        [migration.version, migration.name, appliedAt()],
      );
    });
  }
}
