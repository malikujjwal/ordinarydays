import type { Activity, List, ListItem } from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../lib/errors.js';
import { addIngredientsToList } from './ingredientsToListService.js';

/**
 * What this service decides, with the repositories mocked (`definition-of-done.md` §3).
 *
 * The pure rules are proved in `packages/shared/src/lists/__tests__` and the writes against a
 * real table in `test/integration/ingredientsToList.int.test.ts`. What is left here is the
 * service's own reasoning: what it refuses and in which order, which rows each classification
 * produces, that **everything it writes goes into one transaction**, and that a condition
 * failure re-runs the whole read/classify/commit cycle rather than retrying a stale plan.
 */
vi.mock('../repositories/activityRepository.js', () => ({
  ingredientsAddedToListItem: vi.fn((activityId, listId, additions) => ({
    Update: { Key: { pk: `ACT#${activityId}` }, listId, additions },
  })),
}));
vi.mock('../repositories/idempotencyRepository.js', () => ({
  receiptItem: vi.fn(() => ({ Put: { Item: { receipt: true } } })),
}));
vi.mock('../repositories/listRepository.js', () => ({
  appendListItemCreates: vi.fn((builder, _listId, created) => {
    const deletionGate = builder.length;
    builder.add({ ConditionCheck: { Key: { gate: true } } });
    for (const item of created) builder.add({ Put: { Item: item } });
    const meta = builder.length;
    builder.add({ Update: { Key: { meta: true } } });
    return { deletionGate, meta };
  }),
  appendSourceLabelExtension: vi.fn((builder, _listId, item, sourceLabel) => {
    builder.add({ Update: { Key: { itemId: item.itemId }, sourceLabel } });
  }),
  getListMeta: vi.fn(),
  ListNotFoundError: class extends Error {},
  ListRankRepairRequiredError: class extends Error {},
  ListReadFenceError: class extends Error {},
  planListItemWrites: vi.fn(),
  readAllListItems: vi.fn(),
}));
vi.mock('../repositories/tx.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../repositories/tx.js')>();
  return { ...actual, transactWrite: vi.fn() };
});
vi.mock('./authz.js', () => ({
  assertActivityAccess: vi.fn(),
  assertListAccess: vi.fn(),
}));
vi.mock('./listMutationService.js', () => ({
  withListWorkDrain: vi.fn((_u, _l, _a, read: () => unknown) => read()),
}));
vi.mock('./listRankRepairService.js', () => ({ repairListRanks: vi.fn() }));

const activityRepository = await import('../repositories/activityRepository.js');
const listRepository = await import('../repositories/listRepository.js');
const tx = await import('../repositories/tx.js');
const authz = await import('./authz.js');

const USER = 'usr_local_dev';
const MEAL = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const CHICKEN = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1';
const TORTILLAS = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2';
const ITEM_ONE = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1B1';
const ITEM_TWO = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1B2';
/** A Sunday, five days after `NOW`, so §7.5 rule 1 applies. */
const NOW = '2026-08-18T09:00:00.000Z';
const SUNDAY = '2026-08-23';
const READ_AT = '2026-08-17T09:00:00.000Z';

const meal = (overrides: Partial<Activity> = {}): Activity =>
  ({
    activityId: MEAL,
    ownerId: USER,
    objectKind: 'plan',
    type: 'meal',
    title: 'Chicken tacos',
    status: 'scheduled',
    schedule: { date: SUNDAY, time: '19:00', timezone: 'America/New_York' },
    details: {
      kind: 'meal',
      mealSlot: 'dinner',
      ingredients: [
        { ingredientId: CHICKEN, name: 'Chicken' },
        { ingredientId: TORTILLAS, name: 'Tortillas', quantity: '8' },
      ],
    },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: READ_AT,
    lastActivityAt: READ_AT,
    updatedAt: READ_AT,
    schemaVersion: 1,
    ...overrides,
  }) as Activity;

const list = (overrides: Partial<List> = {}): List =>
  ({
    listId: LIST,
    ownerId: USER,
    title: 'Groceries',
    templateKey: 'groceries',
    behaviour: 'collection',
    capabilities: { checkable: true, supportsLocation: false },
    slot: 'groceries',
    icon: 'cart',
    emptyStateCopy: 'Nothing yet',
    itemCount: 0,
    uncheckedCount: 0,
    rankVersion: 1,
    archived: false,
    memberCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    ...overrides,
  }) as List;

const existingItem = (overrides: Partial<ListItem> = {}): ListItem => ({
  itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1C1',
  listId: LIST,
  rank: 'n',
  itemRevision: 2,
  title: 'Chicken',
  checked: false,
  ...overrides,
});

