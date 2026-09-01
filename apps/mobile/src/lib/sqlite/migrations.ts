import { migrateLegacyListAggregate } from '@od/shared/lists';
import { FIRST_RANK, lexoRankBetween } from '@od/shared/rank';
import { systemClock } from '@od/shared/time';
import type { ItemStateMode, ListFeatureConfig, ListItem } from '@od/shared/types';
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

type JsonObject = Record<string, unknown>;

interface LegacyListConfigurationSnapshot {
  behaviour: string;
  checkable: boolean;
  supportsLocation: boolean;
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  const object = objectValue(value);
  if (object === undefined) return value;
  return Object.fromEntries(
    Object.entries(object)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJsonValue(child)]),
  );
}

function migratedIntentSemanticKey(input: {
  mutationKey: readonly string[];
  variables: unknown;
  entityId: string;
  orderingKey: string;
  dependsOnIntentId?: string;
  compensationForIntentId?: string;
}): string {
  return JSON.stringify(canonicalJsonValue(input));
}

function stateModeForLegacyConfiguration(
  behaviour: string,
  checkable: boolean,
): ItemStateMode {
  if (behaviour === 'watch') {
    return {
      mode: 'stages',
      labels: { open: 'Want to watch', active: 'Watching', done: 'Watched' },
      groupByState: true,
    };
  }
  if (behaviour === 'meals') return { mode: 'none' };
  return checkable ? { mode: 'checkbox' } : { mode: 'none' };
}

function featureConfigForLegacyConfiguration(
  behaviour: string,
  supportsLocation: boolean,
): ListFeatureConfig {
  if (behaviour === 'watch') {
    return { progress: { enabled: true, kind: 'episode' } };
  }
  if (behaviour === 'meals') {
    return {
      subItems: {
        enabled: true,
        sectionLabel: 'Ingredients',
        singularLabel: 'Ingredient',
        secondaryLabel: 'Quantity',
        integration: 'mealIngredients',
      },
    };
  }
  return supportsLocation ? { place: { enabled: true } } : {};
}

function translateLegacySettings(
  value: unknown,
  legacyBehaviour: string,
): JsonObject | undefined {
  const settings = objectValue(value);
  if (settings === undefined) return undefined;
  const capabilities = objectValue(settings.capabilities);
  const next: JsonObject = {
    ...(typeof settings.title === 'string' ? { title: settings.title } : {}),
    ...(settings.slot === null || typeof settings.slot === 'string'
      ? { slot: settings.slot }
      : {}),
    ...(typeof settings.archived === 'boolean' ? { archived: settings.archived } : {}),
  };
  if (typeof capabilities?.checkable === 'boolean') {
    next.itemStateMode = stateModeForLegacyConfiguration(
      legacyBehaviour,
      capabilities.checkable,
    );
  }
  if (typeof capabilities?.supportsLocation === 'boolean') {
    next.featureConfig = {
      place: { enabled: capabilities.supportsLocation },
    };
  }
  return next;
}

