import { MAX_LEXO_RANK_LENGTH } from '@od/shared';
import type {
  Activity,
  List,
  ListIndex,
  ListItem,
  ListItemActivityLink,
} from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdempotencyReceipt } from '../lib/idempotency.js';
import { encodeCursor, encodeFencedCursor } from './cursor.js';

vi.mock('./base.js', () => ({
  batchGetItems: vi.fn(),
  deleteAll: vi.fn(),
  getItem: vi.fn(),
  query: vi.fn(),
  queryAll: vi.fn(),
  queryCount: vi.fn(),
  updateItem: vi.fn(),
}));

vi.mock('./tx.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tx.js')>();
  return { ...actual, transactWrite: vi.fn() };
});

vi.mock('./idempotencyRepository.js', () => ({
  receiptItem: vi.fn(() => ({ Put: { Item: { receipt: true } } })),
}));

const repository = await import('./listRepository.js');
const base = await import('./base.js');
const keys = await import('./keys.js');
const tx = await import('./tx.js');

const ALICE = 'usr_list_unit_alice';
const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ITEM_A = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ITEM_B = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const ACTIVITY_ID = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X4';
const NOW = '2026-08-23T14:00:00.000Z';
const LATER = '2026-08-23T14:01:00.000Z';

const list = (overrides: Partial<List> = {}): List => ({
  listId: LIST_ID,
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

const listRow = (overrides: Partial<List> = {}) => ({
  ...keys.listMeta(LIST_ID),
  entity: 'List',
  createdAt: NOW,
  schemaVersion: 1,
  ...list(overrides),
});

const indexRow = (overrides: Partial<ListIndex> = {}) => ({
  ...keys.listPointer(ALICE, LIST_ID),
  entity: 'ListIndex',
  createdAt: NOW,
  updatedAt: NOW,
  schemaVersion: 1,
  listId: LIST_ID,
  userId: ALICE,
  role: 'owner' as const,
  addedAt: NOW,
  ...overrides,
});

const item = (overrides: Partial<ListItem> = {}): ListItem => ({
  itemId: ITEM_A,
  listId: LIST_ID,
  rank: 'V',
  itemRevision: 0,
  title: 'Milk',
  checked: false,
  ...overrides,
});

const itemRow = (value: ListItem = item()) => ({
  ...keys.listItem(value.listId, value.rank, value.itemId),
  entity: 'ListItem',
  createdAt: NOW,
  updatedAt: NOW,
  schemaVersion: 1,
  ...value,
});

const locatorRow = (value: ListItem = item()) => ({
  ...keys.listItemLocator(value.listId, value.itemId),
  entity: 'ListItemLocator',
  createdAt: NOW,
  updatedAt: NOW,
  schemaVersion: 1,
  listId: value.listId,
  itemId: value.itemId,
  rank: value.rank,
  itemRevision: value.itemRevision,
});

const activity = (overrides: Partial<Activity> = {}): Activity =>
  ({
    activityId: ACTIVITY_ID,
    ownerId: ALICE,
    objectKind: 'plan',
    type: 'custom',
    status: 'saved',
    title: 'Plan milk',
    details: { kind: 'custom' },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: NOW,
    lastActivityAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    ...overrides,
  }) as Activity;

const activityRow = (value: Activity = activity()) => ({
  ...keys.activityMeta(value.activityId),
  entity: 'Activity',
  ...value,
});

const viewerLink = (): ListItemActivityLink => ({
  listId: LIST_ID,
  itemId: ITEM_A,
  viewerUserId: ALICE,
  activityId: ACTIVITY_ID,
  linkedAt: NOW,
});

const viewerLinkRow = () => ({
  ...keys.listItemActivityLink(LIST_ID, ALICE, ITEM_A),
  entity: 'ListItemActivityLink',
  createdAt: NOW,
  updatedAt: NOW,
  schemaVersion: 1,
  ...viewerLink(),
});

const receipt: IdempotencyReceipt = {
  userId: ALICE,
  key: 'idem-list-unit',
  route: 'POST /v1/lists',
  status: 201,
  body: '{}',
  ttl: 2_000_000_000,
  createdAt: NOW,
};

let access: NonNullable<Awaited<ReturnType<typeof repository.getListPointer>>>;

function mockResolvedItem(value: ListItem = item(), meta: List = list()): void {
  vi.mocked(base.getItem).mockImplementation(async (key) => {
    if (key.sk === keys.listMeta(LIST_ID).sk) return listRow(meta);
    if (key.sk === keys.listItemLocator(LIST_ID, value.itemId).sk) {
      return locatorRow(value);
    }
    if (key.sk === keys.listItem(LIST_ID, value.rank, value.itemId).sk) {
      return itemRow(value);
    }
    return undefined;
  });
}

function mockLiveList(meta: List = list()): void {
  vi.mocked(base.getItem).mockImplementation(async (key) =>
    key.sk === keys.listMeta(LIST_ID).sk ? listRow(meta) : undefined,
  );
}

beforeEach(async () => {
  vi.mocked(base.batchGetItems).mockReset();
  vi.mocked(base.deleteAll).mockReset();
  vi.mocked(base.getItem).mockReset();
  vi.mocked(base.query).mockReset();
  vi.mocked(base.queryAll).mockReset();
  vi.mocked(base.queryCount).mockReset();
  vi.mocked(base.updateItem).mockReset();
  vi.mocked(tx.transactWrite).mockReset();
  vi.mocked(tx.transactWrite).mockResolvedValue(undefined);
  vi.mocked(base.query).mockResolvedValue({ items: [] });
  vi.mocked(base.batchGetItems).mockResolvedValue([]);
  vi.mocked(base.queryAll).mockResolvedValue([]);
  vi.mocked(base.deleteAll).mockResolvedValue(undefined);
  vi.mocked(base.getItem).mockResolvedValueOnce(indexRow());
  const issued = await repository.getListPointer(ALICE, LIST_ID);
  if (issued === undefined) throw new Error('Access-grant fixture was not issued.');
  access = issued;
  vi.mocked(base.getItem).mockReset();
});

/** Every action of every transaction the call built, in order. */
const transacted = () =>
  vi.mocked(tx.transactWrite).mock.calls.flatMap(([items]) => items);

const written = (entity: string) =>
  transacted().flatMap((entry) =>
    entry.Put?.Item?.entity === entity ? [entry.Put.Item] : [],
  );

const SURVIVOR = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1A1';
const MANUAL = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1A2';
const OTHER = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1A3';
const GONE = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1A4';

describe('the bulk checked operations', () => {
  const checkedItems = (count: number): ListItem[] =>
    Array.from({ length: count }, (_, index) =>
      item({
        itemId: `itm_01J8XKQ2M4N5P6R7S8T9V0W1${String(index).padStart(2, '0')}`,
        rank: `a${String(index)}`,
        checked: true,
        title: `Item ${String(index)}`,
      }),
    );

  const seedChecked = (count: number, extra: ListItem[] = []) => {
    vi.mocked(base.getItem).mockImplementation(async (key) =>
      key.sk === keys.listMeta(LIST_ID).sk ? listRow({ itemCount: count }) : undefined,
    );
    // Discriminated by prefix: the member query the relationship snapshot runs must not be
    // answered with item rows.
    const rows = [...checkedItems(count), ...extra].map((value) => itemRow(value));
    vi.mocked(base.queryAll).mockImplementation(async (_key, options) =>
      options?.skPrefix === 'ITEM#' ? rows : [],
    );
  };

  const plan = () => ({
    undoToken: 'blk_op.secret',
    tokenHash: 'stored-hash',
    undoExpiresAt: LATER,
    receipt,
  });

  const run = (kind: 'clear_checked' | 'uncheck_all') =>
    repository.runBulkCheckedOperation(ALICE, LIST_ID, access, {
      operationId: 'blk_op',
      kind,
      now: LATER,
      plan,
    });

  /**
   * One `UNDO#` record for the whole run, however many transactions it takes: "bounded
   * receipt-aware chunks preserve one logical Undo operation". It lands with the work record
   * before anything is applied, naming every id the operation will take.
   */
  it('deletes only the checked rows under one operation naming them all', async () => {
    seedChecked(3, [item({ itemId: ITEM_B, rank: 'z0', checked: false })]);

    const result = await run('clear_checked');

    expect(result.affectedCount).toBe(3);
    expect(result.undoToken).toBe('blk_op.secret');
    const undos = written('ListUndo');
    expect(undos).toHaveLength(1);
    expect(undos[0]).toMatchObject({
      kind: 'clear_checked',
      consumed: false,
      tokenHash: 'stored-hash',
      affectedItemIds: checkedItems(3).map((value) => value.itemId),
    });
    expect(written('ListItemTombstone')).toHaveLength(3);
    // The unchecked row is not touched.
    expect(
      transacted().some((entry) => String(entry.Delete?.Key?.sk ?? '').includes(ITEM_B)),
    ).toBe(false);
  });

  /**
   * The token the client will receive, the deadline it was promised for and the receipt the
   * last chunk will store are all decided **once** and recorded, so a retry that resumes this
   * operation answers with the same values rather than minting a second set.
   */
  it('records the prepared answer, and deletes it when the operation finishes', async () => {
    seedChecked(2);

    await run('clear_checked');

    const work = written('ListBulkOperation');
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      operationId: 'blk_op',
      kind: 'clear_checked',
      cursor: 0,
      undoToken: 'blk_op.secret',
      undoExpiresAt: LATER,
    });
    // Deleted by the transaction that finishes, so the plaintext token's life is the run.
    expect(
      transacted().some(
        (entry) => entry.Delete?.Key?.sk === keys.listBulkOperation(LIST_ID, 'blk_op').sk,
      ),
    ).toBe(true);
  });

  /**
   * The defect this record exists to prevent: a retry under the same key must **resume**, not
   * start again. It reads back the token the first attempt promised rather than minting one
   * the client would never receive.
   */
  it('resumes an outstanding operation without re-planning it', async () => {
    seedChecked(2);
    vi.mocked(base.getItem).mockImplementation(async (key) => {
      if (key.sk === keys.listMeta(LIST_ID).sk) return listRow({ itemCount: 2 });
      if (key.sk === keys.listBulkOperation(LIST_ID, 'blk_op').sk) {
        return {
          ...keys.listBulkOperation(LIST_ID, 'blk_op'),
          entity: 'ListBulkOperation',
          schemaVersion: 1,
          listId: LIST_ID,
          operationId: 'blk_op',
          kind: 'clear_checked',
          itemIds: checkedItems(2).map((value) => value.itemId),
          cursor: 1,
          undoToken: 'blk_op.first-attempt-secret',
          undoExpiresAt: NOW,
          receipt,
        };
      }
      return undefined;
    });
    const planSpy = vi.fn(plan);

    const result = await repository.runBulkCheckedOperation(ALICE, LIST_ID, access, {
      operationId: 'blk_op',
      kind: 'clear_checked',
      now: LATER,
      plan: planSpy,
    });

    expect(planSpy).not.toHaveBeenCalled();
    expect(result.undoToken).toBe('blk_op.first-attempt-secret');
    expect(result.undoExpiresAt).toBe(NOW);
    expect(result.affectedCount).toBe(2);
    // No second operation record, and no second Undo record.
    expect(written('ListBulkOperation')).toHaveLength(0);
    expect(written('ListUndo')).toHaveLength(0);
    // Only the item the cursor had not reached.
    expect(written('ListItemTombstone')).toHaveLength(1);
  });

  /** Every deleted row was checked, so none of them was contributing to `uncheckedCount`. */
  it('moves itemCount and leaves uncheckedCount alone', async () => {
    seedChecked(2);

    await run('clear_checked');

    const meta = transacted().find(
      (entry) =>
        entry.Update?.Key?.sk === keys.listMeta(LIST_ID).sk &&
        String(entry.Update.UpdateExpression).includes('itemCount'),
    )?.Update;
    expect(meta?.UpdateExpression).toBe('ADD #itemCount :delta');
    expect(meta?.ExpressionAttributeValues).toMatchObject({ ':delta': -2 });
  });

  it('records an empty operation when nothing is checked', async () => {
    seedChecked(0);

    await expect(run('clear_checked')).resolves.toMatchObject({ affectedCount: 0 });
    expect(written('ListUndo')[0]).toMatchObject({ affectedItemIds: [] });
    expect(written('ListItemTombstone')).toHaveLength(0);
  });

  it('unchecks exactly the checked set, advancing both revisions', async () => {
    seedChecked(2);

    const result = await run('uncheck_all');

    expect(result.affectedCount).toBe(2);
    expect(written('ListUndo')[0]).toMatchObject({ kind: 'uncheck_all' });
    const rowUpdate = transacted().find((entry) =>
      String(entry.Update?.UpdateExpression ?? '').includes('#checked = :false'),
    )?.Update;
    expect(rowUpdate?.ConditionExpression).toContain('#itemRevision = :expected');
    expect(rowUpdate?.ConditionExpression).toContain('#checked = :true');
    expect(rowUpdate?.ExpressionAttributeValues).toMatchObject({ ':next': 1 });
    const meta = transacted().find(
      (entry) =>
        entry.Update?.Key?.sk === keys.listMeta(LIST_ID).sk &&
        String(entry.Update.UpdateExpression).includes('uncheckedCount'),
    )?.Update;
    expect(meta?.ExpressionAttributeValues).toMatchObject({ ':delta': 2 });
  });

  it('records an empty uncheck-all when nothing is checked', async () => {
    seedChecked(0);

    await expect(run('uncheck_all')).resolves.toMatchObject({ affectedCount: 0 });
    expect(written('ListUndo')[0]).toMatchObject({
      kind: 'uncheck_all',
      affectedItemIds: [],
    });
  });

  /**
   * Compensation restores what the operation changed and nothing else: an item somebody
   * checked by hand during the window is not in the set, and one deleted since is gone.
   */
  it('re-checks only the surviving members of the recorded set', async () => {
    vi.mocked(base.getItem).mockImplementation(async (key) =>
      key.sk === keys.listMeta(LIST_ID).sk ? listRow() : undefined,
    );
    const rows = [
      itemRow(item({ itemId: SURVIVOR, rank: 'a0', checked: false })),
      // Already checked again by hand — not this operation's to touch.
      itemRow(item({ itemId: MANUAL, rank: 'a1', checked: true })),
      // Never part of the operation.
      itemRow(item({ itemId: OTHER, rank: 'a2', checked: false })),
    ];
    vi.mocked(base.queryAll).mockImplementation(async (_key, options) =>
      options?.skPrefix === 'ITEM#' ? rows : [],
    );

    const rechecked = await repository.recheckListItems(
      ALICE,
      LIST_ID,
      access,
      [SURVIVOR, MANUAL, GONE],
      { operationId: 'op_bulk', now: LATER, receiptFor: () => receipt },
    );

    expect(rechecked).toBe(1);
    const updated = transacted().filter((entry) =>
      String(entry.Update?.UpdateExpression ?? '').includes('#checked = :true'),
    );
    expect(updated).toHaveLength(1);
    expect(String(updated[0]?.Update?.Key?.sk)).toContain(SURVIVOR);
    expect(
      transacted().some((entry) =>
        String(entry.Update?.UpdateExpression ?? '').includes('#consumed = :true'),
      ),
    ).toBe(true);
  });

  /** An operation whose every affected item has gone is still spent, exactly once. */
  it('spends the operation when nothing survives to re-check', async () => {
    vi.mocked(base.getItem).mockImplementation(async (key) =>
      key.sk === keys.listMeta(LIST_ID).sk ? listRow() : undefined,
    );
    vi.mocked(base.queryAll).mockResolvedValue([]);

    await expect(
      repository.recheckListItems(ALICE, LIST_ID, access, [GONE], {
        operationId: 'op_bulk',
        now: LATER,
      }),
    ).resolves.toBe(0);
    const consume = transacted().find((entry) =>
      String(entry.Update?.UpdateExpression ?? '').includes('#consumed = :true'),
    )?.Update;
    expect(consume?.ConditionExpression).toContain('#consumed = :false');
  });
});

