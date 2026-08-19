import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqliteDatabase } from '@/lib/sqlite/database';
import {
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
});
