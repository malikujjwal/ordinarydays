import type { List, ListItem } from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../lib/errors.js';

/**
 * The item service's own rules, with the repository mocked
 * (`definition-of-done.md` §3: every business rule and every authorisation decision).
 *
 * The storage behaviour these orchestrate — ranks, fences, transactions — belongs to
 * `listRepository` and is proved against DynamoDB Local. What is proved here is the
 * decisions: the caps, the two-part gates, the repair-once retry, and the error mapping that
 * turns the repository's untyped signals into contract responses.
 */

class RepairNeeded extends Error {
  constructor() {
    super('repair');
    this.name = 'ListRankRepairRequiredError';
  }
}
class ItemMissing extends Error {
  constructor() {
    super('missing');
    this.name = 'ListItemNotFoundError';
  }
}
class IdTaken extends Error {
  constructor() {
    super('taken');
    this.name = 'ListItemIdUnavailableError';
  }
}
class RetriesExhausted extends Error {
  constructor() {
    super('busy');
    this.name = 'ListMutationRetryExhaustedError';
  }
}
class ListFull extends Error {
  constructor() {
    super('full');
    this.name = 'ListFullError';
  }
}

vi.mock('../repositories/listRepository.js', () => ({
  ListRankRepairRequiredError: RepairNeeded,
  ListItemNotFoundError: ItemMissing,
  ListItemIdUnavailableError: IdTaken,
  ListMutationRetryExhaustedError: RetriesExhausted,
  ListFullError: ListFull,
  ListNotFoundError: class extends Error {},
  ListReadFenceError: class extends Error {},
  newItemId: vi.fn(() => 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X9'),
  newListOperationId: vi.fn(() => 'op_01J8XKQ2M4N5P6R7S8T9V0W1X9'),
  getListMeta: vi.fn(),
  createListItems: vi.fn(),
  patchListItemFields: vi.fn(),
  reorderListItem: vi.fn(),
  deleteListItem: vi.fn(),
  getListItem: vi.fn(),
  listItems: vi.fn(),
  batchGetViewerLinks: vi.fn(() => Promise.resolve([])),
  deleteStaleViewerLink: vi.fn(() => Promise.resolve()),
  resolveExistingItems: vi.fn(() => Promise.resolve(new Map<string, unknown>())),
}));

vi.mock('../repositories/activityRepository.js', () => ({
  getActivityPartitionStrong: vi.fn(() => Promise.resolve([])),
}));

vi.mock('./authz.js', () => ({
  assertListAccess: vi.fn(() => Promise.resolve({ index: {}, isOwner: true })),
  assertActivityAccess: vi.fn(() => Promise.resolve({})),
  assertActivityReadAccessFromPartition: vi.fn(() => Promise.resolve({})),
  readableActivities: vi.fn(() => Promise.resolve(new Map())),
}));

vi.mock('./listRankRepairService.js', () => ({
  repairListRanks: vi.fn(() => Promise.resolve(true)),
  withRepairDrain: vi.fn((_u: string, _l: string, _a: unknown, read: () => unknown) =>
    read(),
  ),
}));

vi.mock('../repositories/idempotencyRepository.js', () => ({
  writeReceiptOnly: vi.fn(() => Promise.resolve()),
}));

const repository = await import('../repositories/listRepository.js');
const activityRepository = await import('../repositories/activityRepository.js');
const authz = await import('./authz.js');
const repairService = await import('./listRankRepairService.js');
const service = await import('./listItemService.js');

const USER = 'usr_local_dev';
const LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ITEM = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const NOW = '2026-08-24T09:00:00.000Z';

const aList = (overrides: Partial<List> = {}): List => ({
  listId: LIST,
  ownerId: USER,
  behaviour: 'collection',
  templateKey: 'checklist',
  title: 'Errands',
  icon: 'check-square',
  emptyStateCopy: 'Add something.',
  capabilities: { checkable: true, supportsLocation: true },
  slot: null,
  itemCount: 0,
  uncheckedCount: 0,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: NOW,
  ...overrides,
});

const anItem = (overrides: Partial<ListItem> = {}): ListItem => ({
  itemId: ITEM,
  listId: LIST,
  rank: 'V',
  itemRevision: 0,
  title: 'Eggs',
  checked: false,
  ...overrides,
});

const useList = (list: List = aList()) => {
  vi.mocked(repository.getListMeta).mockResolvedValue(list);
};

beforeEach(() => {
  vi.clearAllMocks();
  useList();
  vi.mocked(repository.createListItems).mockResolvedValue([anItem()]);
  vi.mocked(repository.patchListItemFields).mockResolvedValue(anItem());
  vi.mocked(repository.reorderListItem).mockResolvedValue(anItem({ rank: 'W' }));
  vi.mocked(repository.deleteListItem).mockResolvedValue(anItem());
  vi.mocked(repository.resolveExistingItems).mockResolvedValue(new Map());
  vi.mocked(repairService.repairListRanks).mockResolvedValue(true);
});

describe('the item cap', () => {
  it('refuses the 501st with exactly "List is full." and writes nothing', async () => {
    useList(aList({ itemCount: 500 }));

    await expect(
      service.createItem(USER, LIST, { title: 'One more' }, NOW),
    ).rejects.toMatchObject({ code: 'validation_failed', message: 'List is full.' });
    expect(repository.createListItems).not.toHaveBeenCalled();
  });

  it('counts the whole batch, not one item at a time', async () => {
    useList(aList({ itemCount: 499 }));

    await expect(
      service.createItemsBulk(
        USER,
        LIST,
        { items: [{ title: 'One' }, { title: 'Two' }] },
        NOW,
      ),
    ).rejects.toMatchObject({ message: 'List is full.' });
  });

  it('allows the batch that exactly reaches the cap', async () => {
    useList(aList({ itemCount: 499 }));

    await expect(
      service.createItemsBulk(USER, LIST, { items: [{ title: 'Last' }] }, NOW),
    ).resolves.toBeDefined();
  });
});

describe('the two-part gates', () => {
  it.each([
    [
      'a collection with the flag off',
      aList({ capabilities: { checkable: false, supportsLocation: true } }),
    ],
    ['a watch list whose stored flag is true', aList({ behaviour: 'watch' })],
    ['a meals list whose stored flag is true', aList({ behaviour: 'meals' })],
  ])('refuses checked on %s', async (_case, list) => {
    useList(list);

    await expect(
      service.patchItem(USER, LIST, ITEM, { checked: true }, NOW),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(repository.patchListItemFields).not.toHaveBeenCalled();
  });

  it('accepts checked on a collection whose flag is on', async () => {
    useList(aList({ capabilities: { checkable: true, supportsLocation: false } }));

    await expect(
      service.patchItem(USER, LIST, ITEM, { checked: true }, NOW),
    ).resolves.toBeDefined();
  });

  it.each([
    [
      'a collection with the flag off',
      aList({ capabilities: { checkable: true, supportsLocation: false } }),
    ],
    ['a watch list whose stored flag is true', aList({ behaviour: 'watch' })],
  ])('refuses a location on %s', async (_case, list) => {
    useList(list);

    await expect(
      service.createItem(
        USER,
        LIST,
        { title: 'Zahav', location: { label: 'Zahav' } },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  /**
   * A `collection` has no `details` arm, so the shared discriminant rule catches this first
   * and names `details.behaviour` — a better error than the service's own fallback, which
   * exists for the case the schema cannot see. Either way nothing is written.
   */
  it('refuses details on a collection, which has no details shape at all', async () => {
    useList();

    await expect(
      service.createItem(
        USER,
        LIST,
        { title: 'Severance', details: { behaviour: 'watch', watchStatus: 'want' } },
        NOW,
      ),
    ).rejects.toBeDefined();
    expect(repository.createListItems).not.toHaveBeenCalled();
  });

  it('refuses details whose discriminant does not match the behaviour', async () => {
    useList(aList({ behaviour: 'watch' }));

    await expect(
      service.createItem(
        USER,
        LIST,
        { title: 'Tacos', details: { behaviour: 'meals' } },
        NOW,
      ),
    ).rejects.toBeDefined();
  });
});

describe('the repair-once retry', () => {
  it('repairs and retries when allocation cannot subdivide the gap', async () => {
    vi.mocked(repository.createListItems)
      .mockRejectedValueOnce(new RepairNeeded())
      .mockResolvedValueOnce([anItem()]);

    const item = await service.createItem(USER, LIST, { title: 'Eggs' }, NOW);

    expect(item.itemId).toBe(ITEM);
    expect(repairService.repairListRanks).toHaveBeenCalledTimes(1);
    expect(repository.createListItems).toHaveBeenCalledTimes(2);
  });

  /** A repair that has not finished is a `503`, not a second repair stacked on the first. */
  it('gives up with a retryable error when the bounded repair is incomplete', async () => {
    vi.mocked(repository.createListItems).mockRejectedValueOnce(new RepairNeeded());
    vi.mocked(repairService.repairListRanks).mockResolvedValueOnce(false);

    await expect(
      service.createItem(USER, LIST, { title: 'Eggs' }, NOW),
    ).rejects.toMatchObject({ code: 'internal', retryAfterSeconds: 1 });
    expect(repository.createListItems).toHaveBeenCalledTimes(1);
  });

  it('repairs on the reorder path too', async () => {
    vi.mocked(repository.reorderListItem)
      .mockRejectedValueOnce(new RepairNeeded())
      .mockResolvedValueOnce(anItem({ rank: 'W' }));

    await service.patchItem(USER, LIST, ITEM, { afterItemId: null }, NOW);

    expect(repairService.repairListRanks).toHaveBeenCalledTimes(1);
    expect(repository.reorderListItem).toHaveBeenCalledTimes(2);
  });
});

describe('patch routing', () => {
  it('reorders when afterItemId is present, and touches no field', async () => {
    await service.patchItem(USER, LIST, ITEM, { afterItemId: ITEM }, NOW);

    expect(repository.reorderListItem).toHaveBeenCalledTimes(1);
    expect(repository.patchListItemFields).not.toHaveBeenCalled();
  });

  it('treats a null afterItemId as "move to the front"', async () => {
    await service.patchItem(USER, LIST, ITEM, { afterItemId: null }, NOW);

    expect(vi.mocked(repository.reorderListItem).mock.calls[0]?.[4]).toMatchObject({
      afterItemId: null,
    });
  });

  /**
   * A position and fields land in **one** transaction: the reorder already re-puts the whole
   * row, so the patch folds into that put rather than becoming a second write that could
   * leave the rename applied and the move lost.
   */
  it('folds a field edit into the reorder rather than writing twice', async () => {
    await service.patchItem(USER, LIST, ITEM, { title: 'Milk', afterItemId: null }, NOW);

    expect(repository.patchListItemFields).not.toHaveBeenCalled();
    expect(repository.reorderListItem).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repository.reorderListItem).mock.calls[0]?.[4]).toMatchObject({
      afterItemId: null,
      patch: { title: 'Milk' },
    });
  });

  it('sends no patch when the body carries only a position', async () => {
    await service.patchItem(USER, LIST, ITEM, { afterItemId: null }, NOW);

    expect(vi.mocked(repository.reorderListItem).mock.calls[0]?.[4]).not.toHaveProperty(
      'patch',
    );
  });

  it('refuses an empty patch rather than writing a no-op revision', async () => {
    await expect(service.patchItem(USER, LIST, ITEM, {}, NOW)).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('passes null through as "clear this field", distinct from omitting it', async () => {
    await service.patchItem(USER, LIST, ITEM, { note: null }, NOW);

    expect(vi.mocked(repository.patchListItemFields).mock.calls[0]?.[4]).toEqual({
      note: null,
    });
  });
});

describe('mapping the repository’s untyped signals', () => {
  it.each([
    ['a missing item', new ItemMissing(), { code: 'not_found' }],
    [
      'a taken client id',
      new IdTaken(),
      { code: 'conflict', message: 'That id is already in use. Try again.' },
    ],
    ['exhausted retries', new RetriesExhausted(), { code: 'internal' }],
  ])('turns %s into a contract error', async (_case, thrown, expected) => {
    vi.mocked(repository.patchListItemFields).mockRejectedValueOnce(thrown);

    await expect(
      service.patchItem(USER, LIST, ITEM, { title: 'Eggs' }, NOW),
    ).rejects.toMatchObject(expected);
  });

  it('404s a list the caller can reach but that no longer exists', async () => {
    vi.mocked(repository.getListMeta).mockResolvedValue(undefined);

    await expect(
      service.createItem(USER, LIST, { title: 'Eggs' }, NOW),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('deleting an item', () => {
  /**
   * The token **addresses** the operation it belongs to (P3-10): the undo route receives a
   * token and nothing else, and resolving it any other way would cost either a second index
   * or a read that grows with a month of the user's activity. The secret half is what
   * authorises, and only the hash of the whole thing is ever stored.
   */
  it('mints a token addressing its operation, stores only its hash, and offers six seconds', async () => {
    const result = await service.removeItem(USER, LIST, ITEM, NOW);

    expect(result.affectedCount).toBe(1);
    expect(Date.parse(result.undoExpiresAt) - Date.parse(NOW)).toBe(6000);

    const options = vi.mocked(repository.deleteListItem).mock.calls[0]?.[4];
    expect(result.undoToken).toMatch(
      new RegExp(`^${options?.operationId ?? ''}.[A-Za-z0-9_-]{43}$`),
    );
    expect(options?.tokenHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(options?.tokenHash).not.toBe(result.undoToken);
    expect(result.undoToken).not.toContain(options?.tokenHash ?? 'unreachable');
  });

  it('mints a different token every time', async () => {
    const first = await service.removeItem(USER, LIST, ITEM, NOW);
    const second = await service.removeItem(USER, LIST, ITEM, NOW);

    expect(first.undoToken).not.toBe(second.undoToken);
  });
});

describe('bulk ordering and replay', () => {
  it('anchors the run on the first member and refuses a position on any other', async () => {
    await expect(
      service.createItemsBulk(
        USER,
        LIST,
        { items: [{ title: 'One' }, { title: 'Two', afterItemId: ITEM }] },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('skips ids already committed rather than failing the batch', async () => {
    const existing = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1AA';
    vi.mocked(repository.resolveExistingItems).mockResolvedValue(
      new Map([[existing, anItem({ itemId: existing, title: 'Eggs' })]]),
    );

    await service.createItemsBulk(
      USER,
      LIST,
      { items: [{ itemId: existing, title: 'Eggs' }, { title: 'Milk' }] },
      NOW,
    );

    const written = vi.mocked(repository.createListItems).mock.calls[0]?.[3];
    expect(written?.map((item) => item.title)).toEqual(['Milk']);
  });

  /**
   * Capacity is measured against what the call would **add**, after resolving what is
   * already there — otherwise the retry meant to finish an interrupted batch is exactly
   * the request that gets rejected.
   */
  it('counts only the missing ids against the cap', async () => {
    const existing = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1AA';
    useList(aList({ itemCount: 500 }));
    vi.mocked(repository.resolveExistingItems).mockResolvedValue(
      new Map([[existing, anItem({ itemId: existing, title: 'Eggs' })]]),
    );

    // Every id is already committed, so the batch adds nothing and the full list is fine.
    await expect(
      service.createItemsBulk(
        USER,
        LIST,
        { items: [{ itemId: existing, title: 'Eggs' }] },
        NOW,
      ),
    ).resolves.toHaveLength(1);
    expect(repository.createListItems).not.toHaveBeenCalled();
  });

  it('answers a fully committed replay with server truth, in the order sent', async () => {
    const first = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1AA';
    const second = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1AB';
    vi.mocked(repository.resolveExistingItems).mockResolvedValue(
      new Map([
        [first, anItem({ itemId: first, title: 'Eggs', rank: 'V' })],
        [second, anItem({ itemId: second, title: 'Milk', rank: 'W' })],
      ]),
    );

    const result = await service.createItemsBulk(
      USER,
      LIST,
      {
        items: [
          { itemId: first, title: 'Eggs' },
          { itemId: second, title: 'Milk' },
        ],
      },
      NOW,
    );

    expect(result.map((item) => item.itemId)).toEqual([first, second]);
    expect(result.map((item) => item.rank)).toEqual(['V', 'W']);
  });

  it('records a receipt even when every id was already committed', async () => {
    const idempotency = await import('../repositories/idempotencyRepository.js');
    const existing = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1AA';
    vi.mocked(repository.resolveExistingItems).mockResolvedValue(
      new Map([[existing, anItem({ itemId: existing, title: 'Eggs' })]]),
    );

    await service.createItemsBulk(
      USER,
      LIST,
      { items: [{ itemId: existing, title: 'Eggs' }] },
      NOW,
      () => ({}) as never,
    );

    expect(idempotency.writeReceiptOnly).toHaveBeenCalledTimes(1);
    expect(repository.createListItems).not.toHaveBeenCalled();
  });
});

describe('the transactional item cap', () => {
  it('maps the repository’s full-list refusal to the exact copy', async () => {
    vi.mocked(repository.createListItems).mockRejectedValueOnce(new ListFull());

    await expect(
      service.createItem(USER, LIST, { title: 'One more' }, NOW),
    ).rejects.toMatchObject({ code: 'validation_failed', message: 'List is full.' });
  });
});

describe('reads', () => {
  it('joins only links whose Activity the caller may still read', async () => {
    const items = [anItem(), anItem({ itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1AA' })];
    vi.mocked(repository.listItems).mockResolvedValue({
      list: aList(),
      items,
      itemIds: items.map((item) => item.itemId),
    });
    vi.mocked(repository.batchGetViewerLinks).mockResolvedValue([
      {
        listId: LIST,
        itemId: ITEM,
        viewerUserId: USER,
        activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X5',
        linkedAt: NOW,
      },
      {
        listId: LIST,
        itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1AA',
        viewerUserId: USER,
        activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1AA',
        linkedAt: NOW,
      },
    ]);
    /**
     * The second link's Activity is gone, so it is omitted rather than serialised dead. The
     * batched check answers by **absence** from the map — it does not throw, because a caller
     * asking about many activities wants to know which ones it may read.
     */
    vi.mocked(authz.readableActivities).mockResolvedValue(
      new Map([['act_01J8XKQ2M4N5P6R7S8T9V0W1X5', {} as never]]),
    );

    const page = await service.listItemsFor(USER, LIST, undefined);

    expect(page.items[0]?.viewerLink).toBeDefined();
    expect(page.items[1]?.viewerLink).toBeUndefined();
  });

  it('404s the exact read for a missing or tombstoned id alike', async () => {
    vi.mocked(repository.getListItem).mockResolvedValue(undefined);

    await expect(service.getItemById(USER, LIST, ITEM)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

/**
 * The destructive half of the stale-pointer rule (P3-14), raised in review.
 *
 * These cover what a real table cannot: DynamoDB Local answers every read from the leader,
 * so replica lag — the thing that makes an eventually consistent classification unsafe to act
 * on — is unobservable there. The assertions are on which read the service issues before it
 * deletes anything.
 */
describe('cleaning up a stale viewer pointer', () => {
  const LINK = {
    listId: LIST,
    itemId: ITEM,
    viewerUserId: USER,
    activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X4',
    linkedAt: '2026-08-25T09:00:00.000Z',
  };

  const withStaleLink = () => {
    useList();
    vi.mocked(repository.listItems).mockResolvedValue({
      list: aList(),
      items: [anItem()],
      itemIds: [ITEM],
    } as never);
    vi.mocked(repository.batchGetViewerLinks).mockResolvedValue([LINK as never]);
    /** Absent from the batch means stale — deleted, or not this caller's to read. */
    vi.mocked(authz.readableActivities).mockResolvedValue(new Map());
  };

  /**
   * The failure this exists to prevent: a Plan created moments ago whose Activity has not
   * reached the replica the projection read. Omitting its state line for one read is
   * self-healing; deleting the pointer strands a Plan that exists, permanently.
   */
  it('does not delete when a strong read finds the Activity after all', async () => {
    withStaleLink();
    vi.mocked(authz.assertActivityReadAccessFromPartition).mockResolvedValue({} as never);

    const page = await service.listItemsFor(USER, LIST, undefined);

    expect(page.items[0]?.viewerLink).toBeUndefined();
    expect(vi.mocked(repository.deleteStaleViewerLink)).not.toHaveBeenCalled();
  });

  it('confirms from the leader before deleting, not from the projection read', async () => {
    withStaleLink();
    vi.mocked(authz.assertActivityReadAccessFromPartition).mockRejectedValue(
      new AppError('not_found', 'Activity not found.'),
    );

    await service.listItemsFor(USER, LIST, undefined);

    expect(vi.mocked(activityRepository.getActivityPartitionStrong)).toHaveBeenCalledWith(
      LINK.activityId,
    );
    expect(vi.mocked(repository.deleteStaleViewerLink)).toHaveBeenCalledTimes(1);
  });

  /**
   * `linkedAt` travels with `activityId` so the condition catches a pointer refreshed to the
   * **same** Activity — which is what re-adding a viewer to a Plan produces, and what an
   * `activityId`-only condition happily deleted.
   */
  it('passes the observed row so any rewrite beats the delete', async () => {
    withStaleLink();
    vi.mocked(authz.assertActivityReadAccessFromPartition).mockRejectedValue(
      new AppError('not_found', 'Activity not found.'),
    );

    await service.listItemsFor(USER, LIST, undefined);

    expect(vi.mocked(repository.deleteStaleViewerLink)).toHaveBeenCalledWith(
      LIST,
      USER,
      ITEM,
      expect.objectContaining({
        activityId: LINK.activityId,
        linkedAt: LINK.linkedAt,
      }),
    );
  });

  /** Best-effort: a failing cleanup must never fail the read it belongs to. */
  it('answers the read even when the delete throws', async () => {
    withStaleLink();
    vi.mocked(authz.assertActivityReadAccessFromPartition).mockRejectedValue(
      new AppError('not_found', 'Activity not found.'),
    );
    vi.mocked(repository.deleteStaleViewerLink).mockRejectedValue(
      new Error('ConditionalCheckFailedException'),
    );

    const page = await service.listItemsFor(USER, LIST, undefined);

    expect(page.items[0]?.item.itemId).toBe(ITEM);
  });

  it('reads nothing strongly and deletes nothing when every pointer is readable', async () => {
    useList();
    vi.mocked(repository.listItems).mockResolvedValue({
      list: aList(),
      items: [anItem()],
      itemIds: [ITEM],
    } as never);
    vi.mocked(repository.batchGetViewerLinks).mockResolvedValue([LINK as never]);
    vi.mocked(authz.readableActivities).mockResolvedValue(
      new Map([[LINK.activityId, {} as never]]),
    );

    await service.listItemsFor(USER, LIST, undefined);

    expect(
      vi.mocked(activityRepository.getActivityPartitionStrong),
    ).not.toHaveBeenCalled();
    expect(vi.mocked(repository.deleteStaleViewerLink)).not.toHaveBeenCalled();
  });
});

/**
 * The read shape of a full page, raised in review (P3-15).
 *
 * A fifty-item page used to authorise one Activity per link, **sequentially** — fifty round
 * trips on every list open, for data the response then discarded. These assert the shape
 * rather than the timing: what matters is that the page issues bounded batch reads and not a
 * read per link, which is the property a `Promise.all` would also violate even though it
 * looks faster.
 */
describe('a full page of linked items reads in bounded batches', () => {
  const PAGE = 50;

  const linkedPage = () => {
    const items = Array.from({ length: PAGE }, (_index, position) =>
      anItem({
        itemId: `itm_01J8XKQ2M4N5P6R7S8T9V0W${String(position).padStart(3, '0')}`,
        rank: `a${position}`,
      }),
    );
    const links = items.map((item, position) => ({
      listId: LIST,
      itemId: item.itemId,
      viewerUserId: USER,
      activityId: `act_01J8XKQ2M4N5P6R7S8T9V0W${String(position).padStart(3, '0')}`,
      linkedAt: NOW,
    }));
    useList();
    vi.mocked(repository.listItems).mockResolvedValue({
      list: aList(),
      items,
      itemIds: items.map((item) => item.itemId),
    } as never);
    vi.mocked(repository.batchGetViewerLinks).mockResolvedValue(links as never);
    vi.mocked(authz.readableActivities).mockResolvedValue(
      new Map(links.map((entry) => [entry.activityId, {} as never])),
    );
    return { items, links };
  };

  it('authorises the whole page in one call, not one per link', async () => {
    const { links } = linkedPage();

    const page = await service.listItemsFor(USER, LIST, undefined);

    expect(page.items).toHaveLength(PAGE);
    expect(vi.mocked(authz.readableActivities)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(authz.readableActivities).mock.calls[0]?.[1]).toEqual(
      links.map((entry) => entry.activityId),
    );
  });

  /**
   * The regression guard. `assertActivityAccess` is the per-link path this replaced, and each
   * of its calls is a `GetItem`; reintroducing it inside the loop is the easy mistake.
   */
  it('performs no per-link authorisation read', async () => {
    linkedPage();

    await service.listItemsFor(USER, LIST, undefined);

    expect(vi.mocked(authz.assertActivityAccess)).not.toHaveBeenCalled();
  });

  /** One caller-link batch read for the page, not one per item. */
  it('reads the caller’s links in one batch', async () => {
    linkedPage();

    await service.listItemsFor(USER, LIST, undefined);

    expect(vi.mocked(repository.batchGetViewerLinks)).toHaveBeenCalledTimes(1);
  });

  /** Nothing is confirmed strongly or deleted when every pointer resolves. */
  it('reads nothing strongly when the whole page is readable', async () => {
    linkedPage();

    await service.listItemsFor(USER, LIST, undefined);

    expect(
      vi.mocked(activityRepository.getActivityPartitionStrong),
    ).not.toHaveBeenCalled();
    expect(vi.mocked(repository.deleteStaleViewerLink)).not.toHaveBeenCalled();
  });
});

/**
 * The state line's data, and the assertion the projection lacked (P3-15, raised in review).
 *
 * Every earlier projection test asserted `viewerLink.activityId` — that a link exists. None
 * proved a row could tell **which** state the Plan is in, which is the whole of P3-34: a
 * scheduled Plan and the same Plan after unscheduling produced identical responses.
 */
describe('the caller’s Plan state reaches the row', () => {
  const LINKED = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X4';

  const withPlan = (plan: Record<string, unknown>) => {
    useList();
    vi.mocked(repository.listItems).mockResolvedValue({
      list: aList(),
      items: [anItem()],
      itemIds: [ITEM],
    } as never);
    vi.mocked(repository.batchGetViewerLinks).mockResolvedValue([
      {
        listId: LIST,
        itemId: ITEM,
        viewerUserId: USER,
        activityId: LINKED,
        linkedAt: NOW,
      },
    ] as never);
    vi.mocked(authz.readableActivities).mockResolvedValue(
      new Map([[LINKED, { activityId: LINKED, ...plan } as never]]),
    );
  };

  const planOf = async () =>
    (await service.listItemsFor(USER, LIST, undefined)).items[0]?.viewerPlan;

  /** Scheduled: a date is present, which is what makes the line displayable at all. */
  it('carries the schedule of a scheduled Plan', async () => {
    withPlan({
      type: 'event',
      status: 'scheduled',
      schedule: { date: '2026-09-05', time: '19:00', timezone: 'America/New_York' },
    });

    expect(await planOf()).toEqual({
      activityId: LINKED,
      type: 'event',
      status: 'scheduled',
      schedule: { date: '2026-09-05', time: '19:00', timezone: 'America/New_York' },
    });
  });

  /**
   * Unscheduled: the pointer stays and the **schedule is absent**, which is exactly how the
   * client knows to hide the line. This is the pair that used to be indistinguishable.
   */
  it('omits the schedule of an unscheduled Plan, keeping the link', async () => {
    withPlan({ type: 'event', status: 'saved' });

    const page = await service.listItemsFor(USER, LIST, undefined);

    expect(page.items[0]?.viewerLink?.activityId).toBe(LINKED);
    expect(page.items[0]?.viewerPlan?.schedule).toBeUndefined();
    expect(page.items[0]?.viewerPlan?.status).toBe('saved');
  });

  it('distinguishes scheduled from unscheduled in the response', async () => {
    withPlan({
      type: 'event',
      status: 'scheduled',
      schedule: { date: '2026-09-05', timezone: 'America/New_York' },
    });
    const scheduled = await planOf();

    withPlan({ type: 'event', status: 'saved' });
    const unscheduled = await planOf();

    expect(scheduled).not.toEqual(unscheduled);
  });

  /** Completed: `Done Saturday` rather than `Planned Saturday`, from `status`. */
  it('carries the completed status', async () => {
    withPlan({
      type: 'event',
      status: 'completed',
      schedule: { date: '2026-09-05', timezone: 'America/New_York' },
    });

    expect((await planOf())?.status).toBe('completed');
  });

  /** Rescheduled: the same Plan, a different date — the line updates rather than vanishing. */
  it('reflects a rescheduled Plan’s new date', async () => {
    withPlan({
      type: 'event',
      status: 'scheduled',
      schedule: { date: '2026-09-05', timezone: 'America/New_York' },
    });
    const before = await planOf();

    withPlan({
      type: 'event',
      status: 'scheduled',
      schedule: { date: '2026-09-12', timezone: 'America/New_York' },
    });
    const after = await planOf();

    expect(before?.schedule?.date).toBe('2026-09-05');
    expect(after?.schedule?.date).toBe('2026-09-12');
  });

  /**
   * The verb differs by kind — an event is `Planned`, a watch session is `Next session` — and
   * inferring it from the list's behaviour would be wrong for a `custom` Plan made from a
   * `watch` list, which the bridge explicitly allows.
   */
  it('carries the Plan kind, which the list behaviour cannot supply', async () => {
    withPlan({ type: 'watch', status: 'scheduled' });

    expect((await planOf())?.type).toBe('watch');
  });

  /**
   * The trim is the contract. A row must not become a second Activity-detail surface, so the
   * Plan's own title — independent of the item's since the one-time seed — never travels.
   */
  it('carries exactly the four fields, and no more', async () => {
    withPlan({
      type: 'event',
      status: 'scheduled',
      title: 'A private plan title',
      notes: 'private',
      ownerId: USER,
      schedule: { date: '2026-09-05', timezone: 'America/New_York' },
    });

    const plan = await planOf();

    expect(Object.keys(plan ?? {}).sort()).toEqual([
      'activityId',
      'schedule',
      'status',
      'type',
    ]);
  });

  /** No link, no plan: the two arrive together or not at all. */
  it('omits the plan when there is no readable link', async () => {
    useList();
    vi.mocked(repository.listItems).mockResolvedValue({
      list: aList(),
      items: [anItem()],
      itemIds: [ITEM],
    } as never);
    vi.mocked(repository.batchGetViewerLinks).mockResolvedValue([] as never);

    const page = await service.listItemsFor(USER, LIST, undefined);

    expect(page.items[0]?.viewerLink).toBeUndefined();
    expect(page.items[0]?.viewerPlan).toBeUndefined();
  });
});
