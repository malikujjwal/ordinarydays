import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCommitRevision } from '@/lib/sqlite/commitRevision';
import type { SqliteDatabase } from '@/lib/sqlite/database';
import { RepositorySubscriptions } from '@/lib/sqlite/subscriptions';
import { SerializedTransactionRunner } from '@/lib/sqlite/transaction';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';

describe('serialized SQLite transactions and subscriptions', () => {
  let directory = '';
  let database: SqliteDatabase | undefined;
  let subscriptions: RepositorySubscriptions;
  let transactions: SerializedTransactionRunner;

  const openedDatabase = (): SqliteDatabase => {
    if (database === undefined) throw new Error('Test database was not opened.');
    return database;
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ordinarydays-transactions-'));
    database = await createNodeSqliteFactory(directory).open('transactions.sqlite');
    await database.exec(
      `CREATE TABLE values_test (id TEXT PRIMARY KEY, value TEXT NOT NULL);
       CREATE TABLE native_commit_state (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         commit_revision INTEGER NOT NULL CHECK (commit_revision >= 0)
       );
       INSERT INTO native_commit_state VALUES (1, 0);`,
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

  it('lets an interactive write pass queued maintenance without interrupting the active transaction', async () => {
    let releaseActive: (() => void) | undefined;
    const activeMayCommit = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const entered: string[] = [];
    const active = transactions.run(async () => {
      entered.push('active-normal');
      await activeMayCommit;
    });
    const queuedNormal = transactions.run(async () => {
      entered.push('queued-normal');
    });
    const interactive = transactions.run(async () => {
      entered.push('interactive');
    }, 'interactive');

    await vi.waitFor(() => expect(entered).toEqual(['active-normal']));
    releaseActive?.();
    await Promise.all([active, queuedNormal, interactive]);

    expect(entered).toEqual(['active-normal', 'interactive', 'queued-normal']);
  });

  it('admits maintenance after four interactive transactions', async () => {
    let releaseActive: (() => void) | undefined;
    const activeMayCommit = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const entered: string[] = [];
    const active = transactions.run(async () => {
      entered.push('active');
      await activeMayCommit;
    });
    const normal = transactions.run(async () => {
      entered.push('normal');
    });
    const interactive = Array.from({ length: 6 }, (_, index) =>
      transactions.run(async () => {
        entered.push(`interactive-${index + 1}`);
      }, 'interactive'),
    );

    await vi.waitFor(() => expect(entered).toEqual(['active']));
    releaseActive?.();
    await Promise.all([active, normal, ...interactive]);

    expect(entered).toEqual([
      'active',
      'interactive-1',
      'interactive-2',
      'interactive-3',
      'interactive-4',
      'normal',
      'interactive-5',
      'interactive-6',
    ]);
  });

  it('lets an interactive write pass a background read during its admission window', async () => {
    const entered: string[] = [];
    const background = transactions.read(async () => {
      entered.push('background');
    }, 20);
    const interactive = transactions.run(async () => {
      entered.push('interactive');
    }, 'interactive');

    await Promise.all([background, interactive]);

    expect(entered).toEqual(['interactive', 'background']);
  });

  it('never interrupts an active read with an interactive write', async () => {
    let releaseRead: (() => void) | undefined;
    const readMayFinish = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const entered: string[] = [];
    const background = transactions.read(async () => {
      entered.push('background-start');
      await readMayFinish;
      entered.push('background-finish');
    });

    await vi.waitFor(() => expect(entered).toEqual(['background-start']));
    const interactive = transactions.run(async () => {
      entered.push('interactive');
    }, 'interactive');
    await Promise.resolve();
    expect(entered).toEqual(['background-start']);

    releaseRead?.();
    await Promise.all([background, interactive]);
    expect(entered).toEqual(['background-start', 'background-finish', 'interactive']);
  });

  it('admits a ready background read after four foreground jobs', async () => {
    let releaseActive: (() => void) | undefined;
    const activeMayFinish = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const entered: string[] = [];
    const active = transactions.read(async () => {
      entered.push('active-read');
      await activeMayFinish;
    });
    await vi.waitFor(() => expect(entered).toEqual(['active-read']));

    const background = transactions.read(async () => {
      entered.push('background-read');
    });
    const normal = transactions.run(async () => {
      entered.push('normal');
    });
    const interactive = Array.from({ length: 6 }, (_, index) =>
      transactions.run(async () => {
        entered.push(`interactive-${index + 1}`);
      }, 'interactive'),
    );
    releaseActive?.();
    await Promise.all([active, background, normal, ...interactive]);

    expect(entered).toEqual([
      'active-read',
      'interactive-1',
      'interactive-2',
      'interactive-3',
      'interactive-4',
      'background-read',
      'normal',
      'interactive-5',
      'interactive-6',
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
    expect(valuesListener).toHaveBeenCalledWith({
      scope: 'values',
      commitRevision: 1,
    });
    expect(await readCommitRevision(openedDatabase())).toBe(1);
  });

  it('increments exactly once for a multi-statement, multi-scope commit', async () => {
    const valuesListener = vi.fn();
    const otherListener = vi.fn();
    subscriptions.subscribe('values', valuesListener);
    subscriptions.subscribe('other', otherListener);

    const committed = await transactions.runCommitted(async (transaction) => {
      await transaction.database.run('INSERT INTO values_test VALUES (?, ?);', [
        'one',
        '1',
      ]);
      await transaction.database.run('INSERT INTO values_test VALUES (?, ?);', [
        'two',
        '2',
      ]);
      transaction.changed('values');
      transaction.changed('other');
      return 'committed';
    });

    expect(committed).toEqual({ value: 'committed', commitRevision: 1 });
    expect(await readCommitRevision(openedDatabase())).toBe(1);
    expect(valuesListener).toHaveBeenCalledWith({
      scope: 'values',
      commitRevision: 1,
    });
    expect(otherListener).toHaveBeenCalledWith({
      scope: 'other',
      commitRevision: 1,
    });
  });

  it('does not advance or publish for a read-only or zero-change transaction', async () => {
    const listener = vi.fn();
    subscriptions.subscribe('values', listener);

    const readOnly = await transactions.runCommitted(async ({ database: transaction }) =>
      transaction.first('SELECT commit_revision FROM native_commit_state;'),
    );
    await transactions.run(async ({ database: transaction, changed }) => {
      await transaction.run('UPDATE values_test SET value = ? WHERE id = ?;', [
        'missing',
        'missing',
      ]);
      changed('values');
    });

    expect(readOnly.commitRevision).toBe(0);
    expect(await readCommitRevision(openedDatabase())).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps unrelated scoped revisions from becoming Agenda invalidations', async () => {
    const agendaListener = vi.fn();
    const outboxListener = vi.fn();
    subscriptions.subscribe('agenda', agendaListener);
    subscriptions.subscribe('outbox', outboxListener);

    await transactions.run(async ({ database: transaction, changed }) => {
      await transaction.run('INSERT INTO values_test VALUES (?, ?);', [
        'outbox-only',
        'yes',
      ]);
      changed('outbox');
    });

    expect(await readCommitRevision(openedDatabase())).toBe(1);
    expect(outboxListener).toHaveBeenCalledWith({
      scope: 'outbox',
      commitRevision: 1,
    });
    expect(agendaListener).not.toHaveBeenCalled();
  });

  it('measures queue wait, SQLite calls, and the complete transaction envelope separately', async () => {
    const { value, metrics } = await transactions.runMeasured(
      async ({ database: transaction }) => {
        await transaction.run('INSERT INTO values_test VALUES (?, ?);', [
          'measured',
          'yes',
        ]);
        return transaction.first('SELECT value FROM values_test WHERE id = ?;', [
          'measured',
        ]);
      },
      'interactive',
    );

    expect(value).toEqual({ value: 'yes' });
    /* INSERT, SELECT, then the centralized revision UPDATE ... RETURNING. */
    expect(metrics.callCount).toBe(3);
    expect(metrics.queueWaitMs).toBeGreaterThanOrEqual(0);
    expect(metrics.durationMs).toBeGreaterThanOrEqual(0);
    expect(metrics.transactionMs).toBeGreaterThanOrEqual(metrics.durationMs);
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
    expect(await readCommitRevision(openedDatabase())).toBe(0);
  });

  it('continues draining after a driver throws before returning a transaction promise', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    vi.spyOn(database, 'transaction').mockImplementationOnce(() => {
      throw new Error('driver refused');
    });

    const failed = transactions.run(async () => undefined);
    const recovered = transactions.run(async ({ database: transaction }) => {
      await transaction.run('INSERT INTO values_test VALUES (?, ?);', [
        'recovered',
        'yes',
      ]);
    });

    await expect(failed).rejects.toThrow('driver refused');
    await expect(recovered).resolves.toBeUndefined();
    expect(await database.all('SELECT id FROM values_test;')).toEqual([
      { id: 'recovered' },
    ]);
  });

  it('continues draining after a scheduled read fails', async () => {
    const failed = transactions.read(async () => {
      throw new Error('read refused');
    });
    const recovered = transactions.run(async ({ database: transaction }) => {
      await transaction.run('INSERT INTO values_test VALUES (?, ?);', [
        'after-read-failure',
        'yes',
      ]);
    }, 'interactive');

    await expect(failed).rejects.toThrow('read refused');
    await expect(recovered).resolves.toBeUndefined();
  });
});
