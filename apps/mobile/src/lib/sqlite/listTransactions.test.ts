import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { List } from '@od/shared/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';
import type { SqliteDatabase } from './database';
import { ListsRepository } from './listsRepository';
import { ListTransactionService } from './listTransactions';
import { FOUNDATION_MIGRATIONS, runMigrations } from './migrations';
import { OutboxRepository } from './outbox';
import { RepositorySubscriptions } from './subscriptions';
import { SerializedTransactionRunner } from './transaction';

const LIST: List = {
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  behaviour: 'collection',
  templateKey: 'groceries',
  title: 'Groceries',
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  capabilities: { checkable: true, supportsLocation: false },
  slot: null,
  itemCount: 3,
  uncheckedCount: 2,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: '2026-08-26T12:00:00.000Z',
  lastItemActivityAt: '2026-08-26T12:00:00.000Z',
};

describe('native List transactional outbox', () => {
  let directory = '';
  let database: SqliteDatabase | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ordinarydays-list-actions-'));
    database = await createNodeSqliteFactory(directory).open('lists.sqlite');
    await runMigrations(database, FOUNDATION_MIGRATIONS);
  });

  afterEach(async () => {
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  function harness(currentDatabase: SqliteDatabase) {
    const subscriptions = new RepositorySubscriptions();
    const transactions = new SerializedTransactionRunner(currentDatabase, subscriptions);
    const lists = new ListsRepository(currentDatabase, subscriptions);
    const outbox = new OutboxRepository(currentDatabase);
    const service = new ListTransactionService(outbox, lists);
    return { lists, outbox, service, transactions };
  }

  it('archives the visible row in the same commit that queues the API patch', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { lists, outbox, service, transactions } = harness(database);
    await transactions.run((transaction) => lists.replaceCanonical(transaction, [LIST]));

    await transactions.run((transaction) =>
      service.setArchived(transaction, LIST, true, 'intent-archive'),
    );

    expect((await lists.read())[0]?.archived).toBe(true);
    expect(await outbox.all()).toEqual([
      expect.objectContaining({
        intentId: 'intent-archive',
        mutationKey: ['list', 'patch'],
        entityId: LIST.listId,
        status: 'queued',
      }),
    ]);
  });

  it('uses the latest committed version when Undo is queued after acknowledgement', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { lists, outbox, service, transactions } = harness(database);
    await transactions.run((transaction) => lists.replaceCanonical(transaction, [LIST]));
    await transactions.run((transaction) =>
      service.setArchived(transaction, LIST, true, 'intent-archive'),
    );

    const acknowledged = {
      ...LIST,
      archived: true,
      updatedAt: '2026-08-26T12:01:00.000Z',
    };
    await transactions.run((transaction) =>
      lists.applySettings(transaction, acknowledged),
    );
    await transactions.run((transaction) =>
      service.setArchived(transaction, LIST, false, 'intent-restore'),
    );

    expect((await outbox.all())[1]?.variables).toEqual(
      expect.objectContaining({ ifMatch: acknowledged.updatedAt }),
    );
    expect((await lists.read())[0]?.archived).toBe(false);
  });

  it('removes the visible row in the same commit that queues the durable delete', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { lists, outbox, service, transactions } = harness(database);
    await transactions.run((transaction) => lists.replaceCanonical(transaction, [LIST]));

    await transactions.run((transaction) =>
      service.remove(transaction, LIST, 'intent-delete'),
    );

    expect(await lists.read()).toEqual([]);
    expect(await outbox.all()).toEqual([
      expect.objectContaining({
        intentId: 'intent-delete',
        mutationKey: ['list', 'delete'],
        entityId: LIST.listId,
        status: 'queued',
      }),
    ]);
  });
});
