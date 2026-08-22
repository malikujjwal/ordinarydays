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

    const previousMigrations = FOUNDATION_MIGRATIONS.slice(0, -1);
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
});
