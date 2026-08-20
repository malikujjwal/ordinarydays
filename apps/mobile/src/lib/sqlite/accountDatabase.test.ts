import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountDatabaseManager,
  AccountOwnerMismatchError,
  accountDatabaseFilename,
} from '@/lib/sqlite/accountDatabase';
import type { SqliteExecutor } from '@/lib/sqlite/database';
import { FOUNDATION_MIGRATIONS, type SqliteMigration } from '@/lib/sqlite/migrations';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';

const ACCOUNT_A = 'account-immutable-a';
const ACCOUNT_B = 'account-immutable-b';

function nodeHash(value: string): Promise<string> {
  return Promise.resolve(createHash('sha256').update(value).digest('hex'));
}

const testMigrations: readonly SqliteMigration[] = [
  ...FOUNDATION_MIGRATIONS,
  {
    version: FOUNDATION_MIGRATIONS.length + 1,
    name: 'account-test-values',
    apply: (database) =>
      database.exec(`
        CREATE TABLE account_test_values (
          id TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
      `),
  },
];

describe('account SQLite lifecycle', () => {
  let directory = '';
  let databases: AccountDatabaseManager | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ordinarydays-sqlite-'));
  });

  afterEach(async () => {
    await databases?.signOut();
    await rm(directory, { recursive: true, force: true });
  });

  function manager(hash = nodeHash): AccountDatabaseManager {
    databases = new AccountDatabaseManager({
      factory: createNodeSqliteFactory(directory),
      hash,
      migrations: testMigrations,
    });
    return databases;
  }

  it('creates a hashed database with WAL and foreign keys, then reopens it', async () => {
    const databases = manager();
    const filename = await accountDatabaseFilename(ACCOUNT_A, nodeHash);

    const first = await databases.open(ACCOUNT_A);
    expect(first.filename).toBe(filename);
    expect(filename).not.toContain(ACCOUNT_A);
    expect((await first.database.first('PRAGMA journal_mode;'))?.journal_mode).toBe(
      'wal',
    );
    expect((await first.database.first('PRAGMA foreign_keys;'))?.foreign_keys).toBe(1);
    await first.transactions.run(async ({ database, changed }) => {
      await database.run('INSERT INTO account_test_values (id, value) VALUES (?, ?);', [
        'survives',
        'yes',
      ]);
      changed('values');
    });

    await databases.signOut();
    const reopened = await databases.open(ACCOUNT_A);

    expect(
      await reopened.database.first(
        'SELECT value FROM account_test_values WHERE id = ?;',
        ['survives'],
      ),
    ).toEqual({ value: 'yes' });
    expect(
      await reopened.database.first(
        'SELECT commit_revision FROM native_commit_state WHERE singleton = 1;',
      ),
    ).toEqual({ commit_revision: 1 });
  });

  it('reads rows and revision from one read-only WAL snapshot', async () => {
    const databases = manager();
    const account = await databases.open(ACCOUNT_A);
    await account.transactions.run(async ({ database, changed }) => {
      await database.run('INSERT INTO account_test_values VALUES (?, ?);', [
        'before',
        'one',
      ]);
      changed('values');
    });
    let releaseSnapshot: (() => void) | undefined;
    let markSnapshotStarted: (() => void) | undefined;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    const snapshotMayFinish = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const pending = account.projections.snapshot(async (reader) => {
      const rows = await reader.all(
        'SELECT id, value FROM account_test_values ORDER BY id;',
      );
      markSnapshotStarted?.();
      await snapshotMayFinish;
      return rows;
    });
    await snapshotStarted;

    await account.transactions.run(async ({ database, changed }) => {
      await database.run('INSERT INTO account_test_values VALUES (?, ?);', [
        'after',
        'two',
      ]);
      changed('values');
    });
    releaseSnapshot?.();

    await expect(pending).resolves.toEqual({
      data: [{ id: 'before', value: 'one' }],
      commitRevision: 1,
      source: 'reader',
    });
    await expect(
      account.projections.snapshot((reader) =>
        (reader as SqliteExecutor).run('INSERT INTO account_test_values VALUES (?, ?);', [
          'forbidden',
          'no',
        ]),
      ),
    ).rejects.toThrow();
    expect(
      await account.database.first(
        'SELECT value FROM account_test_values WHERE id = ?;',
        ['forbidden'],
      ),
    ).toBeUndefined();
  });

  it('falls back to the writer after reader-open failure and recreates one reader', async () => {
    const base = createNodeSqliteFactory(directory);
    let readerAttempts = 0;
    databases = new AccountDatabaseManager({
      factory: {
        ...base,
        openReader: async (filename) => {
          readerAttempts += 1;
          if (readerAttempts === 1) throw new Error('simulated reader open failure');
          return base.openReader(filename);
        },
      },
      hash: nodeHash,
      migrations: testMigrations,
    });
    const account = await databases.open(ACCOUNT_A);
    await account.transactions.run(async ({ database, changed }) => {
      await database.run('INSERT INTO account_test_values VALUES (?, ?);', [
        'fallback',
        'yes',
      ]);
      changed('values');
    });

    const fallback = await account.projections.snapshot((reader) =>
      reader.first('SELECT value FROM account_test_values WHERE id = ?;', ['fallback']),
    );
    expect(fallback).toMatchObject({
      data: { value: 'yes' },
      commitRevision: 1,
      source: 'writer-fallback',
    });
    await expect.poll(() => readerAttempts).toBe(2);
    const recreated = await account.projections.snapshot((reader) =>
      reader.first('SELECT value FROM account_test_values WHERE id = ?;', ['fallback']),
    );
    expect(recreated.source).toBe('reader');
    expect(readerAttempts).toBe(2);
  });

  it('isolates account files and never exposes one account row after switching', async () => {
    const databases = manager();
    const accountA = await databases.open(ACCOUNT_A);
    await accountA.transactions.run(async ({ database }) => {
      await database.run('INSERT INTO account_test_values (id, value) VALUES (?, ?);', [
        'a-only',
        'secret-a',
      ]);
    });

    const accountB = await databases.open(ACCOUNT_B);

    expect(await accountB.database.all('SELECT * FROM account_test_values;')).toEqual([]);
    expect(
      await accountB.database.first('SELECT commit_revision FROM native_commit_state;'),
    ).toEqual({ commit_revision: 0 });
    await accountB.transactions.run(async ({ database }) => {
      await database.run('INSERT INTO account_test_values (id, value) VALUES (?, ?);', [
        'b-only',
        'secret-b',
      ]);
    });
    const reopenedA = await databases.open(ACCOUNT_A);
    expect(await reopenedA.database.all('SELECT * FROM account_test_values;')).toEqual([
      { id: 'a-only', value: 'secret-a' },
    ]);
    expect(
      await reopenedA.database.first('SELECT commit_revision FROM native_commit_state;'),
    ).toEqual({ commit_revision: 1 });
  });

  it('closes and quarantines on sign-out without age-deleting unresolved work', async () => {
    const databases = manager();
    const account = await databases.open(ACCOUNT_A);
    await account.transactions.run(async ({ database }) => {
      await database.exec(`
        CREATE TABLE unresolved_test_outbox (
          intent_id TEXT PRIMARY KEY NOT NULL,
          status TEXT NOT NULL
        );
      `);
      await database.run('INSERT INTO unresolved_test_outbox VALUES (?, ?);', [
        'intent-pending',
        'queued',
      ]);
    });

    await databases.signOut();

    expect(databases.isQuarantined(account.filename)).toBe(true);
    const reopened = await databases.open(ACCOUNT_A);
    expect(await reopened.database.all('SELECT * FROM unresolved_test_outbox;')).toEqual([
      { intent_id: 'intent-pending', status: 'queued' },
    ]);
  });

  it('rejects a hash collision whose owner metadata names another account', async () => {
    const collidingHash = () => Promise.resolve('a'.repeat(64));
    const databases = manager(collidingHash);
    await databases.open(ACCOUNT_A);
    await databases.signOut();

    await expect(databases.open(ACCOUNT_B)).rejects.toBeInstanceOf(
      AccountOwnerMismatchError,
    );

    const restored = await databases.open(ACCOUNT_A);
    expect(restored.accountNamespace).toBe(ACCOUNT_A);
  });

  it('confirmed deletion purges only the named account database', async () => {
    const databases = manager();
    const accountA = await databases.open(ACCOUNT_A);
    await accountA.database.run('INSERT INTO account_test_values VALUES (?, ?);', [
      'a',
      'one',
    ]);
    const accountB = await databases.open(ACCOUNT_B);
    await accountB.database.run('INSERT INTO account_test_values VALUES (?, ?);', [
      'b',
      'two',
    ]);

    await databases.purgeConfirmedAccount(ACCOUNT_A);

    expect(await accountB.database.all('SELECT * FROM account_test_values;')).toEqual([
      { id: 'b', value: 'two' },
    ]);
    const newAccountA = await databases.open(ACCOUNT_A);
    expect(await newAccountA.database.all('SELECT * FROM account_test_values;')).toEqual(
      [],
    );
  });
});
