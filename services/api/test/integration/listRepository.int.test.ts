import {
  type CancellationReason,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { List, ListItem } from '@od/shared/types';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { documents, TEST_TABLE, useTestTable } from './harness.js';

useTestTable();

type Repository = typeof import('../../src/repositories/listRepository.js');
type Base = typeof import('../../src/repositories/base.js');
type Keys = typeof import('../../src/repositories/keys.js');
type Ddb = typeof import('../../src/lib/ddb.js');
type Authz = typeof import('../../src/services/authz.js');

let repository: Repository;
let base: Base;
let keys: Keys;
let ddbModule: Ddb;
let authz: Authz;

const ALICE = 'usr_int_lists_alice';
const BEN = 'usr_int_lists_ben';
const NOW = '2026-08-23T14:00:00.000Z';
const LATER = '2026-08-23T14:01:00.000Z';

beforeAll(async () => {
  repository = await import('../../src/repositories/listRepository.js');
  base = await import('../../src/repositories/base.js');
  keys = await import('../../src/repositories/keys.js');
  ddbModule = await import('../../src/lib/ddb.js');
  authz = await import('../../src/services/authz.js');
});

afterEach(() => {
  vi.restoreAllMocks();
});

const aList = (overrides: Partial<List> = {}): List => ({
  listId: repository.newListId(),
  ownerId: ALICE,
  behaviour: 'collection',
  templateKey: 'simple-list',
  title: 'Errands',
  icon: 'list',
  emptyStateCopy: 'Nothing here yet.',
  capabilities: { checkable: true, supportsLocation: false },
  slot: null,
  itemCount: 0,
  uncheckedCount: 0,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: NOW,
  ...overrides,
});

type NewItem = Omit<ListItem, 'listId' | 'rank' | 'itemRevision'>;

const anItem = (title: string, overrides: Partial<NewItem> = {}): NewItem => ({
  itemId: repository.newItemId(),
  title,
  checked: false,
  ...overrides,
});

async function createSubject(overrides: Partial<List> = {}): Promise<List> {
  const list = aList(overrides);
  await repository.createList(ALICE, list, { now: NOW });
  return list;
}

function sameKey(
  left: Record<string, unknown> | undefined,
  right: Record<string, string>,
) {
  return left?.pk === right.pk && left?.sk === right.sk;
}

describe('canonical list storage and list index', () => {
  it('stores the owner pointer as role and addedAt only, beside storage metadata', async () => {
    const list = await createSubject();
    const pointer = await base.getItem(keys.listPointer(ALICE, list.listId));

    expect(Object.keys(pointer ?? {}).sort()).toEqual(
      [
        'addedAt',
        'createdAt',
        'entity',
        'listId',
        'pk',
        'role',
        'schemaVersion',
        'sk',
        'updatedAt',
        'userId',
      ].sort(),
    );
    expect(pointer).toMatchObject({
      listId: list.listId,
      userId: ALICE,
      role: 'owner',
      addedAt: NOW,
    });
  });

  it('uses one Query and one BatchGetItem for forty lists and restores pointer order', async () => {
    const lists = Array.from({ length: 40 }, (_, index) =>
      aList({ title: `List ${String(index).padStart(2, '0')}` }),
    );
    await Promise.all(
      lists.map((list) => repository.createList(ALICE, list, { now: NOW })),
    );

    const send = vi.spyOn(ddbModule.ddb, 'send');
    const page = await repository.listListsForUser(ALICE);

    expect(page.items).toHaveLength(40);
    expect(page.items.map(({ index }) => index.listId)).toEqual(
      [...lists]
        .sort((a, b) => (a.listId < b.listId ? -1 : 1))
        .map(({ listId }) => listId),
    );
    expect(page.items.every(({ list, index }) => list.listId === index.listId)).toBe(
      true,
    );
    expect(
      send.mock.calls.filter(([command]) => command instanceof QueryCommand),
    ).toHaveLength(1);
    expect(
      send.mock.calls.filter(([command]) => command instanceof BatchGetCommand),
    ).toHaveLength(1);
    await expect(repository.countOwnedLists(ALICE)).resolves.toBe(40);
  });

  it('renames only META and authorises from the caller pointer', async () => {
    const list = await createSubject();
    const send = vi.spyOn(ddbModule.ddb, 'send');

    const renamed = await repository.patchListMeta(
      ALICE,
      list.listId,
      { title: 'Weekend errands' },
      NOW,
      LATER,
    );

    expect(renamed.title).toBe('Weekend errands');
    expect(
      send.mock.calls.filter(([command]) => command instanceof UpdateCommand),
    ).toHaveLength(1);
    await expect(
      authz.assertListAccess(ALICE, list.listId, 'owner'),
    ).resolves.toMatchObject({
      index: { role: 'owner' },
      isOwner: true,
    });
    await expect(authz.assertListAccess(BEN, list.listId, 'read')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('ranked items', () => {
  it('adds ten, reorders last-to-front in four actions, and follows the moved locator', async () => {
    const list = await createSubject();
    const inputs = Array.from({ length: 10 }, (_, index) => anItem(`Item ${index}`));
    const created = await repository.createListItems(ALICE, list.listId, inputs, {
      now: NOW,
    });
    const last = created.at(-1);
    if (last === undefined) throw new Error('Ten-item fixture produced no last item.');
    expect((await repository.getListMeta(ALICE, list.listId))?.rankVersion).toBe(1);

    const send = vi.spyOn(ddbModule.ddb, 'send');
    const moved = await repository.reorderListItem(ALICE, list.listId, last.itemId, {
      now: LATER,
      afterItemId: null,
    });

    const writes = send.mock.calls.filter(
      ([command]) => command instanceof TransactWriteCommand,
    );
    expect(writes).toHaveLength(1);
    const transaction = writes[0]?.[0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    if (!(transaction instanceof TransactWriteCommand))
      throw new Error('Missing reorder transaction.');
    expect(transaction.input.TransactItems).toHaveLength(4);
    expect(transaction.input.TransactItems?.map((item) => Object.keys(item)[0])).toEqual([
      'Delete',
      'Put',
      'Update',
      'Update',
    ]);

    const page = await repository.listItems(ALICE, list.listId);
    expect(page?.items.map((item) => item.itemId)).toEqual([
      last.itemId,
      ...created.slice(0, 9).map((item) => item.itemId),
    ]);
    expect(page?.itemIds).toEqual(page?.items.map((item) => item.itemId));
    expect(page?.list.itemCount).toBe(10);
    expect(page?.list.rankVersion).toBe(2);
    await expect(
      repository.getListItem(ALICE, list.listId, moved.itemId),
    ).resolves.toEqual(moved);
  });

  it('serialises two inserts into one gap and retries the losing rank allocation once', async () => {
    const list = await createSubject();
    const anchors = await repository.createListItems(
      ALICE,
      list.listId,
      [anItem('Before'), anItem('After')],
      { now: NOW },
    );
    const lower = anchors[0];
    const upper = anchors[1];
    if (lower === undefined || upper === undefined) {
      throw new Error('Two-item fixture did not create both rank bounds.');
    }
    const metaKey = keys.listMeta(list.listId);
    const originalSend = ddbModule.ddb.send.bind(ddbModule.ddb);
    const send = vi.spyOn(ddbModule.ddb, 'send');
    let waiting = 0;
    let release: (() => void) | undefined;
    const bothReadVersion = new Promise<void>((resolve) => {
      release = resolve;
    });
    send.mockImplementation(async (command) => {
      const result = await originalSend(command as never);
      if (
        command instanceof GetCommand &&
        waiting < 2 &&
        sameKey(command.input.Key, metaKey)
      ) {
        waiting += 1;
        if (waiting === 2) release?.();
        await bothReadVersion;
      }
      return result as never;
    });

    const inserted = await Promise.all([
      repository.createListItem(ALICE, list.listId, anItem('First racer'), {
        now: LATER,
        afterItemId: lower.itemId,
      }),
      repository.createListItem(ALICE, list.listId, anItem('Second racer'), {
        now: LATER,
        afterItemId: lower.itemId,
      }),
    ]);

    expect(new Set(inserted.map((item) => item.rank))).toHaveLength(2);
    expect(
      inserted.every((item) => lower.rank < item.rank && item.rank < upper.rank),
    ).toBe(true);
    expect(
      send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand),
    ).toHaveLength(3);
    expect((await repository.getListMeta(ALICE, list.listId))?.rankVersion).toBe(3);
  });

  it('retries a field-patch/reorder race without losing either change', async () => {
    const list = await createSubject();
    const items = await repository.createListItems(
      ALICE,
      list.listId,
      [anItem('First'), anItem('Second'), anItem('Move me')],
      { now: NOW },
    );
    const target = items[2];
    if (target === undefined) throw new Error('Three-item fixture produced no target.');

    await Promise.all([
      repository.patchListItemFields(
        ALICE,
        list.listId,
        target.itemId,
        { title: 'Edited while moving', checked: true },
        LATER,
      ),
      repository.reorderListItem(ALICE, list.listId, target.itemId, {
        now: LATER,
        afterItemId: null,
      }),
    ]);

    const stored = await repository.getListItem(ALICE, list.listId, target.itemId);
    expect(stored).toMatchObject({
      title: 'Edited while moving',
      checked: true,
    });
    expect((await repository.listItems(ALICE, list.listId))?.items[0]?.itemId).toBe(
      target.itemId,
    );
    expect((await repository.getListMeta(ALICE, list.listId))?.uncheckedCount).toBe(2);
  });

  it('returns the repair trigger for an equal-rank neighbour without allocating', async () => {
    const list = await createSubject();
    const created = await repository.createListItems(
      ALICE,
      list.listId,
      [anItem('First'), anItem('Duplicate rank')],
      { now: NOW },
    );
    const first = created[0];
    const duplicate = created[1];
    if (first === undefined || duplicate === undefined) {
      throw new Error('Equal-rank fixture did not create both items.');
    }
    await base.deleteItem(keys.listItem(list.listId, duplicate.rank, duplicate.itemId));
    await base.putItem({
      ...keys.listItem(list.listId, first.rank, duplicate.itemId),
      entity: 'ListItem',
      ...duplicate,
      rank: first.rank,
      createdAt: NOW,
      updatedAt: NOW,
      schemaVersion: 1,
    });
    await base.updateItem(keys.listItemLocator(list.listId, duplicate.itemId), {
      expression: 'SET #rank = :rank',
      names: { '#rank': 'rank' },
      values: { ':rank': first.rank },
    });

    await expect(
      repository.createListItem(ALICE, list.listId, anItem('Must wait for repair'), {
        now: LATER,
        afterItemId: first.itemId,
      }),
    ).rejects.toBeInstanceOf(repository.ListRankRepairRequiredError);
  });

  it('surfaces a typed error after five rankVersion conflicts', async () => {
    const list = await createSubject();
    const originalSend = ddbModule.ddb.send.bind(ddbModule.ddb);
    const send = vi.spyOn(ddbModule.ddb, 'send');
    const reasons: CancellationReason[] = [
      { Code: 'None' },
      { Code: 'None' },
      { Code: 'None' },
      { Code: 'ConditionalCheckFailed' },
    ];
    const cancellation = new TransactionCanceledException({
      message: 'Forced rankVersion conflict',
      CancellationReasons: reasons,
      $metadata: {},
    });
    send.mockImplementation((command) =>
      command instanceof TransactWriteCommand
        ? Promise.reject(cancellation)
        : originalSend(command as never),
    );

    await expect(
      repository.createListItem(ALICE, list.listId, anItem('Never commits'), {
        now: LATER,
      }),
    ).rejects.toBeInstanceOf(repository.ListMutationRetryExhaustedError);
    expect(
      send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand),
    ).toHaveLength(5);
    expect((await repository.getListMeta(ALICE, list.listId))?.itemCount).toBe(0);
  });

  it("batch-gets only the caller's viewer links in requested item order", async () => {
    const list = await createSubject();
    const items = await repository.createListItems(
      ALICE,
      list.listId,
      [anItem('One'), anItem('Two')],
      { now: NOW },
    );
    const activityIds = [
      'act_01J8XKQ2M4N5P6R7S8T9V0W1AA',
      'act_01J8XKQ2M4N5P6R7S8T9V0W1AB',
      'act_01J8XKQ2M4N5P6R7S8T9V0W1AC',
    ];
    for (const [index, item] of items.entries()) {
      await base.putItem({
        ...keys.listItemActivityLink(list.listId, ALICE, item.itemId),
        entity: 'ListItemActivityLink',
        listId: list.listId,
        itemId: item.itemId,
        viewerUserId: ALICE,
        activityId: activityIds[index],
        linkedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        schemaVersion: 1,
      });
    }
    const first = items[0];
    if (first === undefined) throw new Error('Viewer-link fixture had no first item.');
    await base.putItem({
      ...keys.listItemActivityLink(list.listId, BEN, first.itemId),
      entity: 'ListItemActivityLink',
      listId: list.listId,
      itemId: first.itemId,
      viewerUserId: BEN,
      activityId: activityIds[2],
      linkedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      schemaVersion: 1,
    });

    const send = vi.spyOn(ddbModule.ddb, 'send');
    const links = await repository.batchGetViewerLinks(
      ALICE,
      list.listId,
      [...items].reverse().map((item) => item.itemId),
    );

    expect(links.map((link) => link.itemId)).toEqual(
      [...items].reverse().map((item) => item.itemId),
    );
    expect(links.every((link) => link.viewerUserId === ALICE)).toBe(true);
    expect(
      send.mock.calls.filter(([command]) => command instanceof BatchGetCommand),
    ).toHaveLength(1);
    const command = send.mock.calls.find(
      ([candidate]) => candidate instanceof BatchGetCommand,
    )?.[0];
    if (!(command instanceof BatchGetCommand))
      throw new Error('Missing viewer-link BatchGet.');
    const request = command.input.RequestItems?.[TEST_TABLE];
    expect(request?.Keys).toEqual(
      [...items]
        .reverse()
        .map((item) => keys.listItemActivityLink(list.listId, ALICE, item.itemId)),
    );
  });
});

describe('item tombstones and list cascade', () => {
  it('blocks ordinary id reuse and restores only the matching retained operation', async () => {
    const list = await createSubject();
    const input = anItem('Remember me');
    const created = await repository.createListItem(ALICE, list.listId, input, {
      now: NOW,
    });
    const operationId = repository.newListOperationId();
    await repository.deleteListItem(ALICE, list.listId, created.itemId, {
      operationId,
      tokenHash: 'sha256:test-token',
      undoExpiresAt: LATER,
      now: LATER,
    });

    await expect(
      repository.createListItem(ALICE, list.listId, input, { now: LATER }),
    ).rejects.toBeInstanceOf(repository.ListItemIdUnavailableError);
    await expect(
      repository.restoreListItem(ALICE, list.listId, created.itemId, {
        operationId: repository.newListOperationId(),
        now: LATER,
      }),
    ).rejects.toBeInstanceOf(repository.ListUndoNotApplicableError);

    const restored = await repository.restoreListItem(
      ALICE,
      list.listId,
      created.itemId,
      {
        operationId,
        now: LATER,
      },
    );
    expect(restored).toEqual(created);
    await expect(
      repository.getListItem(ALICE, list.listId, created.itemId),
    ).resolves.toEqual(created);
    await expect(
      repository.restoreListItem(ALICE, list.listId, created.itemId, {
        operationId,
        now: LATER,
      }),
    ).rejects.toBeInstanceOf(repository.ListUndoNotApplicableError);
  });

  it('leaves the list tombstone after child rows, source projection, pointer and META are gone', async () => {
    const sourceActivityId = 'act_01J8XKQ2M4N5P6R7S8T9V0W1AA';
    const list = await createSubject({ sourceActivityId });
    const item = await repository.createListItem(
      ALICE,
      list.listId,
      anItem('Temporary'),
      {
        now: NOW,
      },
    );

    await repository.deleteList(ALICE, list.listId, {
      now: LATER,
      expectedUpdatedAt: NOW,
      sourceActivityId,
    });

    await expect(repository.getListPointer(ALICE, list.listId)).resolves.toBeUndefined();
    await expect(repository.getListMeta(ALICE, list.listId)).resolves.toBeUndefined();
    await expect(
      base.getItem(keys.listItemLocator(list.listId, item.itemId)),
    ).resolves.toBeUndefined();
    await expect(
      base.getItem(keys.sourceList(sourceActivityId, list.listId)),
    ).resolves.toBeUndefined();
    await expect(base.getItem(keys.listTombstone(list.listId))).resolves.toMatchObject({
      listId: list.listId,
      ownerId: ALICE,
    });
    await expect(
      repository.createList(ALICE, list, { now: LATER }),
    ).rejects.toBeInstanceOf(repository.ListIdUnavailableError);
  });
});

describe('strong item-page fence', () => {
  it.each([
    ['rank version', 'rankVersion'],
    ['rank-repair gate', 'rankRepairId'],
    ['behaviour-migration gate', 'behaviourMigrationId'],
  ] as const)(
    'returns no page when the %s changes between the two META reads',
    async (_name, field) => {
      const list = await createSubject();
      await repository.createListItem(
        ALICE,
        list.listId,
        anItem('Visible only after a clean fence'),
        {
          now: NOW,
        },
      );
      const originalSend = ddbModule.ddb.send.bind(ddbModule.ddb);
      const send = vi.spyOn(ddbModule.ddb, 'send');
      send.mockImplementationOnce(async (command) => {
        const result = await originalSend(command as never);
        await documents.send(
          new UpdateCommand({
            TableName: TEST_TABLE,
            Key: keys.listMeta(list.listId),
            UpdateExpression:
              field === 'rankVersion'
                ? 'SET #field = #field + :one'
                : 'SET #field = :operationId',
            ExpressionAttributeNames: { '#field': field },
            ExpressionAttributeValues:
              field === 'rankVersion'
                ? { ':one': 1 }
                : { ':operationId': 'op_fence_test' },
          }),
        );
        return result as never;
      });

      await expect(repository.listItems(ALICE, list.listId)).rejects.toBeInstanceOf(
        repository.ListReadFenceError,
      );
      expect(
        send.mock.calls.filter(([command]) => command instanceof QueryCommand),
      ).toHaveLength(1);
    },
  );

  it('rejects a cursor bound to an earlier rankVersion before querying item rows', async () => {
    const list = await createSubject();
    const firstChunk = Array.from({ length: 30 }, (_, index) => anItem(`Item ${index}`));
    const first = await repository.createListItems(ALICE, list.listId, firstChunk, {
      now: NOW,
    });
    const firstChunkLast = first.at(-1);
    if (firstChunkLast === undefined) throw new Error('First page fixture was empty.');
    const secondChunk = Array.from({ length: 21 }, (_, index) =>
      anItem(`Item ${index + 30}`),
    );
    await repository.createListItems(ALICE, list.listId, secondChunk, {
      now: NOW,
      afterItemId: firstChunkLast.itemId,
    });
    const firstPage = await repository.listItems(ALICE, list.listId);
    expect(firstPage?.items).toHaveLength(50);
    expect(firstPage?.nextCursor).toBeDefined();
    await repository.createListItem(ALICE, list.listId, anItem('Version changer'), {
      now: LATER,
    });

    const send = vi.spyOn(ddbModule.ddb, 'send');
    await expect(
      repository.listItems(ALICE, list.listId, firstPage?.nextCursor),
    ).rejects.toBeInstanceOf(repository.ListReadFenceError);
    expect(
      send.mock.calls.filter(([command]) => command instanceof QueryCommand),
    ).toHaveLength(0);
  });
});