describe('the settings inverse', () => {
  const inverseOptions = { operationId: 'op_settings', now: LATER };

  /**
   * Document paths, one flag at a time. A whole-object write would put the other switch back
   * where it was, and a whole-object condition would refuse an Undo that is still perfectly
   * applicable.
   */
  it('writes and checks capability flags through document paths', async () => {
    await repository.applyListSettingsInverse(
      ALICE,
      LIST_ID,
      access,
      { capabilities: { checkable: true } },
      { capabilities: { checkable: false } },
      { ...inverseOptions, receiptFor: () => receipt },
    );

    const update = transacted().find(
      (entry) => entry.Update?.Key?.sk === keys.listMeta(LIST_ID).sk,
    )?.Update;
    expect(update?.UpdateExpression).toContain(
      '#capabilities.#checkable = :prior_checkable',
    );
    expect(update?.ConditionExpression).toContain(
      '#capabilities.#checkable = :expected_checkable',
    );
    expect(update?.ExpressionAttributeValues).toMatchObject({
      ':prior_checkable': true,
      ':expected_checkable': false,
    });
    // The gate aliases the shared condition names must be declared with the rest.
    expect(update?.ExpressionAttributeNames).toMatchObject({
      '#rankRepairId': 'rankRepairId',
      '#behaviourMigrationId': 'behaviourMigrationId',
    });
  });

  /**
   * A slot inverse restores the exact default the forward change removed, and only while the
   * slot is still empty — one transaction, so a newer choice makes the **whole** inverse no
   * longer applicable rather than being overwritten.
   */
  it('restores the removed profile default in the same transaction', async () => {
    await repository.applyListSettingsInverse(
      ALICE,
      LIST_ID,
      access,
      {
        slot: 'groceries',
        removedDefault: { slot: 'groceries', listId: LIST_ID },
      },
      { slot: null, defaultSlotAbsent: 'groceries' },
      inverseOptions,
    );

    const profile = transacted().find(
      (entry) => entry.Update?.Key?.pk === keys.userProfile(ALICE).pk,
    )?.Update;
    expect(profile?.UpdateExpression).toBe('SET #defaultLists.#slot = :listId');
    expect(profile?.ConditionExpression).toContain(
      'attribute_not_exists(#defaultLists.#slot)',
    );
    expect(profile?.ExpressionAttributeValues).toMatchObject({ ':listId': LIST_ID });
  });

  it.each([
    ['the settings condition', 1],
    ['the profile default', 2],
    ['the single-use guard', 3],
  ])('maps a failed %s to a not-applicable inverse', async (_case, index) => {
    vi.mocked(tx.transactWrite).mockImplementationOnce(async (_items, options) => {
      throw options.onConditionFailed?.(index);
    });

    await expect(
      repository.applyListSettingsInverse(
        ALICE,
        LIST_ID,
        access,
        { archived: false, removedDefault: { slot: 'meals', listId: LIST_ID } },
        { archived: true },
        inverseOptions,
      ),
    ).rejects.toBeInstanceOf(repository.ListUndoNotApplicableError);
  });

  it('reads one retained operation, and refuses one belonging to another list', async () => {
    vi.mocked(base.getItem).mockResolvedValueOnce({
      ...keys.listUndo(LIST_ID, 'op_settings'),
      entity: 'ListUndo',
      listId: LIST_ID,
      operationId: 'op_settings',
      kind: 'settings',
      tokenHash: 'hash',
      undoExpiresAt: LATER,
      consumed: false,
      ttl: 1,
    });
    await expect(
      repository.getListUndoOperation(ALICE, LIST_ID, access, 'op_settings'),
    ).resolves.toMatchObject({ kind: 'settings', consumed: false });

    vi.mocked(base.getItem).mockResolvedValueOnce(undefined);
    await expect(
      repository.getListUndoOperation(ALICE, LIST_ID, access, 'op_missing'),
    ).resolves.toBeUndefined();
  });
});

