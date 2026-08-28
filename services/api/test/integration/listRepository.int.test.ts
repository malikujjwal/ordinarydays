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
import { instant } from '@od/shared/schemas';
import type { Activity, List, ListItem } from '@od/shared/types';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { documents, TEST_TABLE, useTestTable } from './harness.js';

useTestTable();

type Repository = typeof import('../../src/repositories/listRepository.js');
type Base = typeof import('../../src/repositories/base.js');
type Keys = typeof import('../../src/repositories/keys.js');
type Ddb = typeof import('../../src/lib/ddb.js');
type Authz = typeof import('../../src/services/authz.js');
type ActivityRepository = typeof import('../../src/repositories/activityRepository.js');

let repository: Repository;
let base: Base;
let keys: Keys;
let ddbModule: Ddb;
let authz: Authz;
let activityRepository: ActivityRepository;
type ListAccessGrant = NonNullable<Awaited<ReturnType<Repository['getListPointer']>>>;
const accessByListId = new Map<string, ListAccessGrant>();

const ALICE = 'usr_int_lists_alice';
const BEN = 'usr_int_lists_ben';
const NOW = instant.parse('2026-08-23T14:00:00.000Z');
const LATER = instant.parse('2026-08-23T14:01:00.000Z');

beforeAll(async () => {
  repository = await import('../../src/repositories/listRepository.js');
  base = await import('../../src/repositories/base.js');
  keys = await import('../../src/repositories/keys.js');
  ddbModule = await import('../../src/lib/ddb.js');
  authz = await import('../../src/services/authz.js');
  activityRepository = await import('../../src/repositories/activityRepository.js');
});

afterEach(() => {
  vi.restoreAllMocks();
  accessByListId.clear();
});

const aList = (overrides: Partial<List> = {}): List => ({
  schemaVersion: 2,
  listId: repository.newListId(),
  ownerId: ALICE,
  templateKey: 'simple-list',
  title: 'Errands',
  icon: 'list',
  emptyStateCopy: 'Nothing here yet.',
  itemStateMode: { mode: 'checkbox' },
  featureConfig: {},
  slot: null,
  itemCount: 0,
  doneCount: 0,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: NOW,
  lastItemActivityAt: NOW,
  ...overrides,
});

type NewItem = Omit<ListItem, 'listId' | 'rank' | 'itemRevision'>;

const anItem = (title: string, overrides: Partial<NewItem> = {}): NewItem => ({
  itemId: repository.newItemId(),
  title,
  state: 'open',
  ...overrides,
});

const linkedActivity = (
  activityId: string,
  ownerId: string,
  listId: string,
  itemId: string,
): Activity => ({
  activityId,
  ownerId,
  objectKind: 'plan',
  type: 'custom',
  status: 'saved',
  title: 'Plan from list item',
  details: { kind: 'custom' },
  listId,
  listItemId: itemId,
  participantCount: 0,
  childCount: 0,
  expenseTotalCents: 0,
  visibility: 'private',
  icsSequence: 0,
  createdAt: NOW,
  lastActivityAt: NOW,
  updatedAt: NOW,
  schemaVersion: 1,
});

async function createSubject(overrides: Partial<List> = {}): Promise<List> {
  const list = aList(overrides);
  await repository.createList(ALICE, list, { now: NOW });
  const access = await repository.getListPointer(ALICE, list.listId);
  if (access === undefined) throw new Error('Created list has no owner access grant.');
  accessByListId.set(list.listId, access);
  return list;
}

