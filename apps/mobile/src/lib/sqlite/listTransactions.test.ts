import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instant } from '@od/shared/schemas';
import type { List, ListItemView } from '@od/shared/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';
import type { SqliteDatabase } from './database';
import { ListItemsRepository } from './listItemsRepository';
import { ListsRepository } from './listsRepository';
import { type ListCreateVariables, ListTransactionService } from './listTransactions';
import { FOUNDATION_MIGRATIONS, runMigrations } from './migrations';
import { OutboxRepository } from './outbox';
import { RepositorySubscriptions } from './subscriptions';
import { SerializedTransactionRunner } from './transaction';

const LIST: List = {
  schemaVersion: 2,
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  templateKey: 'books-to-read',
  title: 'Reading',
  icon: 'book',
  emptyStateCopy: 'Add a book.',
  itemStateMode: {
    mode: 'stages',
    labels: { open: 'Want to read', active: 'Reading', done: 'Read' },
    groupByState: true,
  },
  featureConfig: {
    progress: { enabled: true, kind: 'text' },
    subItems: { enabled: false, sectionLabel: 'Materials', singularLabel: 'Material' },
  },
  slot: null,
  itemCount: 1,
  doneCount: 0,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-08-28T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-28T09:00:00.000Z'),
};

const ITEM: ListItemView = {
  listId: LIST.listId,
  itemId: 'itm_01J000000000000000000000AA',
  rank: 'm',
  title: 'The Left Hand of Darkness',
  state: 'active',
  features: {
    progress: { kind: 'text', value: 'Page 143' },
    place: { label: 'Library' },
  },
};

describe('native canonical List transactional outbox', () => {
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

  async function install() {
    if (database === undefined) throw new Error('test database not open');
    const value = harness(database);
    await value.transactions.run(async (transaction) => {
      await value.lists.replaceCanonical(transaction, [LIST]);
      await value.items.replaceFirstPage(transaction, LIST.listId, [ITEM], {
        rankVersion: 0,
        complete: true,
      });
    });
    return value;
  }

  it('atomically projects a new open item and one serialized intent', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { items, outbox, service, transactions } = harness(database);
    const variables = {
      listId: LIST.listId,
      itemId: 'itm_01J000000000000000000000AB',
      intentId: 'intent_item_create',
      idempotencyKey: 'intent_item_create',
      input: { itemId: 'itm_01J000000000000000000000AB', title: 'Ancillary Justice' },
      rank: 'z',
    };

    await transactions.run((transaction) => service.createItem(transaction, variables));

    expect(await items.read(LIST.listId)).toEqual([
      expect.objectContaining({
        itemId: variables.itemId,
        title: 'Ancillary Justice',
        state: 'open',
      }),
    ]);
    expect(await outbox.all()).toEqual([
      expect.objectContaining({
        mutationKey: ['list', 'item-create'],
        orderingKey: `list:${LIST.listId}`,
      }),
    ]);
  });

  it('rolls back both the projection and intent when the transaction fails', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { items, outbox, service, transactions } = harness(database);
    await expect(
      transactions.run(async (transaction) => {
        await service.createItem(transaction, {
          listId: LIST.listId,
          itemId: 'itm_01J000000000000000000000AB',
          intentId: 'intent_rollback',
          idempotencyKey: 'intent_rollback',
          input: { itemId: 'itm_01J000000000000000000000AB', title: 'Milk' },
          rank: 'z',
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await items.read(LIST.listId)).toEqual([]);
    expect(await outbox.all()).toEqual([]);
  });

  it('merges one typed item path and retains byte-identical siblings', async () => {
    const { items, outbox, service, transactions } = await install();

    await transactions.run((transaction) =>
      service.patchItem(transaction, {
        listId: LIST.listId,
        itemId: ITEM.itemId,
        intentId: 'intent_item_patch',
        idempotencyKey: 'intent_item_patch',
        input: { features: { progress: { kind: 'text', value: 'Page 144' } } },
      }),
    );

    expect((await items.read(LIST.listId))[0]?.features).toEqual({
      progress: { kind: 'text', value: 'Page 144' },
      place: { label: 'Library' },
    });
    expect((await outbox.all())[0]?.mutationKey).toEqual(['list', 'item-patch']);
  });

  it('refuses a queued reorder so drag can never replay against stale neighbours', async () => {
    const { service, transactions } = await install();
    await expect(
      transactions.run((transaction) =>
        service.patchItem(transaction, {
          listId: LIST.listId,
          itemId: ITEM.itemId,
          intentId: 'intent_reorder',
          idempotencyKey: 'intent_reorder',
          input: { afterItemId: null },
        }),
      ),
    ).rejects.toThrow('cannot carry a position');
  });

  it('copies a chosen preset into a pending List and persists the frozen seed on its intent', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { lists, outbox, service, transactions } = harness(database);
    const variables: ListCreateVariables = {
      listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W9Z9',
      intentId: 'intent_list_create',
      idempotencyKey: 'intent_list_create',
      input: {
        listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W9Z9',
        title: 'Materials',
        templateKey: 'blank',
      },
      seed: {
        itemStateMode: { mode: 'none' },
        featureConfig: {},
        slot: null,
        icon: 'list',
        emptyStateCopy: 'Add the first item.',
      },
    };
    await transactions.run((transaction) =>
      service.create(
        transaction,
        'usr_local_dev',
        variables,
        instant.parse('2026-08-28T10:00:00.000Z'),
      ),
    );

    expect((await lists.read())[0]).toMatchObject({
      schemaVersion: 2,
      templateKey: 'blank',
      itemStateMode: { mode: 'none' },
      featureConfig: {},
      doneCount: 0,
    });
    expect((await outbox.all())[0]?.variables).toMatchObject({ seed: variables.seed });
  });

  it('applies each List setting immediately without rewriting retained item state or features', async () => {
    const { items, lists, outbox, service, transactions } = await install();
    const retained = structuredClone((await items.read(LIST.listId))[0]);

    await transactions.run((transaction) =>
      service.patchSettings(
        transaction,
        LIST,
        {
          itemStateMode: { mode: 'checkbox' },
          featureConfig: { progress: { enabled: false, kind: 'text' } },
        },
        'intent_settings',
      ),
    );

    expect((await lists.read())[0]).toMatchObject({
      itemStateMode: { mode: 'checkbox' },
      featureConfig: {
        progress: { enabled: false, kind: 'text' },
        subItems: LIST.featureConfig.subItems,
      },
    });
    expect((await items.read(LIST.listId))[0]).toEqual(retained);
    expect((await outbox.all())[0]?.mutationKey).toEqual(['list', 'patch']);
  });

  it('cancels an unsent setting intent on Undo and restores its recorded local fields', async () => {
    const { lists, outbox, service, transactions } = await install();
    await transactions.run((transaction) =>
      service.patchSettings(transaction, LIST, { slot: 'watch' }, 'intent_settings'),
    );
    await transactions.run((transaction) =>
      service.undoSettings(transaction, LIST.listId, 'intent_settings', 'intent_inverse'),
    );

    expect((await lists.read())[0]?.slot).toBeNull();
    expect(await outbox.all()).toEqual([]);
  });
});