const input = (
  selections: readonly { ingredientId: string; itemId: string }[] = [
    { ingredientId: CHICKEN, itemId: ITEM_ONE },
  ],
) => ({ listId: LIST, ingredients: selections }) as never;

const run = (activity = meal(), selections?: Parameters<typeof input>[0]) => {
  vi.mocked(authz.assertActivityAccess).mockResolvedValue({ activity } as never);
  return addIngredientsToList(USER, MEAL, input(selections), NOW);
};

/** Every item the one transaction was built from. */
const committed = () =>
  (vi.mocked(tx.transactWrite).mock.calls[0]?.[0] ?? []) as Record<string, never>[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authz.assertActivityAccess).mockResolvedValue({ activity: meal() } as never);
  vi.mocked(authz.assertListAccess).mockResolvedValue({
    index: { grant: true },
  } as never);
  vi.mocked(listRepository.getListMeta).mockResolvedValue(list());
  vi.mocked(listRepository.readAllListItems).mockResolvedValue([]);
  vi.mocked(listRepository.planListItemWrites).mockImplementation((_u, _l, _a, count) =>
    Promise.resolve({
      list: list(),
      ranks: Array.from({ length: count }, (_, index) => `n${String(index)}`),
    }),
  );
  vi.mocked(tx.transactWrite).mockResolvedValue(undefined as never);
});