function accessFor(list: List): ListAccessGrant {
  const access = accessByListId.get(list.listId);
  if (access === undefined) throw new Error('List fixture has no access grant.');
  return access;
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

    await repository.patchListMeta(
      ALICE,
      list.listId,
      accessFor(list),
      { title: 'Weekend errands' },
      NOW,
      LATER,
    );

    await expect(
      repository.getListMeta(ALICE, list.listId, accessFor(list)),
    ).resolves.toMatchObject({ title: 'Weekend errands', updatedAt: LATER });
    const writes = send.mock.calls.filter(
      ([command]) => command instanceof TransactWriteCommand,
    );
    expect(writes).toHaveLength(1);
    const rename = writes[0]?.[0];
    if (!(rename instanceof TransactWriteCommand)) {
      throw new Error('Missing rename transaction.');
    }
    expect(rename.input.TransactItems?.filter((item) => item.Update)).toHaveLength(1);
    await expect(
      authz.assertListAccess(ALICE, list.listId, 'owner'),
    ).resolves.toMatchObject({
      index: { role: 'owner' },
      isOwner: true,
    });
    await expect(authz.assertListAccess(BEN, list.listId, 'read')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      repository.getListMeta(BEN, list.listId, accessFor(list)),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      repository.deleteList(BEN, list.listId, accessFor(list), {
        now: LATER,
        expectedUpdatedAt: LATER,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('ranked items', () => {
  it('adds ten, reorders last-to-front in four actions, and follows the moved locator', async () => {
    const list = await createSubject();
    const inputs = Array.from({ length: 10 }, (_, index) => anItem(`Item ${index}`));
    const created = await repository.createListItems(
      ALICE,
      list.listId,
      accessFor(list),
      inputs,
      { now: NOW },
    );
    const last = created.at(-1);
    if (last === undefined) throw new Error('Ten-item fixture produced no last item.');
    expect(
      (await repository.getListMeta(ALICE, list.listId, accessFor(list)))?.rankVersion,
    ).toBe(1);

    const send = vi.spyOn(ddbModule.ddb, 'send');
    const moved = await repository.reorderListItem(
      ALICE,
      list.listId,
      accessFor(list),
      last.itemId,
      { now: LATER, afterItemId: null },
    );

    const writes = send.mock.calls.filter(
      ([command]) => command instanceof TransactWriteCommand,
    );
    expect(writes).toHaveLength(1);
    const transaction = writes[0]?.[0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    if (!(transaction instanceof TransactWriteCommand))
      throw new Error('Missing reorder transaction.');
    expect(transaction.input.TransactItems).toHaveLength(5);
    expect(
      transaction.input.TransactItems?.slice(1).map((item) => Object.keys(item)[0]),
    ).toEqual(['Delete', 'Put', 'Update', 'Update']);

    const page = await repository.listItems(ALICE, list.listId, accessFor(list));
    expect(page?.items.map((item) => item.itemId)).toEqual([
      last.itemId,
      ...created.slice(0, 9).map((item) => item.itemId),
    ]);
    expect(page?.itemIds).toEqual(page?.items.map((item) => item.itemId));
    expect(page?.list.itemCount).toBe(10);
    expect(page?.list.rankVersion).toBe(2);
    await expect(
      repository.getListItem(ALICE, list.listId, accessFor(list), moved.itemId),
    ).resolves.toEqual(moved);
  });

  it('serialises two inserts into one gap and retries the losing rank allocation once', async () => {
    const list = await createSubject();
    const anchors = await repository.createListItems(
      ALICE,
      list.listId,
      accessFor(list),
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
      repository.createListItem(
        ALICE,
        list.listId,
        accessFor(list),
        anItem('First racer'),
        {
          now: LATER,
          afterItemId: lower.itemId,
        },
      ),
      repository.createListItem(
        ALICE,
        list.listId,
        accessFor(list),
        anItem('Second racer'),
        {
          now: LATER,
          afterItemId: lower.itemId,
        },
      ),
    ]);

    expect(new Set(inserted.map((item) => item.rank))).toHaveLength(2);
    expect(
      inserted.every((item) => lower.rank < item.rank && item.rank < upper.rank),
    ).toBe(true);
    expect(
      send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand),
    ).toHaveLength(3);
    expect(
      (await repository.getListMeta(ALICE, list.listId, accessFor(list)))?.rankVersion,
    ).toBe(3);
  });

  it('retries a field-patch/reorder race without losing either change', async () => {
    const list = await createSubject();
    const items = await repository.createListItems(
      ALICE,
      list.listId,
      accessFor(list),
      [anItem('First'), anItem('Second'), anItem('Move me')],
      { now: NOW },
    );
    const target = items[2];
    if (target === undefined) throw new Error('Three-item fixture produced no target.');

    await Promise.all([
      repository.patchListItemFields(
        ALICE,
        list.listId,
        accessFor(list),
        target.itemId,
        { title: 'Edited while moving', state: 'done' },
        LATER,
      ),
      repository.reorderListItem(ALICE, list.listId, accessFor(list), target.itemId, {
        now: LATER,
        afterItemId: null,
      }),
    ]);

    const stored = await repository.getListItem(
      ALICE,
      list.listId,
      accessFor(list),
      target.itemId,
    );
    expect(stored).toMatchObject({
      title: 'Edited while moving',
      state: 'done',
    });
    expect(
      (await repository.listItems(ALICE, list.listId, accessFor(list)))?.items[0]?.itemId,
    ).toBe(target.itemId);
    expect(
      (await repository.getListMeta(ALICE, list.listId, accessFor(list)))?.doneCount,
    ).toBe(1);
  });

  it('returns the repair trigger for an equal-rank neighbour without allocating', async () => {
    const list = await createSubject();
    const created = await repository.createListItems(
      ALICE,
      list.listId,
      accessFor(list),
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
      repository.createListItem(
        ALICE,
        list.listId,
        accessFor(list),
        anItem('Must wait for repair'),
        {
          now: LATER,
          afterItemId: first.itemId,
        },
      ),
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
      repository.createListItem(
        ALICE,
        list.listId,
        accessFor(list),
        anItem('Never commits'),
        {
          now: LATER,
        },
      ),
    ).rejects.toBeInstanceOf(repository.ListMutationRetryExhaustedError);
    expect(
      send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand),
    ).toHaveLength(5);
    expect(
      (await repository.getListMeta(ALICE, list.listId, accessFor(list)))?.itemCount,
    ).toBe(0);
  });

  it("batch-gets only the caller's viewer links in requested item order", async () => {
    const list = await createSubject();
    const items = await repository.createListItems(
      ALICE,
      list.listId,
      accessFor(list),
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
      accessFor(list),
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
    const created = await repository.createListItem(
      ALICE,
      list.listId,
      accessFor(list),
      input,
      { now: NOW },
    );
    const operationId = repository.newListOperationId();
    await repository.deleteListItem(ALICE, list.listId, accessFor(list), created.itemId, {
      operationId,
      tokenHash: 'sha256:test-token',
      undoExpiresAt: LATER,
      now: LATER,
    });

    await expect(
      repository.createListItem(ALICE, list.listId, accessFor(list), input, {
        now: LATER,
      }),
    ).rejects.toBeInstanceOf(repository.ListItemIdUnavailableError);
    await expect(
      repository.restoreListItem(ALICE, list.listId, accessFor(list), created.itemId, {
        operationId: repository.newListOperationId(),
        now: LATER,
      }),
    ).rejects.toBeInstanceOf(repository.ListUndoNotApplicableError);

    const restored = await repository.restoreListItem(
      ALICE,
      list.listId,
      accessFor(list),
      created.itemId,
      {
        operationId,
        now: LATER,
      },
    );
    expect(restored).toEqual(created);
    await expect(
      repository.getListItem(ALICE, list.listId, accessFor(list), created.itemId),
    ).resolves.toEqual(created);
    await expect(
      repository.restoreListItem(ALICE, list.listId, accessFor(list), created.itemId, {
        operationId,
        now: LATER,
      }),
    ).rejects.toBeInstanceOf(repository.ListUndoNotApplicableError);
  });

  it('restores live links and Activity provenance while omitting a deleted Activity', async () => {
    const list = await createSubject();
    const item = await repository.createListItem(
      ALICE,
      list.listId,
      accessFor(list),
      anItem('Linked item'),
      { now: NOW },
    );
    const aliceActivity = linkedActivity(
      'act_01J8XKQ2M4N5P6R7S8T9V0W1AA',
      ALICE,
      list.listId,
      item.itemId,
    );
    const benActivity = linkedActivity(
      'act_01J8XKQ2M4N5P6R7S8T9V0W1AB',
      BEN,
      list.listId,
      item.itemId,
    );
    await Promise.all([
      activityRepository.createActivity(ALICE, aliceActivity),
      activityRepository.createActivity(BEN, benActivity),
      base.putItem({
        ...keys.listMember(list.listId, 'psn_01J8XKQ2M4N5P6R7S8T9V0W1AA'),
        entity: 'ListMember',
        listId: list.listId,
        personId: 'psn_01J8XKQ2M4N5P6R7S8T9V0W1AA',
        userId: BEN,
        displayName: 'Ben',
        role: 'member',
        status: 'active',
        invitedBy: ALICE,
        addedAt: NOW,
        joinedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        schemaVersion: 1,
      }),
      base.putItem({
        ...keys.listPointer(BEN, list.listId),
        entity: 'ListIndex',
        listId: list.listId,
        userId: BEN,
        role: 'member',
        addedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        schemaVersion: 1,
      }),
    ]);
    for (const [viewerUserId, activityId] of [
      [ALICE, aliceActivity.activityId],
      [BEN, benActivity.activityId],
    ] as const) {
      await base.putItem({
        ...keys.listItemActivityLink(list.listId, viewerUserId, item.itemId),
        entity: 'ListItemActivityLink',
        listId: list.listId,
        itemId: item.itemId,
        viewerUserId,
        activityId,
        linkedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        schemaVersion: 1,
      });
    }

    const operationId = repository.newListOperationId();
    await repository.deleteListItem(ALICE, list.listId, accessFor(list), item.itemId, {
      operationId,
      tokenHash: 'sha256:linked-token',
      undoExpiresAt: LATER,
      now: LATER,
    });

    await expect(
      base.getItem(keys.listItemTombstone(list.listId, item.itemId)),
    ).resolves.toMatchObject({
      viewerLinks: [
        { viewerUserId: ALICE, activityId: aliceActivity.activityId },
        { viewerUserId: BEN, activityId: benActivity.activityId },
      ],
      activityProvenance: [
        {
          activityId: aliceActivity.activityId,
          listId: list.listId,
          listItemId: item.itemId,
        },
        {
          activityId: benActivity.activityId,
          listId: list.listId,
          listItemId: item.itemId,
        },
      ],
    });
    await expect(
      base.getItem(keys.listItemActivityLink(list.listId, ALICE, item.itemId)),
    ).resolves.toBeUndefined();
    await expect(
      activityRepository.getActivityMeta(aliceActivity.activityId),
    ).resolves.not.toHaveProperty('listId');
    await expect(
      activityRepository.getActivityMeta(benActivity.activityId),
    ).resolves.not.toHaveProperty('listItemId');

    await activityRepository.deleteActivity(BEN, benActivity.activityId, { now: LATER });
    await repository.restoreListItem(ALICE, list.listId, accessFor(list), item.itemId, {
      operationId,
      now: LATER,
    });

    await expect(
      base.getItem(keys.listItemActivityLink(list.listId, ALICE, item.itemId)),
    ).resolves.toMatchObject({
      viewerUserId: ALICE,
      activityId: aliceActivity.activityId,
      linkedAt: NOW,
    });
    await expect(
      base.getItem(keys.listItemActivityLink(list.listId, BEN, item.itemId)),
    ).resolves.toBeUndefined();
    await expect(
      activityRepository.getActivityMeta(aliceActivity.activityId),
    ).resolves.toMatchObject({ listId: list.listId, listItemId: item.itemId });
    await expect(
      repository.getListItem(ALICE, list.listId, accessFor(list), item.itemId),
    ).resolves.toEqual(item);
  });

  it('leaves the list tombstone after child rows, source projection, pointer and META are gone', async () => {
    const sourceActivityId = 'act_01J8XKQ2M4N5P6R7S8T9V0W1AA';
    // P3-05's create transaction re-asserts the source Plan at commit time, so the
    // fixture Plan must genuinely exist rather than being a dangling id.
    const {
      listId: _provenanceListId,
      listItemId: _provenanceItemId,
      ...sourcePlan
    } = linkedActivity(sourceActivityId, ALICE, 'ignored', 'ignored');
    await activityRepository.createActivity(ALICE, sourcePlan as Activity);
    const list = await createSubject({ sourceActivityId });
    const item = await repository.createListItem(
      ALICE,
      list.listId,
      accessFor(list),
      anItem('Temporary'),
      {
        now: NOW,
      },
    );

    await repository.deleteList(ALICE, list.listId, accessFor(list), {
      now: LATER,
      expectedUpdatedAt: NOW,
      sourceActivityId,
    });

    await expect(repository.getListPointer(ALICE, list.listId)).resolves.toBeUndefined();
    await expect(
      repository.getListMeta(ALICE, list.listId, accessFor(list)),
    ).resolves.toBeUndefined();
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

  it('hides a tombstoned cascade and rejects an item created after its child snapshot', async () => {
    const list = await createSubject();
    const original = await repository.createListItem(
      ALICE,
      list.listId,
      accessFor(list),
      anItem('Captured child'),
      { now: NOW },
    );
    const raced = anItem('Must not become an orphan');
    const originalSend = ddbModule.ddb.send.bind(ddbModule.ddb);
    const send = vi.spyOn(ddbModule.ddb, 'send');
    let releaseCascade: (() => void) | undefined;
    let markSnapshotCaptured: (() => void) | undefined;
    const cascadeReleased = new Promise<void>((resolve) => {
      releaseCascade = resolve;
    });
    const snapshotCaptured = new Promise<void>((resolve) => {
      markSnapshotCaptured = resolve;
    });
    let heldSnapshot = false;
    send.mockImplementation(async (command) => {
      const result = await originalSend(command as never);
      if (command instanceof QueryCommand && !heldSnapshot) {
        heldSnapshot = true;
        markSnapshotCaptured?.();
        await cascadeReleased;
      }
      return result as never;
    });

    const deleting = repository.deleteList(ALICE, list.listId, accessFor(list), {
      now: LATER,
      expectedUpdatedAt: NOW,
    });
    await snapshotCaptured;

    await expect(
      repository.listItems(ALICE, list.listId, accessFor(list)),
    ).resolves.toBeUndefined();
    await expect(
      repository.createListItem(ALICE, list.listId, accessFor(list), raced, {
        now: LATER,
      }),
    ).rejects.toBeInstanceOf(repository.ListNotFoundError);

    releaseCascade?.();
    await deleting;
    await expect(
      base.getItem(keys.listItemLocator(list.listId, original.itemId)),
    ).resolves.toBeUndefined();
    await expect(
      base.getItem(keys.listItemLocator(list.listId, raced.itemId)),
    ).resolves.toBeUndefined();
  });
});

describe('strong item-page fence', () => {
  it.each([
    ['rank version', 'rankVersion'],
    ['rank-repair gate', 'rankRepairId'],
    ['schema-migration gate', 'schemaMigrationId'],
  ] as const)(
    'returns no page when the %s changes between the two META reads',
    async (_name, field) => {
      const list = await createSubject();
      await repository.createListItem(
        ALICE,
        list.listId,
        accessFor(list),
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

      await expect(
        repository.listItems(ALICE, list.listId, accessFor(list)),
      ).rejects.toBeInstanceOf(repository.ListReadFenceError);
      expect(
        send.mock.calls.filter(([command]) => command instanceof QueryCommand),
      ).toHaveLength(1);
    },
  );

  it('returns no rows when deletion starts between the item query and post-read', async () => {
    const list = await createSubject();
    await repository.createListItem(
      ALICE,
      list.listId,
      accessFor(list),
      anItem('Must not cross deletion'),
      { now: NOW },
    );
    const originalSend = ddbModule.ddb.send.bind(ddbModule.ddb);
    const send = vi.spyOn(ddbModule.ddb, 'send');
    let installed = false;
    send.mockImplementation(async (command) => {
      const result = await originalSend(command as never);
      if (command instanceof QueryCommand && !installed) {
        installed = true;
        await base.putItem({
          ...keys.listTombstone(list.listId),
          entity: 'ListTombstone',
          listId: list.listId,
          ownerId: ALICE,
          deletedAt: LATER,
          ttl: 2_000_000_000,
          createdAt: LATER,
          updatedAt: LATER,
          schemaVersion: 1,
        });
      }
      return result as never;
    });

    await expect(
      repository.listItems(ALICE, list.listId, accessFor(list)),
    ).resolves.toBeUndefined();
    expect(installed).toBe(true);
  });

  it('rejects a cursor bound to an earlier rankVersion before querying item rows', async () => {
    const list = await createSubject();
    const firstChunk = Array.from({ length: 30 }, (_, index) => anItem(`Item ${index}`));
    const first = await repository.createListItems(
      ALICE,
      list.listId,
      accessFor(list),
      firstChunk,
      { now: NOW },
    );
    const firstChunkLast = first.at(-1);
    if (firstChunkLast === undefined) throw new Error('First page fixture was empty.');
    const secondChunk = Array.from({ length: 21 }, (_, index) =>
      anItem(`Item ${index + 30}`),
    );
    await repository.createListItems(ALICE, list.listId, accessFor(list), secondChunk, {
      now: NOW,
      afterItemId: firstChunkLast.itemId,
    });
    const firstPage = await repository.listItems(ALICE, list.listId, accessFor(list));
    expect(firstPage?.items).toHaveLength(50);
    expect(firstPage?.nextCursor).toBeDefined();
    await repository.createListItem(
      ALICE,
      list.listId,
      accessFor(list),
      anItem('Version changer'),
      {
        now: LATER,
      },
    );

    const send = vi.spyOn(ddbModule.ddb, 'send');
    await expect(
      repository.listItems(ALICE, list.listId, accessFor(list), firstPage?.nextCursor),
    ).rejects.toBeInstanceOf(repository.ListReadFenceError);
    expect(
      send.mock.calls.filter(([command]) => command instanceof QueryCommand),
    ).toHaveLength(0);
  });
});
