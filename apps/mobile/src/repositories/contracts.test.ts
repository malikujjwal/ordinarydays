import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteDatabase } from '@/lib/sqlite/database';
import { textColumn } from '@/lib/sqlite/database';
import { RepositorySubscriptions } from '@/lib/sqlite/subscriptions';
import type { TransactionContext } from '@/lib/sqlite/transaction';
import { SerializedTransactionRunner } from '@/lib/sqlite/transaction';
import type { TypedRepository } from '@/repositories/contracts';
import { createNodeSqliteFactory } from '../../test/node-sqlite';

interface ValueQuery {
  readonly groupId: string;
}

interface ValueCommand {
  readonly groupId: string;
  readonly id: string;
  readonly value: string;
}

interface ValueRow {
  readonly id: string;
  readonly value: string;
}

class ScopedValueRepository
  implements TypedRepository<ValueQuery, readonly ValueRow[], ValueCommand, void>
{
  constructor(
    private readonly database: SqliteDatabase,
    private readonly subscriptions: RepositorySubscriptions,
  ) {}

  async read(query: ValueQuery): Promise<readonly ValueRow[]> {
    const rows = await this.database.all(
      'SELECT id, value FROM repository_test_values WHERE group_id = ? ORDER BY id;',
      [query.groupId],
    );
    return rows.map((row) => {
      const id = textColumn(row, 'id');
      const value = textColumn(row, 'value');
      if (id === undefined || value === undefined)
        throw new Error('Repository row is malformed.');
      return { id, value };
    });
  }

  subscribe(query: ValueQuery, listener: () => void): () => void {
    return this.subscriptions.subscribe(this.scope(query), listener);
  }

  version(query: ValueQuery): number {
    return this.subscriptions.version(this.scope(query));
  }

  async write(transaction: TransactionContext, command: ValueCommand): Promise<void> {
    await transaction.database.run(
      'INSERT INTO repository_test_values (group_id, id, value) VALUES (?, ?, ?);',
      [command.groupId, command.id, command.value],
    );
    transaction.changed(this.scope(command));
  }

  private scope(query: ValueQuery): string {
    return `values:${query.groupId}`;
  }
}

describe('typed repository contract', () => {
  let directory = '';
  let database: SqliteDatabase | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ordinarydays-repository-'));
    database = await createNodeSqliteFactory(directory).open('repository.sqlite');
    await database.exec(`
      CREATE TABLE repository_test_values (
        group_id TEXT NOT NULL,
        id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (group_id, id)
      );
      CREATE INDEX repository_test_values_group ON repository_test_values (group_id, id);
    `);
  });

  afterEach(async () => {
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps reads and subscription invalidations scoped to the typed query', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    const subscriptions = new RepositorySubscriptions();
    const transactions = new SerializedTransactionRunner(database, subscriptions);
    const repository = new ScopedValueRepository(database, subscriptions);
    const groupAListener = vi.fn();
    const groupBListener = vi.fn();
    repository.subscribe({ groupId: 'a' }, groupAListener);
    repository.subscribe({ groupId: 'b' }, groupBListener);

    await transactions.run((transaction) =>
      repository.write(transaction, { groupId: 'a', id: 'one', value: 'A' }),
    );

    expect(await repository.read({ groupId: 'a' })).toEqual([{ id: 'one', value: 'A' }]);
    expect(await repository.read({ groupId: 'b' })).toEqual([]);
    expect(repository.version({ groupId: 'a' })).toBe(1);
    expect(repository.version({ groupId: 'b' })).toBe(0);
    expect(groupAListener).toHaveBeenCalledTimes(1);
    expect(groupBListener).not.toHaveBeenCalled();
  });
});
