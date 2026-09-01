import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqliteDatabase } from '@/lib/sqlite/database';
import {
  FOUNDATION_MIGRATIONS,
  runMigrations,
  type SqliteMigration,
  SqliteMigrationError,
} from '@/lib/sqlite/migrations';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';

describe('versioned SQLite migrations', () => {
  let directory = '';
  let database: SqliteDatabase | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ordinarydays-migrations-'));
    database = await createNodeSqliteFactory(directory).open('migrations.sqlite');
  });

  afterEach(async () => {
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('orders migrations and makes a completed rerun a no-op', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    const applied: number[] = [];
    const migrations: readonly SqliteMigration[] = [
      {
        version: 1,
        name: 'first',
        apply: async (transaction) => {
          applied.push(1);
          await transaction.exec('CREATE TABLE first_value (id TEXT PRIMARY KEY);');
        },
      },
      {
        version: 2,
        name: 'second',
        apply: async (transaction) => {
          applied.push(2);
          await transaction.exec('CREATE TABLE second_value (id TEXT PRIMARY KEY);');
        },
      },
    ];

    await runMigrations(database, migrations, () => '2026-08-19T00:00:00.000Z');
    await runMigrations(database, migrations, () => '2026-08-19T00:00:01.000Z');

    expect(applied).toEqual([1, 2]);
    expect(
      await database.all('SELECT version, name FROM schema_migrations ORDER BY version;'),
    ).toEqual([
      { version: 1, name: 'first' },
      { version: 2, name: 'second' },
    ]);
  });

  it('rolls an interrupted migration back and resumes from the last committed version', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    const first: SqliteMigration = {
      version: 1,
      name: 'committed',
      apply: (transaction) =>
        transaction.exec('CREATE TABLE committed_value (id TEXT PRIMARY KEY);'),
    };
    const interrupted: SqliteMigration = {
      version: 2,
      name: 'interrupted',
      apply: async (transaction) => {
        await transaction.exec('CREATE TABLE interrupted_value (id TEXT PRIMARY KEY);');
        throw new Error('simulated process interruption');
      },
    };

    await expect(runMigrations(database, [first, interrupted])).rejects.toThrow(
      'simulated process interruption',
    );
    expect(
      await database.all('SELECT version FROM schema_migrations ORDER BY version;'),
    ).toEqual([{ version: 1 }]);
    expect(
      await database.first(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'interrupted_value';",
      ),
    ).toBeUndefined();

    await database.close();
    database = await createNodeSqliteFactory(directory).open('migrations.sqlite');

    const repaired: SqliteMigration = {
      version: 2,
      name: 'interrupted',
      apply: (transaction) =>
        transaction.exec('CREATE TABLE interrupted_value (id TEXT PRIMARY KEY);'),
    };
    await runMigrations(database, [first, repaired]);

    expect(
      await database.all('SELECT version FROM schema_migrations ORDER BY version;'),
    ).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it('rejects a gap or stored history that does not match this build', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    const invalid: SqliteMigration = {
      version: 2,
      name: 'gap',
      apply: async () => undefined,
    };
    await expect(runMigrations(database, [invalid])).rejects.toBeInstanceOf(
      SqliteMigrationError,
    );

    await database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES (1, 'different-build', '2026-08-19T00:00:00Z');
    `);
    await expect(
      runMigrations(database, [
        { version: 1, name: 'expected', apply: async () => undefined },
      ]),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
  });

  it('seeks targeted Agenda writes by activity and occurrence before viewer date', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');

    const previousMigrations = FOUNDATION_MIGRATIONS.slice(0, 4);
    await runMigrations(database, previousMigrations);
    await runMigrations(database, FOUNDATION_MIGRATIONS);

    expect(
      await database.all("SELECT name FROM pragma_index_info('agenda_rows_activity');"),
    ).toEqual([
      { name: 'activity_id' },
      { name: 'occurrence_date' },
      { name: 'viewer_date' },
    ]);

    const lookupPlan = await database.all(
      `EXPLAIN QUERY PLAN
       SELECT viewer_date FROM agenda_rows
       WHERE activity_id = ? AND occurrence_date IS ?
       ORDER BY viewer_date
       LIMIT 1;`,
      ['act_index_probe', '2026-08-19'],
    );
    const deletePlan = await database.all(
      `EXPLAIN QUERY PLAN
       DELETE FROM agenda_rows
       WHERE activity_id = ? AND occurrence_date IS ?;`,
      ['act_index_probe', '2026-08-19'],
    );
    const targetDayPlan = await database.all(
      `EXPLAIN QUERY PLAN
       SELECT viewer_date, section, sort_order, activity_id FROM agenda_rows
       WHERE viewer_date = (
         SELECT viewer_date FROM agenda_rows
         WHERE activity_id = ? AND occurrence_date IS ?
         ORDER BY viewer_date
         LIMIT 1
       )
       ORDER BY viewer_date, section, sort_order, activity_id;`,
      ['act_index_probe', '2026-08-19'],
    );
    const usesTargetIndex = (rows: readonly Record<string, unknown>[]) =>
      rows.some((row) =>
        String(row.detail).includes(
          'agenda_rows_activity (activity_id=? AND occurrence_date=?)',
        ),
      );

    expect(usesTargetIndex(lookupPlan)).toBe(true);
    expect(usesTargetIndex(deletePlan)).toBe(true);
    expect(usesTargetIndex(targetDayPlan)).toBe(true);
    expect(
      targetDayPlan.some((row) => String(row.detail).includes('agenda_rows_window')),
    ).toBe(true);
  });

  it('scans only unresolved outbox rows for capacity and pending-create checks', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    await runMigrations(database, FOUNDATION_MIGRATIONS);

    const capacityPlan = await database.all(
      `EXPLAIN QUERY PLAN
       SELECT COUNT(*) FROM outbox_intents
       WHERE status IN ('queued', 'in_flight', 'needs_attention');`,
    );
    const createPlan = await database.all(
      `EXPLAIN QUERY PLAN
       SELECT intent_id FROM outbox_intents
       WHERE entity_id = ?
         AND status IN ('queued', 'in_flight', 'needs_attention')
         AND json_extract(mutation_key_json, '$[0]') = 'activity'
         AND json_extract(mutation_key_json, '$[1]') = 'create'
       LIMIT 1;`,
      ['act_index_probe'],
    );

    expect(
      capacityPlan.some((row) => String(row.detail).includes('outbox_intents_replay')),
    ).toBe(true);
    expect(
      createPlan.some((row) =>
        String(row.detail).includes('outbox_intents_active_entity_mutation'),
      ),
    ).toBe(true);
  });

  it('adds a durable zero-based account commit revision without changing it on rerun', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    await runMigrations(database, FOUNDATION_MIGRATIONS.slice(0, 6));

    expect(
      await database.first(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'native_commit_state';",
      ),
    ).toBeUndefined();

    await runMigrations(database, FOUNDATION_MIGRATIONS);
    await runMigrations(database, FOUNDATION_MIGRATIONS);

    expect(
      await database.first('SELECT singleton, commit_revision FROM native_commit_state;'),
    ).toEqual({ singleton: 1, commit_revision: 0 });
  });

  it('repairs only provable local-create and legacy missing-capability versions', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    await runMigrations(database, FOUNDATION_MIGRATIONS.slice(0, 7));
    const insert = async (
      activityId: string,
      localState: string,
      capabilities: string | null,
    ) =>
      database?.run(
        `INSERT INTO activities (
          activity_id, owner_id, object_kind, type, status, title,
          participant_count, child_count, expense_total_cents, visibility,
          details_json, ics_sequence, created_at, last_activity_at, updated_at,
          schema_version, local_state, capabilities_json, canonical_version
        ) VALUES (?, 'usr_owner', 'task', 'task', 'scheduled', 'Migration row',
          0, 0, 0, 'private', '{"kind":"task"}', 0,
          '2026-08-19T00:00:00.000Z', '2026-08-19T23:00:00.000Z',
          '2026-08-19T23:00:00.000Z', 1, ?, ?, '2026-08-19T23:00:00.000Z');`,
        [activityId, localState, capabilities],
      );
    await insert('act_local_create', 'queued', null);
    await insert('act_edited_server', 'queued', null);
    await insert('act_legacy_missing_capabilities', 'canonical', null);
    await insert('act_healthy_server', 'canonical', '{"complete":true}');
    await database.run(
      `INSERT INTO outbox_intents (
        intent_id, mutation_key_json, variables_json, entity_id, ordering_key,
        status, created_at, seq, attempts, semantic_key
      ) VALUES (
        'intent_local_create', '["activity","create"]', '{}', 'act_local_create',
        'activity:act_local_create', 'queued', 1, 1, 0, 'create:act_local_create'
      );`,
    );

    await runMigrations(database, FOUNDATION_MIGRATIONS);

    expect(
      await database.all(
        `SELECT activity_id, canonical_version FROM activities
         ORDER BY activity_id;`,
      ),
    ).toEqual([
      {
        activity_id: 'act_edited_server',
        canonical_version: '2026-08-19T23:00:00.000Z',
      },
      {
        activity_id: 'act_healthy_server',
        canonical_version: '2026-08-19T23:00:00.000Z',
      },
      { activity_id: 'act_legacy_missing_capabilities', canonical_version: null },
      { activity_id: 'act_local_create', canonical_version: null },
    ]);
  });

  it('moves per-row Agenda projection fences into durable Activity-level state', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    await runMigrations(database, FOUNDATION_MIGRATIONS.slice(0, 9));
    await database.run(
      `INSERT INTO agenda_rows (
        row_id, viewer_date, section, sort_order, is_up_next, activity_id,
        type, title, status, is_recurring, is_snoozed, has_checkbox,
        capabilities_json, participant_avatars_json, participant_count, is_past,
        local_state, projection_fence_version
      ) VALUES (
        'legacy-row', '2026-08-20', 'anytime', 0, 0, 'act_legacy',
        'task', 'Legacy row', 'scheduled', 0, 0, 1,
        '{}', '[]', 0, 0, 'canonical', '2026-08-20T12:00:00.000Z'
      );`,
    );

    await runMigrations(database, FOUNDATION_MIGRATIONS);

    expect(
      await database.first(
        `SELECT activity_id, expected_version FROM agenda_projection_fences
         WHERE activity_id = 'act_legacy';`,
      ),
    ).toEqual({
      activity_id: 'act_legacy',
      expected_version: '2026-08-20T12:00:00.000Z',
    });
    expect(
      (await database.all('PRAGMA table_info(agenda_rows);')).some(
        (column) => column.name === 'projection_fence_version',
      ),
    ).toBe(false);
  });

  it('adds the durable bridge from archive acknowledgement to native Undo', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    await runMigrations(database, FOUNDATION_MIGRATIONS.slice(0, 11));

    expect(
      await database.first(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'list_archive_undo_offers';",
      ),
    ).toBeUndefined();

    await runMigrations(database, FOUNDATION_MIGRATIONS);

    expect(
      await database.first(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'list_archive_undo_offers';",
      ),
    ).toEqual({ name: 'list_archive_undo_offers' });
  });

  it('atomically upgrades legacy List projections and every queued payload without losing lane identity', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    await runMigrations(database, FOUNDATION_MIGRATIONS.slice(0, 13));

    const listId = 'lst_legacy_pending';
    const firstItemId = 'itm_legacy_edit';
    const createdItemId = 'itm_legacy_create';
    await database.run(
      `INSERT INTO list_rows (
         list_id, position, owner_id, behaviour, template_key, title, icon,
         empty_state_copy, checkable, supports_location, slot, source_activity_id,
         item_count, unchecked_count, member_count, rank_version, archived,
         updated_at, last_item_activity_at
       ) VALUES (?, 0, 'usr_owner', 'watch', 'legacy-watch', 'Queue', 'play',
         'Add a title.', 0, 0, 'watch', 'act_source', 2, 2, 1, 4, 0,
         '2026-08-28T10:00:00.000Z', '2026-08-28T10:00:00.000Z');`,
      [listId],
    );
    await database.run(
      `INSERT INTO list_items VALUES (?, ?, 'a', 'Edited show', 'Keep note', 0,
         '{"label":"Cinema"}', 'act_source', 'Source',
         '{"behaviour":"watch","watchStatus":"watching","mediaKind":"show","season":2,"episode":4}');`,
      [firstItemId, listId],
    );
    await database.run(
      `INSERT INTO list_items VALUES (?, ?, 'b', 'Created show', NULL, 0,
         NULL, NULL, NULL,
         '{"behaviour":"watch","watchStatus":"watched","mediaKind":"show","season":1,"episode":8}');`,
      [createdItemId, listId],
    );

    const appendLegacyIntent = async (
      intentId: string,
      seq: number,
      name: string,
      variables: object,
      entityId = listId,
      status = 'queued',
    ) =>
      database?.run(
        `INSERT INTO outbox_intents (
         intent_id, mutation_key_json, variables_json, entity_id, ordering_key,
         status, created_at, seq, attempts, semantic_key
       ) VALUES (?, ?, ?, ?, ?, ?, 100, ?, 2, ?);`,
        [
          intentId,
          JSON.stringify(['list', name]),
          JSON.stringify(variables),
          entityId,
          `list:${listId}`,
          status,
          seq,
          `legacy:${intentId}`,
        ],
      );
    await appendLegacyIntent('settings-intent', 1, 'patch', {
      listId,
      intentId: 'settings-intent',
      idempotencyKey: 'settings-intent',
      ifMatch: 'v1',
      input: { capabilities: { checkable: false } },
      previous: { capabilities: { checkable: true } },
    });
    await appendLegacyIntent(
      'behaviour-intent',
      2,
      'behaviour',
      {
        listId,
        intentId: 'behaviour-intent',
        idempotencyKey: 'behaviour-intent',
        ifMatch: 'v2',
        input: { behaviour: 'watch' },
        previous: { behaviour: 'collection' },
      },
      listId,
      'in_flight',
    );
    await appendLegacyIntent(
      'item-edit-intent',
      3,
      'item-patch',
      {
        listId,
        itemId: firstItemId,
        intentId: 'item-edit-intent',
        idempotencyKey: 'item-edit-intent',
        input: {
          checked: false,
          location: { label: 'Cinema' },
          details: {
            behaviour: 'watch',
            watchStatus: 'watching',
            mediaKind: 'show',
            season: 2,
            episode: 4,
          },
        },
      },
      firstItemId,
    );
    await appendLegacyIntent(
      'item-create-intent',
      4,
      'item-create',
      {
        listId,
        itemId: createdItemId,
        intentId: 'item-create-intent',
        idempotencyKey: 'item-create-intent',
        rank: 'b',
        input: {
          itemId: createdItemId,
          title: 'Created show',
          details: {
            behaviour: 'watch',
            watchStatus: 'watched',
            mediaKind: 'show',
            season: 1,
            episode: 8,
          },
        },
      },
      createdItemId,
    );
    await appendLegacyIntent('bulk-intent', 5, 'clear-checked', {
      listId,
      idempotencyKey: 'bulk-intent',
    });
    await appendLegacyIntent(
      'reorder-intent',
      6,
      'item-patch',
      {
        listId,
        itemId: firstItemId,
        intentId: 'reorder-intent',
        idempotencyKey: 'reorder-intent',
        input: { afterItemId: null },
      },
      firstItemId,
    );
    await database.run('UPDATE outbox_meta SET next_seq = 7 WHERE singleton = 1;');
    await database.run(
      `INSERT INTO list_archive_undo_offers (
         original_intent_id, current_intent_id, list_id, created_at
       ) VALUES ('behaviour-intent', 'behaviour-intent', ?, 100);`,
      [listId],
    );

    await runMigrations(database, FOUNDATION_MIGRATIONS);
    await runMigrations(database, FOUNDATION_MIGRATIONS);

    expect(
      await database.first(
        `SELECT schema_version, item_state_mode_json, feature_config_json,
              rank_version, source_activity_id
       FROM list_rows WHERE list_id = ?;`,
        [listId],
      ),
    ).toEqual({
      schema_version: 2,
      item_state_mode_json: JSON.stringify({
        mode: 'stages',
        labels: { open: 'Want to watch', active: 'Watching', done: 'Watched' },
        groupByState: true,
      }),
      feature_config_json: JSON.stringify({
        progress: { enabled: true, kind: 'episode' },
      }),
      rank_version: 5,
      source_activity_id: 'act_source',
    });
    expect(
      await database.all(
        `SELECT item_id, state, features_json, source_activity_id, source_label
       FROM list_items ORDER BY rank;`,
      ),
    ).toEqual([
      {
        item_id: firstItemId,
        state: 'active',
        features_json: JSON.stringify({
          place: { label: 'Cinema' },
          progress: { kind: 'episode', mediaKind: 'show', season: 2, episode: 4 },
        }),
        source_activity_id: 'act_source',
        source_label: 'Source',
      },
      {
        item_id: createdItemId,
        state: 'done',
        features_json: JSON.stringify({
          progress: { kind: 'episode', mediaKind: 'show', season: 1, episode: 8 },
        }),
        source_activity_id: null,
        source_label: null,
      },
    ]);

    const migratedIntents = await database.all(
      `SELECT intent_id, mutation_key_json, variables_json, entity_id, ordering_key,
              status, seq, attempts, depends_on_intent_id
       FROM outbox_intents ORDER BY seq;`,
    );
    expect(migratedIntents).toHaveLength(7);
    expect(migratedIntents[0]).toMatchObject({
      intent_id: 'settings-intent',
      entity_id: listId,
      ordering_key: `list:${listId}`,
      status: 'queued',
      seq: 1,
      attempts: 2,
    });
    expect(JSON.parse(String(migratedIntents[0]?.variables_json))).toMatchObject({
      input: { itemStateMode: { mode: 'none' } },
      previous: { itemStateMode: { mode: 'checkbox' } },
    });
    expect(JSON.parse(String(migratedIntents[1]?.mutation_key_json))).toEqual([
      'list',
      'patch',
    ]);
    expect(JSON.parse(String(migratedIntents[1]?.variables_json))).toMatchObject({
      input: {
        itemStateMode: { mode: 'stages' },
        featureConfig: { progress: { enabled: true, kind: 'episode' } },
      },
      previous: { itemStateMode: { mode: 'none' }, featureConfig: {} },
    });
    expect(migratedIntents[1]).toMatchObject({
      intent_id: 'behaviour-intent',
      status: 'in_flight',
      seq: 2,
      attempts: 2,
    });
    expect(JSON.parse(String(migratedIntents[2]?.variables_json))).toMatchObject({
      input: {
        state: 'active',
        features: {
          place: { label: 'Cinema' },
          progress: { kind: 'episode', mediaKind: 'show', season: 2, episode: 4 },
        },
      },
    });
    const migratedCreate = JSON.parse(String(migratedIntents[3]?.variables_json));
    expect(migratedCreate.input).toMatchObject({
      itemId: createdItemId,
      title: 'Created show',
      features: {
        progress: { kind: 'episode', mediaKind: 'show', season: 1, episode: 8 },
      },
    });
    expect(migratedCreate.input).not.toHaveProperty('state');
    expect(JSON.parse(String(migratedIntents[4]?.mutation_key_json))).toEqual([
      'list',
      'clear-checked',
    ]);
    expect(JSON.parse(String(migratedIntents[5]?.variables_json))).toMatchObject({
      input: { afterItemId: null },
    });
    expect(migratedIntents[6]).toMatchObject({
      intent_id: `item-create-intent:p333-state:${createdItemId}`,
      entity_id: createdItemId,
      ordering_key: `list:${listId}`,
      status: 'queued',
      seq: 7,
      attempts: 0,
      depends_on_intent_id: 'item-create-intent',
    });
    expect(JSON.parse(String(migratedIntents[6]?.variables_json))).toMatchObject({
      input: { state: 'done' },
    });
    expect(
      await database.first(
        `SELECT original_intent_id, current_intent_id, list_id
       FROM list_archive_undo_offers;`,
      ),
    ).toEqual({
      original_intent_id: 'behaviour-intent',
      current_intent_id: 'behaviour-intent',
      list_id: listId,
    });
    expect(
      await database.first('SELECT next_seq FROM outbox_meta WHERE singleton = 1;'),
    ).toEqual({ next_seq: 8 });
  });

  it('adds durable local-failure streak fields without changing existing intents', async () => {
    if (database === undefined) throw new Error('missing migration test database');
    await runMigrations(database, FOUNDATION_MIGRATIONS.slice(0, 15));
    await database.run(
      `INSERT INTO outbox_intents (
         intent_id, mutation_key_json, variables_json, entity_id, ordering_key,
         status, created_at, seq, semantic_key
       ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?);`,
      [
        'existing-intent',
        JSON.stringify(['activity', 'patch']),
        JSON.stringify({ input: { title: 'Existing' } }),
        'act_existing',
        'activity:act_existing',
        1,
        1,
        'existing-semantic-key',
      ],
    );

    await runMigrations(database, FOUNDATION_MIGRATIONS);

    expect(
      await database.first(
        `SELECT intent_id, local_failure_fingerprint, local_failure_count
         FROM outbox_intents WHERE intent_id = 'existing-intent';`,
      ),
    ).toEqual({
      intent_id: 'existing-intent',
      local_failure_fingerprint: null,
      local_failure_count: 0,
    });
  });

  it('derives legacy child restoration from each child Activity schedule', async () => {
    if (database === undefined) throw new Error('missing migration test database');
    await runMigrations(database, FOUNDATION_MIGRATIONS.slice(0, 19));
    const parentId = 'act_migration_parent';
    const savedId = 'act_migration_saved_child';
    const scheduledId = 'act_migration_scheduled_child';
    const insertActivity = async (activityId: string, scheduleDate?: string) =>
      database?.run(
        `INSERT INTO activities (
           activity_id, owner_id, object_kind, type, status, title, schedule_date,
           participant_count, child_count, expense_total_cents, visibility, details_json,
           ics_sequence, created_at, last_activity_at, updated_at, schema_version
         ) VALUES (?, 'usr_migration', 'task', 'task', 'completed', ?, ?,
           0, 0, 0, 'private', '{"kind":"task"}', 0,
           '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z',
           '2026-08-19T00:00:00.000Z', 1);`,
        [activityId, activityId, scheduleDate ?? null],
      );
    await insertActivity(savedId);
    await insertActivity(scheduledId, '2026-08-20');
    await database.run(
      `INSERT INTO activity_children
         (parent_activity_id, child_activity_id, ordinal, title, status, is_recurring)
       VALUES
         (?, ?, 0, 'Saved child', 'completed', 0),
         (?, ?, 1, 'Scheduled child', 'completed', 0);`,
      [parentId, savedId, parentId, scheduledId],
    );

    await runMigrations(database, FOUNDATION_MIGRATIONS);

    expect(
      await database.all(
        `SELECT child_activity_id, restored_status FROM activity_children
         WHERE parent_activity_id = ? ORDER BY ordinal;`,
        [parentId],
      ),
    ).toEqual([
      { child_activity_id: savedId, restored_status: 'saved' },
      { child_activity_id: scheduledId, restored_status: 'scheduled' },
    ]);
  });

  it('invalidates a legacy child projection when its restoration state is unknowable', async () => {
    if (database === undefined) throw new Error('missing migration test database');
    await runMigrations(database, FOUNDATION_MIGRATIONS.slice(0, 19));
    const parentId = 'act_migration_parent_only';
    const missingChildId = 'act_migration_missing_dated_child';
    await database.run(
      `INSERT INTO activity_detail_projection_state
         (activity_id, children_installed, source_lists_installed)
       VALUES (?, 1, 0);`,
      [parentId],
    );
    await database.run(
      `INSERT INTO activity_children
         (parent_activity_id, child_activity_id, ordinal, title, status, is_recurring)
       VALUES (?, ?, 0, 'Dated child cached through its parent', 'completed', 0);`,
      [parentId, missingChildId],
    );

    await runMigrations(database, FOUNDATION_MIGRATIONS);

    expect(
      await database.first(
        `SELECT children_installed FROM activity_detail_projection_state
         WHERE activity_id = ?;`,
        [parentId],
      ),
    ).toEqual({ children_installed: 0 });
    expect(
      await database.all(
        'SELECT * FROM activity_children WHERE parent_activity_id = ?;',
        [parentId],
      ),
    ).toEqual([]);
  });

  it('upgrades an already-applied acknowledgement overlay without losing its marker', async () => {
    if (database === undefined) throw new Error('missing migration test database');
    await runMigrations(database, FOUNDATION_MIGRATIONS.slice(0, 23));
    const parentId = 'act_previous_migration_parent';
    await database.run(
      `INSERT INTO activity_update_acknowledgements
         (intent_id, activity_id, operation, target_update_id, created_at)
       VALUES ('int_previous', ?, 'post', 'upd_previous', 42);`,
      [parentId],
    );
    await database.run(
      `INSERT INTO activity_detail_projection_state
         (activity_id, children_installed, source_lists_installed)
       VALUES (?, 1, 0);`,
      [parentId],
    );
    await database.run(
      `INSERT INTO activity_children
         (parent_activity_id, child_activity_id, ordinal, title, status, is_recurring,
          restored_status)
       VALUES (?, 'act_missing_after_v20', 0, 'Missing child', 'completed', 0, 'saved');`,
      [parentId],
    );

    await runMigrations(database, FOUNDATION_MIGRATIONS);

    expect(
      await database.first(
        `SELECT intent_id, reconcile_after_exhaustion
         FROM activity_update_acknowledgements WHERE intent_id = 'int_previous';`,
      ),
    ).toEqual({ intent_id: 'int_previous', reconcile_after_exhaustion: 0 });
    expect(
      await database.first(
        `SELECT children_installed FROM activity_detail_projection_state
         WHERE activity_id = ?;`,
        [parentId],
      ),
    ).toEqual({ children_installed: 0 });
    expect(
      await database.all(
        'SELECT * FROM activity_children WHERE parent_activity_id = ?;',
        [parentId],
      ),
    ).toEqual([]);
  });

  it('adds a generation fence to an existing update cursor without losing it', async () => {
    if (database === undefined) throw new Error('missing migration test database');
    await runMigrations(database, FOUNDATION_MIGRATIONS.slice(0, 24));
    await database.run(
      `INSERT INTO activity_update_feed_state (activity_id, next_cursor)
       VALUES ('act_existing_feed', 'cur_existing');`,
    );

    await runMigrations(database, FOUNDATION_MIGRATIONS);

    expect(
      await database.first(
        `SELECT next_cursor, generation FROM activity_update_feed_state
         WHERE activity_id = 'act_existing_feed';`,
      ),
    ).toEqual({ next_cursor: 'cur_existing', generation: 0 });
  });
});
