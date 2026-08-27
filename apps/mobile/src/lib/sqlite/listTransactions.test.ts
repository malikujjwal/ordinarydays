import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';
import { NativeActivityActionCoordinator } from './actionCoordinator';
import type { ActivityTransactionService } from './activityTransactions';
import type { SqliteDatabase } from './database';
import { ListsRepository } from './listsRepository';
import { ListTransactionService } from './listTransactions';
import { FOUNDATION_MIGRATIONS, runMigrations } from './migrations';
import { OutboxRepository } from './outbox';
import { RepositorySubscriptions } from './subscriptions';
import type { NativeSyncEngine } from './syncEngine';
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
  updatedAt: instant.parse('2026-08-26T12:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-26T12:00:00.000Z'),
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
    expect(await outbox.listArchiveUndoOffer(database, 'intent-archive')).toMatchObject({
      listId: LIST.listId,
      originalIntentId: 'intent-archive',
    });
  });

  it('cancels an unsent archive when Undo is accepted before push', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { lists, outbox, service, transactions } = harness(database);
    await transactions.run((transaction) => lists.replaceCanonical(transaction, [LIST]));
    await transactions.run((transaction) =>
      service.setArchived(transaction, LIST, true, 'archive-before-push'),
    );

    const result = await transactions.run((transaction) =>
      service.undoArchive(
        transaction,
        LIST.listId,
        'archive-before-push',
        'unused-inverse',
      ),
    );

    expect(result.kind).toBe('cancelled');
    expect(await outbox.all()).toEqual([]);
    expect((await lists.read())[0]?.archived).toBe(false);
    expect(
      await outbox.listArchiveUndoOffer(database, 'archive-before-push'),
    ).toBeUndefined();
  });

  it('holds an in-flight Undo behind archive and installs the server-authored token', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { lists, outbox, service, transactions } = harness(database);
    await transactions.run((transaction) => lists.replaceCanonical(transaction, [LIST]));
    await transactions.run((transaction) =>
      service.setArchived(transaction, LIST, true, 'archive-in-flight'),
    );
    await transactions.run((transaction) => outbox.claimNext(transaction.database));

    await transactions.run((transaction) =>
      service.undoArchive(
        transaction,
        LIST.listId,
        'archive-in-flight',
        'archive-inverse',
      ),
    );
    expect((await outbox.get(database, 'archive-inverse'))?.variables).not.toHaveProperty(
      'undoToken',
    );

    await transactions.run(async (transaction) => {
      await outbox.recordListArchiveUndoToken(
        transaction.database,
        'archive-in-flight',
        'server-undo-token',
        '2026-08-26T12:00:06.000Z',
      );
      await outbox.acknowledge(transaction.database, 'archive-in-flight');
    });

    expect(await outbox.get(database, 'archive-inverse')).toMatchObject({
      status: 'queued',
      dependsOnIntentId: 'archive-in-flight',
      variables: { undoToken: 'server-undo-token' },
    });
    expect((await lists.read())[0]?.archived).toBe(false);
  });

  it('retains the archive identity when Undo is accepted after acknowledgement', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { lists, outbox, service, transactions } = harness(database);
    await transactions.run((transaction) => lists.replaceCanonical(transaction, [LIST]));
    await transactions.run((transaction) =>
      service.setArchived(transaction, LIST, true, 'archive-acknowledged'),
    );
    await transactions.run((transaction) => outbox.claimNext(transaction.database));
    await transactions.run(async (transaction) => {
      await outbox.recordListArchiveUndoToken(
        transaction.database,
        'archive-acknowledged',
        'server-undo-token',
        '2026-08-26T12:00:06.000Z',
      );
      await outbox.acknowledge(transaction.database, 'archive-acknowledged');
    });
    expect(await outbox.get(database, 'archive-acknowledged')).toBeUndefined();

    await transactions.run((transaction) =>
      service.undoArchive(
        transaction,
        LIST.listId,
        'archive-acknowledged',
        'archive-late-inverse',
      ),
    );

    expect(await outbox.get(database, 'archive-late-inverse')).toMatchObject({
      variables: {
        originalIntentId: 'archive-acknowledged',
        undoToken: 'server-undo-token',
      },
    });
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
      updatedAt: instant.parse('2026-08-26T12:01:00.000Z'),
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

  it('re-applies a blocked List patch when Retry gives it a fresh identity', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { lists, outbox, service, transactions } = harness(database);
    await transactions.run((transaction) => lists.replaceCanonical(transaction, [LIST]));
    await transactions.run(async (transaction) => {
      await service.setArchived(transaction, LIST, true, 'rejected-archive');
      await outbox.needsAttention(
        transaction.database,
        'rejected-archive',
        { kind: 'rejected', status: 422 },
        'Rejected archive',
      );
      // The rejection rollback restored the server value before the user selected Retry.
      await lists.setArchivedLocal(transaction, LIST.listId, false);
    });
    const recovered = {
      ...LIST,
      updatedAt: instant.parse('2026-08-26T12:05:00.000Z'),
    };
    const sync = {
      request: vi.fn(),
      recoverRejectedIntent: vi.fn(async () => {
        await transactions.run((transaction) =>
          lists.applySettings(transaction, recovered),
        );
        return true;
      }),
    } as unknown as NativeSyncEngine;
    const coordinator = new NativeActivityActionCoordinator(
      LIST.ownerId,
      transactions,
      {} as ActivityTransactionService,
      outbox,
      sync,
      undefined,
      service,
    );

    const result = await coordinator.retryBlocked('rejected-archive', 'retried-archive', {
      today: '2026-08-26',
      currentMinute: '12:00',
    });

    expect(result).toMatchObject({
      kind: 'accepted',
      intent: { intentId: 'retried-archive', mutationKey: ['list', 'patch'] },
    });
    expect((await lists.read())[0]?.archived).toBe(true);
    expect((await outbox.get(database, 'retried-archive'))?.variables).toMatchObject({
      ifMatch: recovered.updatedAt,
      idempotencyKey: 'retried-archive',
    });
    expect(sync.recoverRejectedIntent).toHaveBeenCalledWith('rejected-archive');
    expect(sync.request).toHaveBeenCalledWith('accepted-action');
  });

  it('moves an accepted Undo behind the fresh archive identity on Retry', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { lists, outbox, service, transactions } = harness(database);
    await transactions.run((transaction) => lists.replaceCanonical(transaction, [LIST]));
    await transactions.run((transaction) =>
      service.setArchived(transaction, LIST, true, 'rejected-archive-with-undo'),
    );
    await transactions.run((transaction) => outbox.claimNext(transaction.database));
    await transactions.run((transaction) =>
      service.undoArchive(
        transaction,
        LIST.listId,
        'rejected-archive-with-undo',
        'parked-archive-undo',
      ),
    );
    await transactions.run(async (transaction) => {
      await outbox.needsAttention(
        transaction.database,
        'rejected-archive-with-undo',
        { kind: 'rejected', status: 409 },
        'Rejected archive',
      );
      await outbox.needsAttention(
        transaction.database,
        'parked-archive-undo',
        { kind: 'parked', reason: 'predecessor_rejected' },
        'The archive was rejected.',
      );
      await lists.setArchivedLocal(transaction, LIST.listId, false);
    });
    const recovered = {
      ...LIST,
      updatedAt: instant.parse('2026-08-26T12:06:00.000Z'),
    };
    const sync = {
      request: vi.fn(),
      recoverRejectedIntent: vi.fn(async () => {
        await transactions.run((transaction) =>
          lists.applySettings(transaction, recovered),
        );
        return true;
      }),
    } as unknown as NativeSyncEngine;
    const coordinator = new NativeActivityActionCoordinator(
      LIST.ownerId,
      transactions,
      {} as ActivityTransactionService,
      outbox,
      sync,
      undefined,
      service,
    );

    const result = await coordinator.retryBlocked(
      'rejected-archive-with-undo',
      'retried-archive-with-undo',
      { today: '2026-08-26', currentMinute: '12:00' },
    );

    expect(result.kind).toBe('accepted');
    expect(await outbox.get(database, 'parked-archive-undo')).toMatchObject({
      status: 'queued',
      dependsOnIntentId: 'retried-archive-with-undo',
      compensationForIntentId: 'retried-archive-with-undo',
      variables: { originalIntentId: 'rejected-archive-with-undo' },
    });
    expect(
      await outbox.listArchiveUndoOffer(database, 'rejected-archive-with-undo'),
    ).toMatchObject({
      currentIntentId: 'retried-archive-with-undo',
      inverseIntentId: 'parked-archive-undo',
    });
    expect((await lists.read())[0]?.archived).toBe(false);
    await transactions.run((transaction) =>
      outbox.recordListArchiveUndoToken(
        transaction.database,
        'retried-archive-with-undo',
        'retry-undo-token',
        '2026-08-26T12:06:06.000Z',
      ),
    );
    expect((await outbox.get(database, 'parked-archive-undo'))?.variables).toMatchObject({
      undoToken: 'retry-undo-token',
    });
  });

  it('re-applies a blocked List deletion instead of sending it through Activity recovery', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { lists, outbox, service, transactions } = harness(database);
    await transactions.run((transaction) => lists.replaceCanonical(transaction, [LIST]));
    await transactions.run(async (transaction) => {
      await service.remove(transaction, LIST, 'rejected-delete');
      await outbox.needsAttention(
        transaction.database,
        'rejected-delete',
        { kind: 'rejected', status: 409 },
        'Rejected delete',
      );
      await lists.upsertCanonical(transaction, LIST, 0);
    });
    const sync = {
      request: vi.fn(),
      recoverRejectedIntent: vi.fn(async () => true),
    } as unknown as NativeSyncEngine;
    const coordinator = new NativeActivityActionCoordinator(
      LIST.ownerId,
      transactions,
      {} as ActivityTransactionService,
      outbox,
      sync,
      undefined,
      service,
    );

    const result = await coordinator.retryBlocked('rejected-delete', 'retried-delete', {
      today: '2026-08-26',
      currentMinute: '12:00',
    });

    expect(result.kind).toBe('accepted');
    expect(await lists.read()).toEqual([]);
  });

  it('does not protect rejected List projections from an authoritative pull', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { lists, outbox, service, transactions } = harness(database);
    await transactions.run((transaction) => lists.replaceCanonical(transaction, [LIST]));
    await transactions.run(async (transaction) => {
      await service.setArchived(transaction, LIST, true, 'rejected-list');
      await outbox.needsAttention(transaction.database, 'rejected-list', {
        kind: 'rejected',
        status: 409,
      });
    });

    expect((await outbox.protectedListIds(database)).has(LIST.listId)).toBe(false);
  });
});
