import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteDatabase } from '@/lib/sqlite/database';
import { RepositorySubscriptions } from '@/lib/sqlite/subscriptions';
import { SerializedTransactionRunner } from '@/lib/sqlite/transaction';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';

describe('serialized SQLite transactions and subscriptions', () => {
  let directory = '';
  let database: SqliteDatabase | undefined;
  let subscriptions: RepositorySubscriptions;
  let transactions: SerializedTransactionRunner;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ordinarydays-transactions-'));
    database = await createNodeSqliteFactory(directory).open('transactions.sqlite');
    await database.exec(
      'CREATE TABLE values_test (id TEXT PRIMARY KEY, value TEXT NOT NULL);',
    );
    subscriptions = new RepositorySubscriptions();
    transactions = new SerializedTransactionRunner(database, subscriptions);
  });

  afterEach(async () => {
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('serializes concurrent callers in acceptance order', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const entered: string[] = [];
    const first = transactions.run(async ({ database: transaction }) => {
      entered.push('first');
      await transaction.run('INSERT INTO values_test VALUES (?, ?);', ['first', '1']);
      await firstMayCommit;
    });
    const second = transactions.run(async ({ database: transaction }) => {
      entered.push('second');
      await transaction.run('INSERT INTO values_test VALUES (?, ?);', ['second', '2']);
    });

    await vi.waitFor(() => expect(entered).toEqual(['first']));
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(entered).toEqual(['first', 'second']);
    expect(await database?.all('SELECT id FROM values_test ORDER BY rowid;')).toEqual([
      { id: 'first' },
      { id: 'second' },
    ]);
  });

  it('publishes only changed scopes and only after commit', async () => {
    const valuesListener = vi.fn();
    const otherListener = vi.fn();
    subscriptions.subscribe('values', valuesListener);
    subscriptions.subscribe('other', otherListener);
    let listenerCountInside = -1;

    await transactions.run(async ({ database: transaction, changed }) => {
      await transaction.run('INSERT INTO values_test VALUES (?, ?);', [
        'committed',
        'yes',
      ]);
      changed('values');
      listenerCountInside = valuesListener.mock.calls.length;
    });

    expect(listenerCountInside).toBe(0);
    expect(valuesListener).toHaveBeenCalledTimes(1);
    expect(otherListener).not.toHaveBeenCalled();
    expect(subscriptions.version('values')).toBe(1);
    expect(subscriptions.version('other')).toBe(0);
  });

  it('rolls writes and notifications back when a transaction fails', async () => {
    const listener = vi.fn();
    subscriptions.subscribe('values', listener);

    await expect(
      transactions.run(async ({ database: transaction, changed }) => {
        await transaction.run('INSERT INTO values_test VALUES (?, ?);', [
          'rolled-back',
          'no',
        ]);
        changed('values');
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');

    expect(await database?.all('SELECT * FROM values_test;')).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    expect(subscriptions.version('values')).toBe(0);
  });
});
