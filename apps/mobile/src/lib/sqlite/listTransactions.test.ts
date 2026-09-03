import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instant } from '@od/shared/schemas';
import type { ActivityDetail, List, ListItemView } from '@od/shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';
import { ActivityRepository } from './activityRepository';
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

const SOURCE_ACTIVITY = 'act_01J0000000000000000000000A';

function sourceDetail(list: List): ActivityDetail {
  return {
    activity: {
      activityId: SOURCE_ACTIVITY,
      ownerId: LIST.ownerId,
      objectKind: 'plan',
      type: 'custom',
      status: 'saved',
      title: 'Durable plan',
      participantCount: 0,
      childCount: 0,
      expenseTotalCents: 0,
      visibility: 'private',
      details: { kind: 'custom' },
      icsSequence: 0,
      createdAt: LIST.updatedAt,
      lastActivityAt: LIST.updatedAt,
      updatedAt: LIST.updatedAt,
      schemaVersion: 1,
    },
    reminders: [],
    sourceLists: [
      {
        listId: list.listId,
        title: list.title,
        icon: list.icon,
        itemCount: list.itemCount,
        doneCount: list.doneCount,
      },
    ],
  };
}

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
    const activities = new ActivityRepository(currentDatabase, subscriptions);
    const items = new ListItemsRepository(currentDatabase, subscriptions);
    const outbox = new OutboxRepository(currentDatabase);
    const service = new ListTransactionService(outbox, lists, items);
    return { activities, items, lists, outbox, service, transactions };
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

  it('updates the Lists card count in the same transaction as an item create', async () => {
    const { lists, service, transactions } = await install();

    await transactions.run((transaction) =>
      service.createItem(transaction, {
        listId: LIST.listId,
        itemId: 'itm_01J000000000000000000000AB',
        intentId: 'intent_item_create_count',
        idempotencyKey: 'intent_item_create_count',
        input: { itemId: 'itm_01J000000000000000000000AB', title: 'Ancillary Justice' },
        rank: 'z',
      }),
    );

    expect((await lists.read())[0]).toEqual(
      expect.objectContaining({
        itemCount: 2,
        doneCount: 0,
      }),
    );
  });

  it('publishes and reads a source Plan List count in the item-create transaction', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { activities, lists, service, transactions } = harness(database);
    const sourceList = {
      ...LIST,
      sourceActivityId: SOURCE_ACTIVITY,
      itemCount: 0,
    };
    await transactions.run(async (transaction) => {
      await activities.putCanonical(transaction, sourceDetail(sourceList));
      await lists.replaceCanonical(transaction, [sourceList]);
    });
    const invalidated = vi.fn();
    const stop = activities.subscribe(SOURCE_ACTIVITY, invalidated);

    await transactions.run((transaction) =>
      service.createItem(transaction, {
        listId: sourceList.listId,
        itemId: 'itm_01J000000000000000000000AB',
        intentId: 'intent_source_item_create',
        idempotencyKey: 'intent_source_item_create',
        input: { itemId: 'itm_01J000000000000000000000AB', title: 'Passport' },
        rank: 'z',
      }),
    );
    stop();

    expect(invalidated).toHaveBeenCalledOnce();
    expect(
      (await activities.read({ kind: 'activity', activityId: SOURCE_ACTIVITY }))
        ?.sourceLists,
    ).toEqual([
      expect.objectContaining({
        listId: sourceList.listId,
        itemCount: 1,
        doneCount: 0,
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

  it('updates Lists card progress in the same transaction as an item state change', async () => {
    const { lists, service, transactions } = await install();

    await transactions.run((transaction) =>
      service.patchItem(transaction, {
        listId: LIST.listId,
        itemId: ITEM.itemId,
        intentId: 'intent_item_done',
        idempotencyKey: 'intent_item_done',
        input: { state: 'done' },
      }),
    );

    expect((await lists.read())[0]).toEqual(
      expect.objectContaining({
        itemCount: 1,
        doneCount: 1,
      }),
    );
  });

  it('derives card progress from the latest local row across rapid done and undone taps', async () => {
    const { lists, service, transactions } = await install();
    for (const [intentId, state] of [
      ['intent_done_1', 'done'],
      ['intent_open', 'open'],
      ['intent_done_2', 'done'],
    ] as const) {
      await transactions.run((transaction) =>
        service.patchItem(transaction, {
          listId: LIST.listId,
          itemId: ITEM.itemId,
          intentId,
          idempotencyKey: intentId,
          input: { state },
        }),
      );
    }

    expect((await lists.read())[0]).toEqual(
      expect.objectContaining({ itemCount: 1, doneCount: 1 }),
    );
  });

  it('removes an item immediately and queues its delete behind rapid state writes', async () => {
    const { items, lists, outbox, service, transactions } = await install();

    await transactions.run((transaction) =>
      service.patchItem(transaction, {
        listId: LIST.listId,
        itemId: ITEM.itemId,
        intentId: 'intent_item_done_before_delete',
        idempotencyKey: 'intent_item_done_before_delete',
        input: { state: 'done' },
      }),
    );
    await transactions.run((transaction) =>
      service.deleteItem(transaction, {
        listId: LIST.listId,
        itemId: ITEM.itemId,
        intentId: 'intent_item_delete',
        idempotencyKey: 'intent_item_delete',
      }),
    );

    expect(await items.read(LIST.listId)).toEqual([]);
    expect((await lists.read())[0]).toEqual(
      expect.objectContaining({ itemCount: 0, doneCount: 0 }),
    );
    expect((await outbox.all()).map((intent) => intent.mutationKey)).toEqual([
      ['list', 'item-patch'],
      ['list', 'item-delete'],
    ]);
  });

  it('cancels an unsent delete and restores its exact row when Undo is accepted offline', async () => {
    const { items, lists, outbox, service, transactions } = await install();
    await transactions.run((transaction) =>
      service.deleteItem(transaction, {
        listId: LIST.listId,
        itemId: ITEM.itemId,
        intentId: 'intent_item_delete_then_undo',
        idempotencyKey: 'intent_item_delete_then_undo',
      }),
    );

    await transactions.run((transaction) =>
      service.undoDeletedItem(
        transaction,
        'intent_item_delete_then_undo',
        'intent_item_delete_inverse',
      ),
    );

    expect(await items.read(LIST.listId)).toEqual([ITEM]);
    expect((await lists.read())[0]).toEqual(
      expect.objectContaining({ itemCount: 1, doneCount: 0 }),
    );
    expect(await outbox.all()).toEqual([]);
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

  it('attaches an existing List to the open Plan projection in the outbox transaction', async () => {
    const { activities, lists, outbox, service, transactions } = await install();
    await transactions.run((transaction) =>
      activities.putCanonical(transaction, {
        ...sourceDetail(LIST),
        sourceLists: [],
      }),
    );

    await transactions.run((transaction) =>
      service.patchSettings(
        transaction,
        LIST,
        { sourceActivityId: SOURCE_ACTIVITY },
        'intent_attach_list',
      ),
    );

    expect((await lists.read())[0]?.sourceActivityId).toBe(SOURCE_ACTIVITY);
    expect(
      (await activities.read({ kind: 'activity', activityId: SOURCE_ACTIVITY }))
        ?.sourceLists,
    ).toEqual([
      expect.objectContaining({
        listId: LIST.listId,
        title: LIST.title,
        itemCount: LIST.itemCount,
        doneCount: LIST.doneCount,
      }),
    ]);
    expect((await outbox.all())[0]).toMatchObject({
      mutationKey: ['list', 'patch'],
      variables: { input: { sourceActivityId: SOURCE_ACTIVITY } },
    });
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
