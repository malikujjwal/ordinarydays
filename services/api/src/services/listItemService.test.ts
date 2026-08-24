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
  resolveExistingItems: vi.fn(() => Promise.resolve(new Map<string, unknown>())),
}));

vi.mock('./authz.js', () => ({
  assertListAccess: vi.fn(() => Promise.resolve({ index: {}, isOwner: true })),
  assertActivityAccess: vi.fn(() => Promise.resolve({})),
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
  it('mints an opaque token, stores only its hash, and offers Undo for six seconds', async () => {
    const result = await service.removeItem(USER, LIST, ITEM, NOW);

    expect(result.affectedCount).toBe(1);
    expect(result.undoToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(result.undoExpiresAt) - Date.parse(NOW)).toBe(6000);

    const options = vi.mocked(repository.deleteListItem).mock.calls[0]?.[4];
    expect(options?.tokenHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(options?.tokenHash).not.toBe(result.undoToken);
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
    const authz = await import('./authz.js');
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
    // The second link's Activity is gone, so it is omitted rather than serialised dead.
    vi.mocked(authz.assertActivityAccess)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new AppError('not_found', 'Activity not found.'));

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