function translateLegacyItemInput(
  value: unknown,
  legacyBehaviour?: string,
): JsonObject | undefined {
  const input = objectValue(value);
  if (input === undefined) return undefined;
  const next: JsonObject = {
    ...(typeof input.itemId === 'string' ? { itemId: input.itemId } : {}),
    ...(typeof input.title === 'string' ? { title: input.title } : {}),
    ...(input.note === null || typeof input.note === 'string'
      ? { note: input.note }
      : {}),
    ...(input.afterItemId === null || typeof input.afterItemId === 'string'
      ? { afterItemId: input.afterItemId }
      : {}),
  };
  if (typeof input.checked === 'boolean') {
    next.state = input.checked ? 'done' : 'open';
  }
  const features: JsonObject = {};
  if ('location' in input) {
    features.place = input.location ?? null;
  }
  if ('details' in input) {
    const details = objectValue(input.details);
    if (details?.behaviour === 'watch') {
      const status = details.watchStatus;
      if (status === 'want' || status === 'watching' || status === 'watched') {
        next.state = { want: 'open', watching: 'active', watched: 'done' }[status];
      }
      const progress: JsonObject = {
        kind: 'episode',
        ...(details.mediaKind === 'movie' || details.mediaKind === 'show'
          ? { mediaKind: details.mediaKind }
          : {}),
        ...(typeof details.season === 'number' ? { season: details.season } : {}),
        ...(typeof details.episode === 'number' ? { episode: details.episode } : {}),
      };
      features.progress = Object.keys(progress).length === 1 ? null : progress;
    } else if (input.details === null && legacyBehaviour === 'watch') {
      features.progress = null;
    }
    if (details?.behaviour === 'meals') {
      const ingredients = Array.isArray(details.ingredients) ? details.ingredients : [];
      let previousRank: string | undefined;
      features.subItems = {
        entries: ingredients.flatMap((ingredient) => {
          const entry = objectValue(ingredient);
          if (
            entry === undefined ||
            typeof entry.ingredientId !== 'string' ||
            typeof entry.name !== 'string'
          ) {
            return [];
          }
          const rank =
            previousRank === undefined ? FIRST_RANK : lexoRankBetween(previousRank);
          previousRank = rank;
          return [
            {
              id: `sub_${entry.ingredientId.startsWith('ing_') ? entry.ingredientId.slice(4) : entry.ingredientId}`,
              title: entry.name,
              ...(typeof entry.quantity === 'string'
                ? { secondary: entry.quantity }
                : {}),
              rank,
            },
          ];
        }),
      };
    } else if (input.details === null && legacyBehaviour === 'meals') {
      features.subItems = null;
    }
  }
  if (Object.keys(features).length > 0) next.features = features;
  return next;
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
  {
    version: 9,
    name: 'agenda-projection-version-fence',
    apply: (database) =>
      database.exec(`
        ALTER TABLE agenda_rows ADD COLUMN projection_fence_version TEXT;
        CREATE INDEX agenda_rows_projection_fence
          ON agenda_rows (activity_id, projection_fence_version)
          WHERE projection_fence_version IS NOT NULL;
      `),
  },
  {
    version: 10,
    name: 'durable-activity-projection-fences',
    apply: (database) =>
      database.exec(`
        CREATE TABLE agenda_projection_fences (
          activity_id TEXT PRIMARY KEY NOT NULL,
          expected_version TEXT NOT NULL
        );
        INSERT INTO agenda_projection_fences (activity_id, expected_version)
          SELECT activity_id, MAX(projection_fence_version)
          FROM agenda_rows
          WHERE projection_fence_version IS NOT NULL
          GROUP BY activity_id;
        DROP INDEX agenda_rows_projection_fence;
        ALTER TABLE agenda_rows DROP COLUMN projection_fence_version;
      `),
  },
  {
    version: 11,
    name: 'native-lists-index',
    /**
     * The Lists index's materialized `META` rows (P3-25, ADR-057).
     *
     * **Columns, not a JSON blob**, on the `anytime_rows` precedent: every field here is one
     * the card renders or the index filters on, and a blob would make `archived` — the
     * client-side filter the whole screen turns on — unqueryable without parsing every row.
     *
     * `position` is **the server's pointer order**, stored as the ordinal the page arrived in.
     * `ListIndex` carries `role` and `addedAt` only (ADR-042) and stores no rank, so there is
     * nothing else a faithful order could come from and no client sort that could be right;
     * `interaction-contract.md` §3.2 says the index is not reorderable for the same reason.
     * Persisting the ordinal is what lets a subscription read rows back in that order without
     * the screen re-deriving it.
     *
     * `last_item_activity_at` is stored beside `updated_at` rather than instead of it: the
     * card renders the first (P3-47) and `If-Match` carries the second, and a table holding
     * one would force a refetch to do the other.
     */
    apply: (database) =>
      database.exec(`
        CREATE TABLE list_rows (
          list_id TEXT PRIMARY KEY NOT NULL,
          position INTEGER NOT NULL,
          owner_id TEXT NOT NULL,
          behaviour TEXT NOT NULL,
          template_key TEXT NOT NULL,
          title TEXT NOT NULL,
          icon TEXT NOT NULL,
          empty_state_copy TEXT NOT NULL,
          checkable INTEGER NOT NULL CHECK (checkable IN (0, 1)),
          supports_location INTEGER NOT NULL CHECK (supports_location IN (0, 1)),
          slot TEXT,
          source_activity_id TEXT,
          item_count INTEGER NOT NULL,
          unchecked_count INTEGER NOT NULL,
          member_count INTEGER NOT NULL,
          rank_version INTEGER NOT NULL,
          archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
          updated_at TEXT NOT NULL,
          last_item_activity_at TEXT NOT NULL
        );
        CREATE INDEX list_rows_position ON list_rows (position, list_id);
      `),
  },
  {
    version: 12,
    name: 'durable-list-archive-undo',
    /**
     * Bridges the archive acknowledgement's opaque server token to the six-second native
     * Undo offer. The inverse may be accepted while the archive is still in flight, so the
     * row links both durable intents until settlement installs the token on the dependent.
     */
    apply: (database) =>
      database.exec(`
        CREATE TABLE list_archive_undo_offers (
          original_intent_id TEXT PRIMARY KEY NOT NULL,
          current_intent_id TEXT UNIQUE NOT NULL,
          list_id TEXT NOT NULL,
          inverse_intent_id TEXT,
          undo_token TEXT,
          undo_expires_at TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX list_archive_undo_offers_list
          ON list_archive_undo_offers (list_id, created_at);
      `),
  },
  {
    version: 13,
    name: 'native-list-items',
    /**
     * The item slice behind list detail (P3-27, ADR-057).
     *
     * ## Order is `(rank, item_id)`, and the index says so
     *
     * There is no `position` column, and the difference from `list_rows` is the whole reason:
     * the index reproduces a server *pointer order* it cannot compute, while items carry an
     * authoritative lexo `rank` every client can sort by. `item_id` breaks ties because equal
     * ranks are **expected** — two people adding at the same position produce them — and the
     * pair is what makes the order stable on both phones
     * (`plans-and-lists.md` §5.11.5, `compareListItems`).
     *
     * ## Why the page state is its own table
     *
     * An item page's cursor is bound to the `rank_version` that issued it. When repair or a
     * behaviour migration moves that version the server answers `503`, and the contract is to
     * discard **every** cursor and restart at page one, installing nothing until it succeeds
     * (§P3-27). Keeping the cursor beside the rows would make "discard the cursor" and
     * "keep the committed rows" the same statement, which is precisely what the contract
     * separates. `complete` is what lets a reader distinguish a fully drained list from a
     * prefix, so no empty-state or bulk decision ever reads a loaded page as the whole list.
     *
     * `item_count` is not here either: it is META's, on `list_rows`, and a second copy derived
     * from loaded rows is the mistake criterion 36 names.
     */
    apply: (database) =>
      database.exec(`
        CREATE TABLE list_items (
          item_id TEXT PRIMARY KEY NOT NULL,
          list_id TEXT NOT NULL,
          rank TEXT NOT NULL,
          title TEXT NOT NULL,
          note TEXT,
          checked INTEGER NOT NULL CHECK (checked IN (0, 1)),
          location_json TEXT,
          source_activity_id TEXT,
          source_label TEXT,
          details_json TEXT
        );
        CREATE INDEX list_items_order ON list_items (list_id, rank, item_id);

        CREATE TABLE list_item_pages (
          list_id TEXT PRIMARY KEY NOT NULL,
          rank_version INTEGER NOT NULL,
          next_cursor TEXT,
          complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
          updated_at TEXT NOT NULL
        );
      `),
  },
  {
    version: 14,
    name: 'canonical-list-model',
    /**
     * Rebuilds both list tables in one transaction. There is no dual-write window: either
     * every aggregate is on the P3-33 model or the migration transaction rolls back.
     */
    apply: async (database) => {
      const lists = await database.all(
        'SELECT * FROM list_rows ORDER BY position, list_id;',
      );
      const items = await database.all(
        'SELECT * FROM list_items ORDER BY list_id, rank, item_id;',
      );
      const legacyListsById = new Map<string, JsonObject>();
      const text = (row: Record<string, unknown>, key: string) =>
        typeof row[key] === 'string' ? (row[key] as string) : undefined;
      const number = (row: Record<string, unknown>, key: string) =>
        typeof row[key] === 'number' ? (row[key] as number) : 0;
      const json = (row: Record<string, unknown>, key: string) => {
        const value = text(row, key);
        return value === undefined ? undefined : (JSON.parse(value) as unknown);
      };

      await database.exec(`
        CREATE TABLE list_rows_p333 (
          list_id TEXT PRIMARY KEY NOT NULL,
          position INTEGER NOT NULL,
          schema_version INTEGER NOT NULL CHECK (schema_version = 2),
          owner_id TEXT NOT NULL,
          template_key TEXT NOT NULL,
          title TEXT NOT NULL,
          icon TEXT NOT NULL,
          empty_state_copy TEXT NOT NULL,
          item_state_mode_json TEXT NOT NULL,
          feature_config_json TEXT NOT NULL,
          slot TEXT,
          source_activity_id TEXT,
          item_count INTEGER NOT NULL,
          done_count INTEGER NOT NULL,
          member_count INTEGER NOT NULL,
          rank_version INTEGER NOT NULL,
          archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
          updated_at TEXT NOT NULL,
          last_item_activity_at TEXT NOT NULL
        );
        CREATE TABLE list_items_p333 (
          item_id TEXT PRIMARY KEY NOT NULL,
          list_id TEXT NOT NULL,
          rank TEXT NOT NULL,
          title TEXT NOT NULL,
          note TEXT,
          state TEXT NOT NULL CHECK (state IN ('open', 'active', 'done')),
          features_json TEXT,
          source_activity_id TEXT,
          source_label TEXT
        );
      `);

      for (const oldList of lists) {
        const listId = text(oldList, 'list_id') ?? '';
        legacyListsById.set(listId, oldList);
        const oldItems = items.filter((row) => text(row, 'list_id') === listId);
        const converted = migrateLegacyListAggregate({
          list: {
            listId,
            ownerId: text(oldList, 'owner_id') ?? '',
            behaviour: text(oldList, 'behaviour') as 'collection' | 'watch' | 'meals',
            templateKey: text(oldList, 'template_key') ?? 'blank',
            title: text(oldList, 'title') ?? '',
            icon: text(oldList, 'icon') ?? '',
            emptyStateCopy: text(oldList, 'empty_state_copy') ?? '',
            capabilities: {
              checkable: number(oldList, 'checkable') === 1,
              supportsLocation: number(oldList, 'supports_location') === 1,
            },
            slot: (text(oldList, 'slot') ?? null) as null,
            ...(text(oldList, 'source_activity_id') === undefined
              ? {}
              : { sourceActivityId: text(oldList, 'source_activity_id') }),
            itemCount: number(oldList, 'item_count'),
            uncheckedCount: number(oldList, 'unchecked_count'),
            memberCount: number(oldList, 'member_count'),
            rankVersion: number(oldList, 'rank_version'),
            archived: number(oldList, 'archived') === 1,
            updatedAt: text(oldList, 'updated_at') ?? '',
            lastItemActivityAt: text(oldList, 'last_item_activity_at') ?? '',
          },
          items: oldItems.map((row) => ({
            itemId: text(row, 'item_id') ?? '',
            listId,
            rank: text(row, 'rank') ?? '',
            itemRevision: 0,
            title: text(row, 'title') ?? '',
            ...(text(row, 'note') === undefined ? {} : { note: text(row, 'note') }),
            checked: number(row, 'checked') === 1,
            ...(json(row, 'location_json') === undefined
              ? {}
              : { location: json(row, 'location_json') }),
            ...(text(row, 'source_activity_id') === undefined
              ? {}
              : { sourceActivityId: text(row, 'source_activity_id') }),
            ...(text(row, 'source_label') === undefined
              ? {}
              : { sourceLabel: text(row, 'source_label') }),
            ...(json(row, 'details_json') === undefined
              ? {}
              : { details: json(row, 'details_json') }),
          })),
        } as Parameters<typeof migrateLegacyListAggregate>[0]);

        await database.run(
          `INSERT INTO list_rows_p333 VALUES (?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            converted.list.listId,
            number(oldList, 'position'),
            converted.list.ownerId,
            converted.list.templateKey,
            converted.list.title,
            converted.list.icon,
            converted.list.emptyStateCopy,
            JSON.stringify(converted.list.itemStateMode),
            JSON.stringify(converted.list.featureConfig),
            converted.list.slot,
            converted.list.sourceActivityId ?? null,
            converted.list.itemCount,
            converted.list.doneCount,
            converted.list.memberCount,
            converted.list.rankVersion,
            converted.list.archived ? 1 : 0,
            converted.list.updatedAt,
            converted.list.lastItemActivityAt,
          ],
        );
        for (const item of converted.items) {
          await database.run(
            `INSERT INTO list_items_p333 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            [
              item.itemId,
              item.listId,
              item.rank,
              item.title,
              item.note ?? null,
              item.state,
              item.features === undefined ? null : JSON.stringify(item.features),
              item.sourceActivityId ?? null,
              item.sourceLabel ?? null,
            ],
          );
        }
      }

      /*
       * The projection and its durable intent are one local write. Rebuilding only the tables
       * would leave an older payload waiting to replay against canonical routes after launch.
       * Translate every List intent in place, retaining its id, sequence, status, attempts,
       * dependency/compensation links, ordering lane and archive-Undo offer.
       */
      const intentRows = await database.all(
        `SELECT intent_id, mutation_key_json, variables_json, entity_id, ordering_key,
                created_at, status, depends_on_intent_id, compensation_for_intent_id
         FROM outbox_intents
         WHERE json_extract(mutation_key_json, '$[0]') = 'list'
         ORDER BY seq;`,
      );
      const configurationAtIntent = new Map<string, LegacyListConfigurationSnapshot>();
      const configurationBeforeIntent = new Map<
        string,
        LegacyListConfigurationSnapshot
      >();
      const workingConfigurations = new Map<string, LegacyListConfigurationSnapshot>(
        [...legacyListsById].map(([listId, row]) => [
          listId,
          {
            behaviour: typeof row.behaviour === 'string' ? row.behaviour : 'collection',
            checkable: number(row, 'checkable') === 1,
            supportsLocation: number(row, 'supports_location') === 1,
          },
        ]),
      );
      /* Walk the optimistic lane backwards so every rollback snapshot keeps its own era. */
      for (const intentRow of [...intentRows].reverse()) {
        const mutationKey = json(intentRow, 'mutation_key_json');
        const variables = objectValue(json(intentRow, 'variables_json'));
        const intentId = text(intentRow, 'intent_id');
        const entityId = text(intentRow, 'entity_id');
        if (
          !Array.isArray(mutationKey) ||
          mutationKey[0] !== 'list' ||
          variables === undefined ||
          intentId === undefined ||
          entityId === undefined
        )
          continue;
        const listId = typeof variables.listId === 'string' ? variables.listId : entityId;
        const current = workingConfigurations.get(listId);
        if (current === undefined) continue;
        configurationAtIntent.set(intentId, current);
        const before = { ...current };
        const previous = objectValue(variables.previous);
        const previousCapabilities = objectValue(previous?.capabilities);
        if (mutationKey[1] === 'behaviour' && typeof previous?.behaviour === 'string') {
          before.behaviour = previous.behaviour;
        }
        if (mutationKey[1] === 'patch') {
          if (typeof previousCapabilities?.checkable === 'boolean') {
            before.checkable = previousCapabilities.checkable;
          }
          if (typeof previousCapabilities?.supportsLocation === 'boolean') {
            before.supportsLocation = previousCapabilities.supportsLocation;
          }
        }
        configurationBeforeIntent.set(intentId, before);
        workingConfigurations.set(listId, before);
      }
      let nextSeq = number(
        (await database.first('SELECT next_seq FROM outbox_meta WHERE singleton = 1;')) ??
          {},
        'next_seq',
      );
      for (const intentRow of intentRows) {
        const mutationKey = json(intentRow, 'mutation_key_json');
        const variables = objectValue(json(intentRow, 'variables_json'));
        const intentId = text(intentRow, 'intent_id');
        const entityId = text(intentRow, 'entity_id');
        const orderingKey = text(intentRow, 'ordering_key');
        if (
          !Array.isArray(mutationKey) ||
          mutationKey[0] !== 'list' ||
          typeof mutationKey[1] !== 'string' ||
          variables === undefined ||
          intentId === undefined ||
          entityId === undefined ||
          orderingKey === undefined
        ) {
          continue;
        }
        const listId = typeof variables.listId === 'string' ? variables.listId : entityId;
        const oldList = legacyListsById.get(listId);
        const currentConfiguration = configurationAtIntent.get(intentId);
        const previousConfiguration = configurationBeforeIntent.get(intentId);
        const legacyBehaviour =
          currentConfiguration?.behaviour ??
          (typeof oldList?.behaviour === 'string' ? oldList.behaviour : undefined);
        let nextName = mutationKey[1];
        const nextVariables: JsonObject = { ...variables };
        const stateFollowups: Array<{ itemId: string; state: ListItem['state'] }> = [];

        if (nextName === 'create') {
          const seed = objectValue(variables.seed);
          const capabilities = objectValue(seed?.capabilities);
          if (seed !== undefined && typeof seed.behaviour === 'string') {
            nextVariables.seed = {
              itemStateMode: stateModeForLegacyConfiguration(
                seed.behaviour,
                capabilities?.checkable === true,
              ),
              featureConfig: featureConfigForLegacyConfiguration(
                seed.behaviour,
                capabilities?.supportsLocation === true,
              ),
              slot: seed.slot ?? null,
              icon: seed.icon,
              emptyStateCopy: seed.emptyStateCopy,
            };
          }
        } else if (nextName === 'patch') {
          nextVariables.input =
            translateLegacySettings(
              variables.input,
              currentConfiguration?.behaviour ?? 'collection',
            ) ?? variables.input;
          if (variables.previous !== undefined) {
            nextVariables.previous =
              translateLegacySettings(
                variables.previous,
                previousConfiguration?.behaviour ?? 'collection',
              ) ?? variables.previous;
          }
        } else if (nextName === 'behaviour') {
          nextName = 'patch';
          if (currentConfiguration !== undefined) {
            nextVariables.input = {
              itemStateMode: stateModeForLegacyConfiguration(
                currentConfiguration.behaviour,
                currentConfiguration.checkable,
              ),
              featureConfig: featureConfigForLegacyConfiguration(
                currentConfiguration.behaviour,
                currentConfiguration.supportsLocation,
              ),
            };
          }
          const previous = objectValue(variables.previous);
          const previousBehaviour =
            typeof previous?.behaviour === 'string' ? previous.behaviour : undefined;
          if (previousBehaviour !== undefined) {
            const before = previousConfiguration ?? currentConfiguration;
            nextVariables.previous = {
              itemStateMode: stateModeForLegacyConfiguration(
                previousBehaviour,
                before?.checkable ?? false,
              ),
              featureConfig: featureConfigForLegacyConfiguration(
                previousBehaviour,
                before?.supportsLocation ?? false,
              ),
            };
          } else {
            delete nextVariables.previous;
          }
        } else if (nextName === 'item-create' || nextName === 'item-patch') {
          const itemId =
            typeof variables.itemId === 'string' ? variables.itemId : entityId;
          const translated = translateLegacyItemInput(variables.input, legacyBehaviour);
          if (translated !== undefined) {
            if (nextName === 'item-create') {
              const translatedState = translated.state;
              delete translated.state;
              if (translatedState === 'active' || translatedState === 'done') {
                stateFollowups.push({ itemId, state: translatedState });
              }
            }
            nextVariables.input = translated;
          }
        } else if (nextName === 'bulk') {
          const input = objectValue(variables.input);
          if (Array.isArray(input?.items)) {
            nextVariables.input = {
              items: input.items.map((candidate) => {
                const oldInput = objectValue(candidate);
                const itemId =
                  typeof oldInput?.itemId === 'string' ? oldInput.itemId : undefined;
                const translated =
                  translateLegacyItemInput(candidate, legacyBehaviour) ?? candidate;
                const translatedObject = objectValue(translated);
                const translatedState = translatedObject?.state;
                if (translatedObject !== undefined) delete translatedObject.state;
                if (
                  itemId !== undefined &&
                  (translatedState === 'active' || translatedState === 'done')
                ) {
                  stateFollowups.push({ itemId, state: translatedState });
                }
                return translated;
              }),
            };
          }
        }

        const nextMutationKey = ['list', nextName];
        const dependsOnIntentId = text(intentRow, 'depends_on_intent_id');
        const compensationForIntentId = text(intentRow, 'compensation_for_intent_id');
        const semanticKey = migratedIntentSemanticKey({
          mutationKey: nextMutationKey,
          variables: nextVariables,
          entityId,
          orderingKey,
          ...(dependsOnIntentId === undefined ? {} : { dependsOnIntentId }),
          ...(compensationForIntentId === undefined ? {} : { compensationForIntentId }),
        });
        await database.run(
          `UPDATE outbox_intents
           SET mutation_key_json = ?, variables_json = ?, semantic_key = ?
           WHERE intent_id = ?;`,
          [
            JSON.stringify(nextMutationKey),
            JSON.stringify(nextVariables),
            semanticKey,
            intentId,
          ],
        );

        for (const followup of stateFollowups) {
          const followupIntentId = `${intentId}:p333-state:${followup.itemId}`;
          const followupVariables = {
            listId,
            itemId: followup.itemId,
            intentId: followupIntentId,
            idempotencyKey: followupIntentId,
            input: { state: followup.state },
          };
          const followupMutationKey = ['list', 'item-patch'];
          const followupSemanticKey = migratedIntentSemanticKey({
            mutationKey: followupMutationKey,
            variables: followupVariables,
            entityId: followup.itemId,
            orderingKey,
            dependsOnIntentId: intentId,
          });
          await database.run(
            `INSERT INTO outbox_intents (
               intent_id, mutation_key_json, variables_json, entity_id, ordering_key,
               status, created_at, seq, attempts, depends_on_intent_id, semantic_key
             ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?);`,
            [
              followupIntentId,
              JSON.stringify(followupMutationKey),
              JSON.stringify(followupVariables),
              followup.itemId,
              orderingKey,
              number(intentRow, 'created_at'),
              nextSeq,
              intentId,
              followupSemanticKey,
            ],
          );
          nextSeq += 1;
        }
      }
      await database.run(
        'UPDATE outbox_meta SET next_seq = ? WHERE singleton = 1 AND next_seq < ?;',
        [nextSeq, nextSeq],
      );

      await database.exec(`
        DROP TABLE list_items;
        ALTER TABLE list_items_p333 RENAME TO list_items;
        CREATE INDEX list_items_order ON list_items (list_id, rank, item_id);
        DROP TABLE list_rows;
        ALTER TABLE list_rows_p333 RENAME TO list_rows;
        CREATE INDEX list_rows_position ON list_rows (position, list_id);
      `);
    },
  },
  {
    version: 15,
    name: 'durable-list-item-delete-undo',
    /**
     * Keeps the optimistic snapshot and the server-authored receipt across the six-second
     * offer. Undo may be accepted before the delete response exists, so the dependent durable
     * intent and its token are linked here rather than held in component memory.
     */
    apply: (database) =>
      database.exec(`
        CREATE TABLE list_item_delete_undo_offers (
          original_intent_id TEXT PRIMARY KEY NOT NULL,
          current_intent_id TEXT UNIQUE NOT NULL,
          inverse_intent_id TEXT,
          list_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          previous_json TEXT NOT NULL,
          undo_token TEXT,
          undo_expires_at TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX list_item_delete_undo_offers_list
          ON list_item_delete_undo_offers (list_id, created_at);
      `),
  },
  {
    version: 16,
    name: 'durable-outbox-local-failure-streak',
    /**
     * A poison intent must make the same bounded decision after process restart. The
     * fingerprint is diagnostic state only; user-facing error copy remains in `last_error`.
     */
    apply: (database) =>
      database.exec(`
        ALTER TABLE outbox_intents ADD COLUMN local_failure_fingerprint TEXT;
        ALTER TABLE outbox_intents ADD COLUMN local_failure_count INTEGER NOT NULL DEFAULT 0
          CHECK (local_failure_count >= 0);
      `),
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