describe('what it refuses, before it writes anything', () => {
  it('rejects an activity that is not a meal', async () => {
    await expect(
      run(meal({ type: 'event', details: { kind: 'event' } })),
    ).rejects.toThrow(AppError);
    expect(tx.transactWrite).not.toHaveBeenCalled();
  });

  it.each(['watch', 'meals'] as const)('rejects a %s destination', async (behaviour) => {
    vi.mocked(listRepository.getListMeta).mockResolvedValue(list({ behaviour }));

    await expect(run()).rejects.toThrow(AppError);
    expect(tx.transactWrite).not.toHaveBeenCalled();
  });

  it('rejects an ingredient id the meal no longer has, and writes nothing', async () => {
    await expect(
      run(meal(), [{ ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1C9', itemId: ITEM_ONE }]),
    ).rejects.toThrow(AppError);
    expect(tx.transactWrite).not.toHaveBeenCalled();
  });

  it('rejects the same ingredient selected twice', async () => {
    await expect(
      run(meal(), [
        { ingredientId: CHICKEN, itemId: ITEM_ONE },
        { ingredientId: CHICKEN, itemId: ITEM_TWO },
      ]),
    ).rejects.toThrow(AppError);
    expect(tx.transactWrite).not.toHaveBeenCalled();
  });

  /**
   * Two ingredients aimed at one destination row would make the transaction write the same
   * key twice, which DynamoDB refuses as a malformed request rather than a condition failure.
   */
  it('rejects two ingredients sharing one destination item id', async () => {
    await expect(
      run(meal(), [
        { ingredientId: CHICKEN, itemId: ITEM_ONE },
        { ingredientId: TORTILLAS, itemId: ITEM_ONE },
      ]),
    ).rejects.toThrow(AppError);
    expect(tx.transactWrite).not.toHaveBeenCalled();
  });

  it('refuses to overflow the list, before attempting the write', async () => {
    vi.mocked(listRepository.getListMeta).mockResolvedValue(list({ itemCount: 500 }));

    await expect(run()).rejects.toThrow(AppError);
    expect(tx.transactWrite).not.toHaveBeenCalled();
  });

  it('checks the list before reading the meal, so neither leaks the other', async () => {
    vi.mocked(authz.assertListAccess).mockRejectedValue(
      new AppError('not_found', 'List not found.'),
    );

    await expect(addIngredientsToList(USER, MEAL, input(), NOW)).rejects.toThrow(
      AppError,
    );
    expect(authz.assertActivityAccess).not.toHaveBeenCalled();
  });
});

/**
 * The defect this rewrite exists for. The first version committed list rows and the receipt,
 * then wrote the meal's provenance separately — so a same-key retry replayed the receipt and
 * never ran that write, leaving the meal permanently disagreeing with the list.
 */
describe('everything commits in one transaction', () => {
  it('issues exactly one transactWrite', async () => {
    await run(meal(), [
      { ingredientId: CHICKEN, itemId: ITEM_ONE },
      { ingredientId: TORTILLAS, itemId: ITEM_TWO },
    ]);

    expect(tx.transactWrite).toHaveBeenCalledOnce();
  });

  it('carries the created rows, the meal provenance and the receipt together', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([existingItem()]);

    await addIngredientsToList(
      USER,
      MEAL,
      input([
        { ingredientId: CHICKEN, itemId: ITEM_ONE },
        { ingredientId: TORTILLAS, itemId: ITEM_TWO },
      ]),
      NOW,
      () => ({ receipt: true }) as never,
    );

    const items = committed();
    // The label extension for Chicken, the create for Tortillas, the meal, the receipt.
    expect(items.some((item) => 'Put' in item)).toBe(true);
    expect(activityRepository.ingredientsAddedToListItem).toHaveBeenCalledOnce();
    expect(items.at(-1)).toEqual({ Put: { Item: { receipt: true } } });
  });

  it('conditions the meal write on the version it read', async () => {
    await run();

    expect(activityRepository.ingredientsAddedToListItem).toHaveBeenCalledWith(
      MEAL,
      LIST,
      [{ index: 0, ingredientId: CHICKEN }],
      READ_AT,
      NOW,
    );
  });

  it('writes nothing when the transaction fails', async () => {
    vi.mocked(tx.transactWrite).mockRejectedValue(new AppError('internal', 'boom'));

    await expect(run()).rejects.toThrow(AppError);
    // One attempt, one transaction, and it did not commit — there is no partial state.
    expect(tx.transactWrite).toHaveBeenCalledOnce();
  });
});

describe('a stale read re-runs the whole cycle', () => {
  /** Reclassifying is the point: a row checked in between must become a new item. */
  it('re-reads and reclassifies after a condition failure, then commits', async () => {
    let attempt = 0;
    vi.mocked(listRepository.readAllListItems).mockImplementation(() => {
      attempt += 1;
      // First read: Chicken is unchecked, so it would be extended. Second: checked.
      return Promise.resolve([existingItem({ checked: attempt > 1 })]) as never;
    });
    vi.mocked(tx.transactWrite).mockImplementationOnce((_items, options) => {
      // Anything that is not the deletion gate or the receipt is a reclassify signal, and
      // the gate is always the first item the create span appends.
      throw (
        options as { onConditionFailed: (index: number) => Error }
      ).onConditionFailed(1);
    });

    const result = await run();

    expect(vi.mocked(listRepository.readAllListItems).mock.calls).toHaveLength(2);
    expect(tx.transactWrite).toHaveBeenCalledTimes(2);
    expect(result.ingredients[0]?.outcome).toBe('created');
  });

  it('gives up with the retryable conflict after three raced attempts', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([existingItem()]);
    vi.mocked(tx.transactWrite).mockImplementation((_items, options) => {
      throw (
        options as { onConditionFailed: (index: number) => Error }
      ).onConditionFailed(1);
    });

    await expect(run()).rejects.toMatchObject({ code: 'internal' });
    expect(tx.transactWrite).toHaveBeenCalledTimes(3);
  });
});

describe('what it derives, and what it refuses to be told', () => {
  it('sets the title, the source activity and the label server-side', async () => {
    await run(meal(), [
      { ingredientId: CHICKEN, itemId: ITEM_ONE },
      { ingredientId: TORTILLAS, itemId: ITEM_TWO },
    ]);

    const created = vi.mocked(listRepository.appendListItemCreates).mock.calls[0]?.[2];
    expect(created).toEqual([
      expect.objectContaining({
        itemId: ITEM_ONE,
        title: 'Chicken',
        sourceActivityId: MEAL,
        sourceLabel: 'Sunday dinner',
        checked: false,
      }),
      expect.objectContaining({ itemId: ITEM_TWO, title: 'Tortillas (8)' }),
    ]);
  });

  it('uses the client-minted item id rather than minting its own', async () => {
    await run();

    const created = vi.mocked(listRepository.appendListItemCreates).mock.calls[0]?.[2];
    expect(created?.[0]?.itemId).toBe(ITEM_ONE);
  });

  it('appends the meal title when another meal already used the label', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([
      existingItem({
        title: 'Potatoes',
        sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1Y9',
        sourceLabel: 'Sunday dinner',
      }),
    ]);

    const result = await run();

    expect(result.sourceLabel).toBe('Sunday dinner · Chicken tacos');
  });

  it('ignores its own earlier rows when deciding whether the label collides', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([
      existingItem({
        title: 'Tomatoes',
        sourceActivityId: MEAL,
        sourceLabel: 'Sunday dinner',
      }),
    ]);

    expect((await run()).sourceLabel).toBe('Sunday dinner');
  });

  it('uses the meal title for an unscheduled meal', async () => {
    const undated = meal();
    delete (undated as { schedule?: unknown }).schedule;

    expect((await run(undated)).sourceLabel).toBe('Chicken tacos');
  });

  it('returns the meal’s new version', async () => {
    expect((await run()).activityUpdatedAt).toBe(NOW);
  });
});