describe('identity and list storage', () => {
  it('mints schema-shaped monotonic ids outside writes', () => {
    expect(repository.newListId()).toMatch(/^lst_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(repository.newItemId()).toMatch(/^itm_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(repository.newListOperationId()).toMatch(/^op_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('creates META, tombstone check, pointer, source projection, guards and receipt', async () => {
    const sourceActivityId = 'act_01J8XKQ2M4N5P6R7S8T9V0W1AA';
    await repository.createList(ALICE, list({ sourceActivityId }), {
      now: NOW,
      idempotencyReceipt: receipt,
    });

    const [items] = vi.mocked(tx.transactWrite).mock.calls[0] ?? [];
    expect(items).toHaveLength(7);
    expect(items?.[0]?.Put?.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(items?.[1]?.ConditionCheck?.Key).toEqual(keys.listTombstone(LIST_ID));
    expect(items?.[2]?.Put?.Item).toMatchObject({ role: 'owner', addedAt: NOW });
    expect(items?.[3]?.Put?.Item).toMatchObject({ listId: LIST_ID });
    // P3-05: the transaction re-asserts the source Plan at commit time — still the
    // caller's, still a Plan, and not mid-deletion — so the service's pre-read going
    // stale cannot leave a projection under a deleted or converted Activity.
    expect(items?.[4]?.ConditionCheck?.Key).toEqual(keys.activityMeta(sourceActivityId));
    expect(items?.[4]?.ConditionCheck?.ExpressionAttributeValues).toMatchObject({
      ':sourceOwner': ALICE,
      ':plan': 'plan',
    });
    expect(items?.[5]?.ConditionCheck?.Key).toEqual(
      keys.activityTombstone(sourceActivityId),
    );
    expect(items?.[5]?.ConditionCheck?.ConditionExpression).toBe(
      'attribute_not_exists(pk)',
    );
  });

  it('maps both canonical collision indexes to one list-id error', async () => {
    vi.mocked(tx.transactWrite).mockImplementation(async (_items, options) => {
      throw options.onConditionFailed?.(1);
    });

    await expect(
      repository.createList(ALICE, list(), { now: NOW }),
    ).rejects.toBeInstanceOf(repository.ListIdUnavailableError);
  });

  it('reads pointers and META strongly, including absence', async () => {
    vi.mocked(base.getItem)
      .mockResolvedValueOnce(indexRow())
      .mockResolvedValueOnce(listRow())
      .mockResolvedValueOnce(undefined);

    await expect(repository.getListPointer(ALICE, LIST_ID)).resolves.toMatchObject({
      role: 'owner',
    });
    await expect(repository.getListMeta(ALICE, LIST_ID, access)).resolves.toMatchObject({
      title: 'Errands',
    });
    await expect(repository.getListPointer(ALICE, LIST_ID)).resolves.toBeUndefined();
    expect(
      vi.mocked(base.getItem).mock.calls.every(([, options]) => options?.consistentRead),
    ).toBe(true);
  });

  it('rejects a caller/list mismatch before any canonical read or mutation', async () => {
    const ben = 'usr_list_unit_ben';

    await expect(repository.getListMeta(ben, LIST_ID, access)).rejects.toBeInstanceOf(
      repository.ListNotFoundError,
    );
    await expect(
      repository.patchListMeta(ben, LIST_ID, access, { title: 'Stolen' }, NOW, LATER),
    ).rejects.toBeInstanceOf(repository.ListNotFoundError);
    await expect(
      repository.deleteList(ben, LIST_ID, access, {
        now: LATER,
        expectedUpdatedAt: NOW,
      }),
    ).rejects.toBeInstanceOf(repository.ListNotFoundError);

    expect(base.getItem).not.toHaveBeenCalled();
    expect(tx.transactWrite).not.toHaveBeenCalled();
  });

  it('rejects a structurally forged pointer result', async () => {
    const forged = {
      listId: LIST_ID,
      userId: ALICE,
      role: 'owner',
      addedAt: NOW,
    } as never;

    await expect(repository.getListMeta(ALICE, LIST_ID, forged)).rejects.toBeInstanceOf(
      repository.ListNotFoundError,
    );
    expect(base.getItem).not.toHaveBeenCalled();
  });

  it('hydrates a pointer page in pointer order and carries its cursor', async () => {
    const secondId = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X3';
    const nextCursor = encodeCursor(keys.listPointer(ALICE, secondId));
    if (nextCursor === undefined)
      throw new Error('Pointer fixture did not mint a cursor.');
    vi.mocked(base.query).mockResolvedValue({
      items: [indexRow(), indexRow({ listId: secondId })],
      nextCursor,
    });
    vi.mocked(base.batchGetItems).mockResolvedValue([
      { ...listRow({ listId: secondId, title: 'Second' }), ...keys.listMeta(secondId) },
      listRow(),
    ]);

    const page = await repository.listListsForUser(ALICE, 'incoming');

    expect(page.items.map(({ list: value }) => value.listId)).toEqual([
      LIST_ID,
      secondId,
    ]);
    expect(page.nextCursor).toBe(nextCursor);
    expect(vi.mocked(base.query).mock.calls[0]?.[1]).toMatchObject({
      limit: 50,
      cursor: 'incoming',
    });
  });

  it('counts only owner pointers', async () => {
    vi.mocked(base.queryCount).mockResolvedValue(7);
    await expect(repository.countOwnedLists(ALICE)).resolves.toBe(7);
    expect(vi.mocked(base.queryCount).mock.calls[0]?.[1]).toMatchObject({
      filterEquals: { attribute: 'role', value: 'owner' },
    });
  });

  it('patches every supplied META field under the ETag and both gates', async () => {
    mockLiveList(
      list({
        title: 'New',
        capabilities: { checkable: false, supportsLocation: true },
        slot: 'groceries',
        archived: true,
        updatedAt: LATER,
      }),
    );
    await repository.patchListMeta(
      ALICE,
      LIST_ID,
      access,
      {
        title: 'New',
        capabilities: { checkable: false, supportsLocation: true },
        slot: 'groceries',
        archived: true,
      },
      NOW,
      LATER,
    );

    const [writes] = vi.mocked(tx.transactWrite).mock.calls[0] ?? [];
    expect(writes?.[0]?.ConditionCheck?.Key).toEqual(keys.listTombstone(LIST_ID));
    expect(writes?.[1]?.Update).toMatchObject({
      ConditionExpression: expect.stringContaining('#updatedAt = :expectedUpdatedAt'),
      UpdateExpression: expect.stringContaining('#archived = :archived'),
    });
  });
});

describe('fenced reads', () => {
  it('returns a strongly read item page, ids and version-bound cursor', async () => {
    const rawNext = encodeCursor(keys.listItem(LIST_ID, 'V', ITEM_A));
    if (rawNext === undefined) throw new Error('Item fixture did not mint a cursor.');
    mockLiveList(list({ rankVersion: 4 }));
    vi.mocked(base.query).mockResolvedValue({
      items: [itemRow()],
      nextCursor: rawNext,
    });

    const page = await repository.listItems(ALICE, LIST_ID, access);

    expect(page?.items).toEqual([item()]);
    expect(page?.itemIds).toEqual([ITEM_A]);
    expect(page?.nextCursor).toBe(
      encodeFencedCursor(keys.listItem(LIST_ID, 'V', ITEM_A), 4),
    );
    expect(vi.mocked(base.query).mock.calls[0]?.[1]).toMatchObject({
      consistentRead: true,
      limit: 50,
    });
  });

  it('returns absence before querying and rejects either opening gate', async () => {
    vi.mocked(base.getItem).mockResolvedValueOnce(undefined);
    await expect(repository.listItems(ALICE, LIST_ID, access)).resolves.toBeUndefined();
    expect(base.query).not.toHaveBeenCalled();

    vi.mocked(base.getItem).mockResolvedValueOnce(listRow({ rankRepairId: 'repair' }));
    await expect(repository.listItems(ALICE, LIST_ID, access)).rejects.toBeInstanceOf(
      repository.ListReadFenceError,
    );
  });

  it('rejects a stale cursor and a changed or gated closing fence', async () => {
    mockLiveList(list({ rankVersion: 2 }));
    await expect(
      repository.listItems(
        ALICE,
        LIST_ID,
        access,
        encodeFencedCursor(keys.listItem(LIST_ID, 'V', ITEM_A), 1),
      ),
    ).rejects.toBeInstanceOf(repository.ListReadFenceError);

    vi.mocked(base.getItem)
      .mockReset()
      .mockResolvedValueOnce(listRow({ rankVersion: 2 }))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(listRow({ rankVersion: 3 }))
      .mockResolvedValueOnce(undefined);
    await expect(repository.listItems(ALICE, LIST_ID, access)).rejects.toBeInstanceOf(
      repository.ListReadFenceError,
    );

    vi.mocked(base.getItem)
      .mockReset()
      .mockResolvedValueOnce(listRow({ rankVersion: 2 }))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(
        listRow({ rankVersion: 2, behaviourMigrationId: 'migration' }),
      )
      .mockResolvedValueOnce(undefined);
    await expect(repository.listItems(ALICE, LIST_ID, access)).rejects.toBeInstanceOf(
      repository.ListReadFenceError,
    );
  });

  it('returns caller links in requested order and drops misses', async () => {
    const link = (itemId: string, viewerUserId = ALICE): ListItemActivityLink => ({
      listId: LIST_ID,
      itemId,
      viewerUserId,
      activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1AA',
      linkedAt: NOW,
    });
    vi.mocked(base.batchGetItems).mockResolvedValue([
      {
        ...keys.listItemActivityLink(LIST_ID, ALICE, ITEM_B),
        entity: 'ListItemActivityLink',
        schemaVersion: 1,
        ...link(ITEM_B),
      },
    ]);
    mockLiveList();

    await expect(
      repository.batchGetViewerLinks(ALICE, LIST_ID, access, [ITEM_A, ITEM_B, ITEM_A]),
    ).resolves.toEqual([link(ITEM_B)]);
  });

  it('follows a locator for an exact read and detects revision disagreement', async () => {
    mockResolvedItem();
    await expect(repository.getListItem(ALICE, LIST_ID, access, ITEM_A)).resolves.toEqual(
      item(),
    );

    vi.mocked(base.getItem).mockReset();
    vi.mocked(base.getItem)
      .mockResolvedValueOnce(listRow())
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(locatorRow(item({ itemRevision: 1 })))
      .mockResolvedValueOnce(itemRow());
    await expect(
      repository.getListItem(ALICE, LIST_ID, access, ITEM_A),
    ).rejects.toBeInstanceOf(repository.ListReadFenceError);
  });
});

describe('rank allocation and item mutations', () => {
  it('creates one item and an ordered bulk chunk under one META advance', async () => {
    mockLiveList();
    const one = await repository.createListItem(
      ALICE,
      LIST_ID,
      access,
      { itemId: ITEM_A, title: 'One', checked: false },
      { now: NOW },
    );
    expect(one).toMatchObject({ rank: 'V', itemRevision: 0 });

    const bulk = await repository.createListItems(
      ALICE,
      LIST_ID,
      access,
      [
        { itemId: ITEM_A, title: 'One', checked: false },
        { itemId: ITEM_B, title: 'Two', checked: true },
      ],
      // The receipt is built from the created items, so the stored response carries the
      // ranks this call allocated rather than a placeholder (P3-08).
      { now: NOW, receiptFor: () => receipt },
    );
    expect(bulk.map((value) => value.rank)).toEqual(['V', 'W']);
    const [items] = vi.mocked(tx.transactWrite).mock.calls.at(-1) ?? [];
    expect(items).toHaveLength(9);
    expect(items?.[0]?.ConditionCheck?.Key).toEqual(keys.listTombstone(LIST_ID));
    expect(items?.[7]?.Update?.ExpressionAttributeValues).toMatchObject({
      ':count': 2,
      ':unchecked': 1,
    });
    await expect(
      repository.createListItems(ALICE, LIST_ID, access, [], { now: NOW }),
    ).resolves.toEqual([]);
  });

  it('maps stable-id collision and retries a rankVersion conflict', async () => {
    mockLiveList();
    vi.mocked(tx.transactWrite).mockImplementationOnce(async (_items, options) => {
      throw options.onConditionFailed?.(1);
    });
    await expect(
      repository.createListItem(
        ALICE,
        LIST_ID,
        access,
        { itemId: ITEM_A, title: 'Collision', checked: false },
        { now: NOW },
      ),
    ).rejects.toBeInstanceOf(repository.ListItemIdUnavailableError);

    vi.mocked(tx.transactWrite)
      .mockReset()
      .mockImplementationOnce(async (_items, options) => {
        throw options.onConditionFailed?.(4);
      })
      .mockResolvedValueOnce(undefined);
    await repository.createListItem(
      ALICE,
      LIST_ID,
      access,
      { itemId: ITEM_B, title: 'Retry', checked: false },
      { now: NOW },
    );
    expect(tx.transactWrite).toHaveBeenCalledTimes(2);
  });

  it('returns repair-required for equal bounds and exhausted rank space', async () => {
    mockLiveList();
    const equalA = item({ itemId: ITEM_A, rank: 'V' });
    const equalB = item({ itemId: ITEM_B, rank: 'V' });
    vi.mocked(base.query).mockResolvedValue({
      items: [itemRow(equalA), itemRow(equalB)],
    });
    await expect(
      repository.createListItem(
        ALICE,
        LIST_ID,
        access,
        { itemId: repository.newItemId(), title: 'Equal', checked: false },
        { now: NOW, afterItemId: null },
      ),
    ).rejects.toBeInstanceOf(repository.ListRankRepairRequiredError);

    const terminal = item({ rank: 'z'.repeat(MAX_LEXO_RANK_LENGTH) });
    vi.mocked(base.query).mockResolvedValue({ items: [itemRow(terminal)] });
    await expect(
      repository.createListItem(
        ALICE,
        LIST_ID,
        access,
        { itemId: repository.newItemId(), title: 'Overflow', checked: false },
        { now: NOW },
      ),
    ).rejects.toBeInstanceOf(repository.ListRankRepairRequiredError);
  });

  it('reorders with four actions and preserves a freshly read row', async () => {
    const current = item({ rank: 'W', note: 'Keep me' });
    mockResolvedItem(current, list({ rankVersion: 8 }));
    vi.mocked(base.query).mockResolvedValue({
      items: [itemRow(item({ itemId: ITEM_B, rank: 'V' }))],
    });

    const moved = await repository.reorderListItem(ALICE, LIST_ID, access, ITEM_A, {
      now: LATER,
      afterItemId: null,
      idempotencyReceipt: receipt,
    });

    expect(moved).toMatchObject({ rank: 'U', itemRevision: 1, note: 'Keep me' });
    const [items] = vi.mocked(tx.transactWrite).mock.calls[0] ?? [];
    expect(items).toHaveLength(6);
    expect(items?.[0]?.ConditionCheck?.Key).toEqual(keys.listTombstone(LIST_ID));
    expect(items?.slice(1, 5).map((entry) => Object.keys(entry)[0])).toEqual([
      'Delete',
      'Put',
      'Update',
      'Update',
    ]);
  });

  it('returns a reorder no-op without writing', async () => {
    mockResolvedItem();
    vi.mocked(base.query).mockResolvedValue({ items: [itemRow()] });
    await expect(
      repository.reorderListItem(ALICE, LIST_ID, access, ITEM_A, {
        now: LATER,
        afterItemId: null,
      }),
    ).resolves.toEqual(item());
    expect(tx.transactWrite).not.toHaveBeenCalled();
  });

  it('patches supplied fields, removes nullable fields and moves checked counters', async () => {
    const current = item({
      note: 'Remove',
      location: { label: 'Shop' },
      details: { behaviour: 'watch', watchStatus: 'want' },
    });
    mockResolvedItem(current);
    const patched = await repository.patchListItemFields(
      ALICE,
      LIST_ID,
      access,
      ITEM_A,
      { title: 'Oat milk', checked: true, note: null, location: null, details: null },
      LATER,
    );

    expect(patched).toEqual({
      ...item(),
      title: 'Oat milk',
      checked: true,
      itemRevision: 1,
    });
    const [items] = vi.mocked(tx.transactWrite).mock.calls[0] ?? [];
    expect(items?.[0]?.ConditionCheck?.Key).toEqual(keys.listTombstone(LIST_ID));
    expect(items?.[1]?.Update?.UpdateExpression).toContain('REMOVE');
    expect(items?.[3]?.Update?.ExpressionAttributeValues).toEqual({ ':delta': -1 });
  });

  it('uses a gate condition-check when a field patch does not change checked', async () => {
    mockResolvedItem();
    await repository.patchListItemFields(
      ALICE,
      LIST_ID,
      access,
      ITEM_A,
      { note: 'Keep' },
      LATER,
    );
    const [items] = vi.mocked(tx.transactWrite).mock.calls[0] ?? [];
    expect(items?.[3]?.ConditionCheck).toBeDefined();
  });
});

describe('delete, restore and cascade', () => {
  it('deletes an item with its snapshot, Undo record, counters and receipt', async () => {
    mockResolvedItem();
    const removed = await repository.deleteListItem(ALICE, LIST_ID, access, ITEM_A, {
      operationId: 'op_delete',
      tokenHash: 'hash',
      undoExpiresAt: LATER,
      now: NOW,
      idempotencyReceipt: receipt,
    });

    expect(removed).toEqual(item());
    const [items] = vi.mocked(tx.transactWrite).mock.calls[0] ?? [];
    expect(items).toHaveLength(8);
    expect(items?.[0]?.ConditionCheck?.Key).toEqual(keys.listTombstone(LIST_ID));
    expect(items?.[3]?.ConditionCheck).toMatchObject({
      Key: keys.listItemActivityLink(LIST_ID, ALICE, ITEM_A),
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(items?.[4]?.Put?.Item).toMatchObject({
      operationId: 'op_delete',
      snapshot: item(),
      viewerLinks: [],
      activityProvenance: [],
    });
    expect(items?.[5]?.Put?.Item).toMatchObject({
      kind: 'delete_item',
      affectedItemIds: [ITEM_A],
      consumed: false,
    });
    expect(items?.[6]?.Update?.ExpressionAttributeValues).toMatchObject({
      ':minusOne': -1,
      ':uncheckedDelta': -1,
    });
  });

  it('snapshots and clears the current viewer link and matching Activity provenance', async () => {
    mockResolvedItem();
    vi.mocked(base.batchGetItems)
      .mockResolvedValueOnce([viewerLinkRow()])
      .mockResolvedValueOnce([
        activityRow(activity({ listId: LIST_ID, listItemId: ITEM_A })),
      ]);

    await repository.deleteListItem(ALICE, LIST_ID, access, ITEM_A, {
      operationId: 'op_linked_delete',
      tokenHash: 'hash',
      undoExpiresAt: LATER,
      now: NOW,
    });

    const [items] = vi.mocked(tx.transactWrite).mock.calls[0] ?? [];
    expect(items).toHaveLength(8);
    expect(items?.[3]?.Delete).toMatchObject({
      Key: keys.listItemActivityLink(LIST_ID, ALICE, ITEM_A),
      ConditionExpression: '#activityId = :activityId',
    });
    expect(items?.[4]?.Update).toMatchObject({
      Key: keys.activityMeta(ACTIVITY_ID),
      UpdateExpression: 'REMOVE #listId, #listItemId',
    });
    expect(items?.[5]?.Put?.Item).toMatchObject({
      snapshot: item(),
      viewerLinks: [viewerLink()],
      activityProvenance: [
        { activityId: ACTIVITY_ID, listId: LIST_ID, listItemId: ITEM_A },
      ],
    });
    expect(
      vi
        .mocked(base.batchGetItems)
        .mock.calls.every(([, options]) => options?.consistentRead),
    ).toBe(true);
  });

  it('rejects invalid deletion time before sending a transaction', async () => {
    mockResolvedItem();
    await expect(
      repository.deleteListItem(ALICE, LIST_ID, access, ITEM_A, {
        operationId: 'op_delete',
        tokenHash: 'hash',
        undoExpiresAt: LATER,
        now: 'not-a-time',
      }),
    ).rejects.toThrow('invalid now');
    expect(tx.transactWrite).not.toHaveBeenCalled();
  });

  /**
   * P3-10 generalised the restore to a set, because one `clear-checked` is one operation
   * across several transactions. One id is that set with one member, so the write it builds
   * is unchanged — and the tombstone it reads now arrives through the batched read the
   * multi-item form needs.
   */
  it('restores the exact snapshot only for its matching operation', async () => {
    const snapshot = item({ checked: true });
    const tombstone = {
      ...keys.listItemTombstone(LIST_ID, ITEM_A),
      entity: 'ListItemTombstone',
      schemaVersion: 1,
      listId: LIST_ID,
      itemId: ITEM_A,
      operationId: 'op_delete',
      snapshot,
    };
    vi.mocked(base.getItem).mockImplementation(async (key) =>
      key.sk === keys.listMeta(LIST_ID).sk ? listRow({ rankVersion: 3 }) : undefined,
    );
    vi.mocked(base.batchGetItems).mockResolvedValue([tombstone]);

    await expect(
      repository.restoreListItem(ALICE, LIST_ID, access, ITEM_A, {
        operationId: 'op_other',
        now: LATER,
      }),
    ).rejects.toBeInstanceOf(repository.ListUndoNotApplicableError);

    vi.mocked(base.batchGetItems)
      .mockReset()
      .mockResolvedValueOnce([tombstone])
      .mockResolvedValue([]);
    const restored = await repository.restoreListItem(ALICE, LIST_ID, access, ITEM_A, {
      operationId: 'op_delete',
      now: LATER,
      receiptFor: () => receipt,
    });
    expect(restored).toEqual(snapshot);
    const [items] = vi.mocked(tx.transactWrite).mock.calls[0] ?? [];
    expect(items).toHaveLength(7);
    expect(items?.[0]?.ConditionCheck?.Key).toEqual(keys.listTombstone(LIST_ID));
    expect(items?.[3]?.Delete?.ConditionExpression).toContain('#operationId');
    expect(items?.[5]?.Update?.ExpressionAttributeValues).toMatchObject({
      ':expectedVersion': 3,
      ':nextVersion': 4,
    });
  });

  it('restores a still-live viewer link and its cleared Activity provenance', async () => {
    const tombstone = {
      ...keys.listItemTombstone(LIST_ID, ITEM_A),
      entity: 'ListItemTombstone',
      schemaVersion: 1,
      listId: LIST_ID,
      itemId: ITEM_A,
      operationId: 'op_linked_delete',
      snapshot: item(),
      viewerLinks: [viewerLink()],
      activityProvenance: [
        { activityId: ACTIVITY_ID, listId: LIST_ID, listItemId: ITEM_A },
      ],
    };
    vi.mocked(base.getItem).mockImplementation(async (key) =>
      key.sk === keys.listMeta(LIST_ID).sk ? listRow({ rankVersion: 3 }) : undefined,
    );
    vi.mocked(base.batchGetItems)
      // The tombstones, then the current link rows, then the linked Activities.
      .mockResolvedValueOnce([tombstone])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([activityRow()]);

    await repository.restoreListItem(ALICE, LIST_ID, access, ITEM_A, {
      operationId: 'op_linked_delete',
      now: LATER,
    });

    const [items] = vi.mocked(tx.transactWrite).mock.calls[0] ?? [];
    expect(items).toHaveLength(8);
    expect(items?.[3]?.Put?.Item).toMatchObject(viewerLink());
    expect(items?.[4]?.Update).toMatchObject({
      Key: keys.activityMeta(ACTIVITY_ID),
      UpdateExpression: 'SET #listId = :listId, #listItemId = :listItemId',
    });
    expect(items?.[5]?.Delete?.Key).toEqual(keys.listItemTombstone(LIST_ID, ITEM_A));
    expect(items?.[7]?.Update?.ExpressionAttributeValues).toMatchObject({
      ':expectedVersion': 3,
      ':nextVersion': 4,
    });
  });

  it('rejects a missing tombstone and maps a failed restore precondition', async () => {
    vi.mocked(base.getItem)
      .mockResolvedValueOnce(listRow())
      .mockResolvedValueOnce(undefined);
    vi.mocked(base.batchGetItems).mockResolvedValue([]);
    await expect(
      repository.restoreListItem(ALICE, LIST_ID, access, ITEM_A, {
        operationId: 'op_delete',
        now: LATER,
      }),
    ).rejects.toBeInstanceOf(repository.ListUndoNotApplicableError);
    // Nothing is spent by a restore that found nothing to restore.
    expect(tx.transactWrite).not.toHaveBeenCalled();

    const snapshot = item();
    vi.mocked(base.getItem)
      .mockReset()
      .mockResolvedValueOnce(listRow())
      .mockResolvedValueOnce(undefined);
    vi.mocked(base.batchGetItems)
      .mockReset()
      .mockResolvedValueOnce([
        {
          ...keys.listItemTombstone(LIST_ID, ITEM_A),
          listId: LIST_ID,
          itemId: ITEM_A,
          operationId: 'op_delete',
          snapshot,
          schemaVersion: 1,
        },
      ])
      .mockResolvedValue([]);
    vi.mocked(tx.transactWrite).mockImplementationOnce(async (_items, options) => {
      throw options.onConditionFailed?.(1);
    });
    await expect(
      repository.restoreListItem(ALICE, LIST_ID, access, ITEM_A, {
        operationId: 'op_delete',
        now: LATER,
      }),
    ).rejects.toBeInstanceOf(repository.ListUndoNotApplicableError);
  });

  it('cascades children between tombstone installation and final pointer/META removal', async () => {
    const child = itemRow();
    vi.mocked(base.queryAll).mockResolvedValue([
      listRow(),
      child,
      { ...keys.listTombstone(LIST_ID), schemaVersion: 1 },
    ]);

    await repository.deleteList(ALICE, LIST_ID, access, {
      now: LATER,
      expectedUpdatedAt: NOW,
      sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1AA',
    });

    expect(tx.transactWrite).toHaveBeenCalledTimes(2);
    const [begin] = vi.mocked(tx.transactWrite).mock.calls[0] ?? [];
    expect(begin).toHaveLength(3);
    expect(begin?.[1]?.Put?.Item).toMatchObject({ listId: LIST_ID, ownerId: ALICE });
    expect(base.deleteAll).toHaveBeenCalledWith([
      keys.listItem(LIST_ID, item().rank, ITEM_A),
    ]);
    const [finish] = vi.mocked(tx.transactWrite).mock.calls[1] ?? [];
    expect(finish?.map((entry) => entry.Delete?.Key)).toEqual([
      keys.listPointer(ALICE, LIST_ID),
      keys.listMeta(LIST_ID),
    ]);
  });
});
