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
import { ListItemsRepository } from './listItemsRepository';
import { ListsRepository } from './listsRepository';
import { type ListCreateVariables, ListTransactionService } from './listTransactions';
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

const MINTED_AT = instant.parse('2026-08-27T09:15:00.000Z');
const SOURCE_ACTIVITY = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';

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
    const items = new ListItemsRepository(currentDatabase, subscriptions);
    const outbox = new OutboxRepository(currentDatabase);
    const service = new ListTransactionService(outbox, lists, items);
    return { items, lists, outbox, service, transactions };
  }

  describe('the durable item create (§P3-27, §P3-08)', () => {
    const ITEM = {
      listId: LIST.listId,
      itemId: 'itm_01J000000000000000000000AA',
      intentId: 'intent-create-item',
      idempotencyKey: 'intent-create-item',
      input: { itemId: 'itm_01J000000000000000000000AA', title: 'Milk' },
      rank: 'm',
    };

    /** One commit: the row the user will look at, and the intent that will send it. */
    it('stores the visible item and the queued create in one commit', async () => {
      if (database === undefined) throw new Error('test database not open');
      const { items, outbox, service, transactions } = harness(database);

      await transactions.run((transaction) => service.createItem(transaction, ITEM));

      expect(await items.read(LIST.listId)).toEqual([
        {
          itemId: ITEM.itemId,
          listId: LIST.listId,
          rank: 'm',
          title: 'Milk',
          checked: false,
        },
      ]);
      expect(await outbox.all()).toEqual([
        expect.objectContaining({
          intentId: 'intent-create-item',
          mutationKey: ['list', 'item-create'],
          entityId: ITEM.itemId,
          // The **list**, so items typed in sequence reach the server in that sequence and a
          // create serialises behind an archive of the same list.
          orderingKey: `list:${LIST.listId}`,
          status: 'queued',
        }),
      ]);
    });

    it('writes neither half when the transaction fails', async () => {
      if (database === undefined) throw new Error('test database not open');
      const { items, outbox, service, transactions } = harness(database);

      await expect(
        transactions.run(async (transaction) => {
          await service.createItem(transaction, ITEM);
          throw new Error('the commit failed after both writes');
        }),
      ).rejects.toThrow('the commit failed after both writes');

      expect(await items.read(LIST.listId)).toEqual([]);
      expect(await outbox.all()).toEqual([]);
    });

    /** A confirmation that reaches SQLite twice is one row: both ids are the same. */
    it('reuses the minted item and mutation ids on a repeated confirmation', async () => {
      if (database === undefined) throw new Error('test database not open');
      const { items, outbox, service, transactions } = harness(database);

      await transactions.run((transaction) => service.createItem(transaction, ITEM));
      await transactions.run((transaction) => service.createItem(transaction, ITEM));

      expect(await items.read(LIST.listId)).toHaveLength(1);
      expect(await outbox.all()).toHaveLength(1);
    });

    it('refuses a payload whose body names a different item', async () => {
      if (database === undefined) throw new Error('test database not open');
      const { outbox, service, transactions } = harness(database);

      await expect(
        transactions.run((transaction) =>
          service.createItem(transaction, {
            ...ITEM,
            itemId: 'itm_01J000000000000000000000BB',
          }),
        ),
      ).rejects.toThrow('must carry its minted identity');
      expect(await outbox.all()).toEqual([]);
    });

    /** Retry after an authoritative rollback puts the row back where the user saw it. */
    it('re-projects a rolled-back item from its own durable payload', async () => {
      if (database === undefined) throw new Error('test database not open');
      const { items, outbox, service, transactions } = harness(database);
      await transactions.run((transaction) => service.createItem(transaction, ITEM));
      const intent = await outbox.get(database, 'intent-create-item');
      if (intent === undefined) throw new Error('missing item create intent');
      await transactions.run((transaction) =>
        items.removeCanonical(transaction, LIST.listId, ITEM.itemId),
      );

      await transactions.run((transaction) =>
        service.reprojectRetry(transaction, 'usr_local_dev', intent),
      );

      expect((await items.read(LIST.listId))[0]).toMatchObject({
        itemId: ITEM.itemId,
        rank: 'm',
        title: 'Milk',
      });
    });
  });

  describe('the durable create (§P3-26)', () => {
    const CREATE = {
      listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W9Z9',
      intentId: 'intent-create-list',
      idempotencyKey: 'intent-create-list',
      input: {
        listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W9Z9',
        title: 'Costco run',
        templateKey: 'groceries',
      },
      seed: {
        behaviour: 'collection',
        capabilities: { checkable: true, supportsLocation: false },
        slot: 'groceries',
        icon: 'cart',
        emptyStateCopy: 'Add something to buy.',
      },
    } as const satisfies ListCreateVariables;

    /**
     * The commit §P3-26 specifies: the row the user will look at and the intent that will
     * send it, in **one** transaction. A row without its intent never syncs; an intent
     * without its row is a create the user cannot see they made.
     */
    it('stores the visible row and the queued create in one commit', async () => {
      if (database === undefined) throw new Error('test database not open');
      const { lists, outbox, service, transactions } = harness(database);

      await transactions.run((transaction) =>
        service.create(transaction, 'usr_local_dev', CREATE, MINTED_AT),
      );

      expect(await lists.read()).toEqual([
        {
          listId: CREATE.listId,
          ownerId: 'usr_local_dev',
          behaviour: 'collection',
          templateKey: 'groceries',
          // Retitled by the user, and the style is still the one they tapped.
          title: 'Costco run',
          icon: 'cart',
          emptyStateCopy: 'Add something to buy.',
          capabilities: { checkable: true, supportsLocation: false },
          slot: 'groceries',
          itemCount: 0,
          uncheckedCount: 0,
          memberCount: 1,
          rankVersion: 0,
          archived: false,
          updatedAt: MINTED_AT,
          lastItemActivityAt: MINTED_AT,
        },
      ]);
      expect(await outbox.all()).toEqual([
        expect.objectContaining({
          intentId: 'intent-create-list',
          mutationKey: ['list', 'create'],
          entityId: CREATE.listId,
          orderingKey: `list:${CREATE.listId}`,
          status: 'queued',
        }),
      ]);
    });

    /** Neither half survives the other failing — the atomicity claim, asserted by rollback. */
    it('writes neither half when the transaction fails', async () => {
      if (database === undefined) throw new Error('test database not open');
      const { lists, outbox, service, transactions } = harness(database);

      await expect(
        transactions.run(async (transaction) => {
          await service.create(transaction, 'usr_local_dev', CREATE, MINTED_AT);
          throw new Error('the commit failed after both writes');
        }),
      ).rejects.toThrow('the commit failed after both writes');

      expect(await lists.read()).toEqual([]);
      expect(await outbox.all()).toEqual([]);
    });

    /**
     * A confirmation that reaches SQLite twice — a double tap, a re-render — is one list. Both
     * ids are the same, so `append` recognises the same durable action rather than queueing a
     * second create under a second identity.
     */
    it('reuses the minted list and mutation ids on a repeated confirmation', async () => {
      if (database === undefined) throw new Error('test database not open');
      const { lists, outbox, service, transactions } = harness(database);

      await transactions.run((transaction) =>
        service.create(transaction, 'usr_local_dev', CREATE, MINTED_AT),
      );
      await transactions.run((transaction) =>
        service.create(transaction, 'usr_local_dev', CREATE, MINTED_AT),
      );

      expect(await lists.read()).toHaveLength(1);
      expect(await outbox.all()).toHaveLength(1);
    });

    it('refuses a payload whose body names a different list', async () => {
      if (database === undefined) throw new Error('test database not open');
      const { outbox, service, transactions } = harness(database);

      await expect(
        transactions.run((transaction) =>
          service.create(
            transaction,
            'usr_local_dev',
            { ...CREATE, listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W9ZA' },
            MINTED_AT,
          ),
        ),
      ).rejects.toThrow('must carry its minted identity');
      expect(await outbox.all()).toEqual([]);
    });

    /**
     * A list made for one Plan is forced to `slot: null` by the server, so the optimistic row
     * must not briefly claim to be a standing ingredients destination (§P3-05 step 3).
     */
    it('clears the copied slot when the list is made for a Plan', async () => {
      if (database === undefined) throw new Error('test database not open');
      const { lists, service, transactions } = harness(database);

      await transactions.run((transaction) =>
        service.create(
          transaction,
          'usr_local_dev',
          { ...CREATE, input: { ...CREATE.input, sourceActivityId: SOURCE_ACTIVITY } },
          MINTED_AT,
        ),
      );

      expect((await lists.read())[0]).toMatchObject({
        slot: null,
        sourceActivityId: SOURCE_ACTIVITY,
      });
    });

    /**
     * The seed travels on the intent rather than being re-resolved at replay, so a Retry days
     * later rebuilds the row from the values frozen at confirmation (ADR-032).
     */
    it('re-projects a rolled-back create from its own durable payload', async () => {
      if (database === undefined) throw new Error('test database not open');
      const { lists, outbox, service, transactions } = harness(database);
      await transactions.run((transaction) =>
        service.create(transaction, 'usr_local_dev', CREATE, MINTED_AT),
      );
      const intent = await outbox.get(database, 'intent-create-list');
      if (intent === undefined) throw new Error('missing create intent');
      // What an authoritative rollback leaves behind: the row is gone, the intent is not.
      await transactions.run((transaction) =>
        lists.removeCanonical(transaction, CREATE.listId),
      );

      await transactions.run((transaction) =>
        service.reprojectRetry(transaction, 'usr_local_dev', intent),
      );

      expect((await lists.read())[0]).toMatchObject({
        listId: CREATE.listId,
        templateKey: 'groceries',
        behaviour: 'collection',
        emptyStateCopy: 'Add something to buy.',
      });
    });

    it('refuses to re-project a create whose saved style is gone', async () => {
      if (database === undefined) throw new Error('test database not open');
      const { outbox, service, transactions } = harness(database);
      await transactions.run((transaction) =>
        service.create(transaction, 'usr_local_dev', CREATE, MINTED_AT),
      );
      const intent = await outbox.get(database, 'intent-create-list');
      if (intent === undefined) throw new Error('missing create intent');

      await expect(
        transactions.run((transaction) =>
          service.reprojectRetry(transaction, 'usr_local_dev', {
            ...intent,
            variables: { ...CREATE, seed: undefined },
          }),
        ),
      ).rejects.toThrow('missing its copied style');
    });
  });

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