describe('the duplicate rule chooses which row is written', () => {
  it('creates when nothing matches', async () => {
    const result = await run();

    expect(result.ingredients[0]?.outcome).toBe('created');
    expect(listRepository.appendSourceLabelExtension).not.toHaveBeenCalled();
  });

  it('extends and creates nothing when an unchecked row matches', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([existingItem()]);

    const result = await run();

    expect(result.ingredients[0]?.outcome).toBe('labelled');
    expect(listRepository.appendSourceLabelExtension).toHaveBeenCalledOnce();
    expect(
      vi.mocked(listRepository.appendListItemCreates).mock.calls[0]?.[2],
    ).toHaveLength(0);
  });

  it('matches case-insensitively, on trimmed titles', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([
      existingItem({ title: '  cHiCkEn  ' }),
    ]);

    expect((await run()).ingredients[0]?.outcome).toBe('labelled');
  });

  it('creates a second row when the match is checked, because it was bought', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([
      existingItem({ checked: true }),
    ]);

    const result = await run();

    expect(result.ingredients[0]?.outcome).toBe('created');
    expect(listRepository.appendSourceLabelExtension).not.toHaveBeenCalled();
  });

  it('appends to an existing label rather than replacing it', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([
      existingItem({
        sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1Y8',
        sourceLabel: 'Thursday lunch',
      }),
    ]);

    const result = await run();

    expect(result.ingredients[0]?.item.sourceLabel).toBe(
      'Thursday lunch · Sunday dinner',
    );
  });

  /** A re-tap after a lost response must not read `Sunday dinner · Sunday dinner`. */
  it('writes nothing for a row that already carries this label', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([
      existingItem({ sourceActivityId: MEAL, sourceLabel: 'Sunday dinner' }),
    ]);

    const result = await run();

    expect(result.ingredients[0]?.outcome).toBe('labelled');
    expect(listRepository.appendSourceLabelExtension).not.toHaveBeenCalled();
    expect(
      vi.mocked(listRepository.appendListItemCreates).mock.calls[0]?.[2],
    ).toHaveLength(0);
  });

  it('compares whole segments, so a prefix is not a match', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([
      existingItem({
        sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1Y8',
        sourceLabel: 'Sunday',
      }),
    ]);

    await run();

    expect(listRepository.appendSourceLabelExtension).toHaveBeenCalledOnce();
  });

  it('lets only the first of two identical titles claim the one matching row', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([existingItem()]);
    const twoChickens = meal({
      details: {
        kind: 'meal',
        mealSlot: 'dinner',
        ingredients: [
          { ingredientId: CHICKEN, name: 'Chicken' },
          { ingredientId: TORTILLAS, name: 'chicken' },
        ],
      },
    });

    const result = await run(twoChickens, [
      { ingredientId: CHICKEN, itemId: ITEM_ONE },
      { ingredientId: TORTILLAS, itemId: ITEM_TWO },
    ]);

    expect(result.ingredients.map((row) => row.outcome)).toEqual(['labelled', 'created']);
  });
});

describe('the response', () => {
  it('reads in the order the ingredients were sent, whatever happened to each', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([
      existingItem({ title: 'Tortillas (8)' }),
    ]);

    const result = await run(meal(), [
      { ingredientId: TORTILLAS, itemId: ITEM_TWO },
      { ingredientId: CHICKEN, itemId: ITEM_ONE },
    ]);

    expect(result.ingredients.map((row) => row.ingredientId)).toEqual([
      TORTILLAS,
      CHICKEN,
    ]);
    expect(result.ingredients.map((row) => row.outcome)).toEqual(['labelled', 'created']);
  });

  it('names every selected ingredient, including deduplicated ones', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([existingItem()]);

    const result = await run(meal(), [
      { ingredientId: CHICKEN, itemId: ITEM_ONE },
      { ingredientId: TORTILLAS, itemId: ITEM_TWO },
    ]);

    expect(result.ingredients).toHaveLength(2);
    expect(activityRepository.ingredientsAddedToListItem).toHaveBeenCalledWith(
      MEAL,
      LIST,
      [
        { index: 0, ingredientId: CHICKEN },
        { index: 1, ingredientId: TORTILLAS },
      ],
      READ_AT,
      NOW,
    );
  });
});
