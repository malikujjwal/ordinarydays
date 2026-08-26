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
  loadReceipt: vi.fn(),
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
  appendIngredientDestinationBinding: vi.fn((builder, binding) => {
    builder.add({ Put: { Item: binding } });
  }),
  appendSourceLabelExtension: vi.fn((builder, _listId, current, next) => {
    builder.add({ Update: { Key: { itemId: current.itemId }, next } });
  }),
  getListMeta: vi.fn(),
  ListNotFoundError: class extends Error {},
  ListRankRepairRequiredError: class extends Error {},
  ListReadFenceError: class extends Error {},
  ListSnapshotStaleError: class extends Error {},
  newItemId: vi.fn(() => 'itm_01J8XKQ2M4N5P6R7S8T9V0W1ZZ'),
  planListItemWrites: vi.fn(),
  snapshotListItems: vi.fn(),
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
const idempotencyRepository = await import('../repositories/idempotencyRepository.js');
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
  selections: readonly { ingredientId: string; itemId?: string }[] = [
    { ingredientId: CHICKEN, itemId: ITEM_ONE },
  ],
) => ({ listId: LIST, ingredients: selections }) as never;

const run = (activity = meal(), selections?: Parameters<typeof input>[0]) => {
  vi.mocked(authz.assertActivityAccess).mockResolvedValue({ activity } as never);
  return addIngredientsToList(USER, MEAL, input(selections), NOW);
};

/** Seeds the fenced snapshot the classification is decided from. */
const snapshot = (
  items: ListItem[],
  rankVersion = 1,
  ingredientDestinationBindings = new Map(),
  tombstonedDestinationIds = new Set<string>(),
) => {
  vi.mocked(listRepository.snapshotListItems).mockResolvedValue({
    items,
    rankVersion,
    itemVersion: 1,
    ingredientDestinationBindings,
    tombstonedDestinationIds,
  });
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
  snapshot([]);
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

  /**
   * A deleted item's id stays reserved for its own Undo (§P3-10). Created rows have always
   * honoured that through a `ConditionCheck`; an **absorbed** one writes its binding to the
   * same `ITEMID#` key and had no guard, so an ordinary add could take the id and leave the
   * delete's Undo with nowhere to put the row back (raised in review).
   */
  it('refuses a destination id a tombstone still owns, before classifying', async () => {
    snapshot([existingItem()], 1, new Map(), new Set([ITEM_ONE]));

    await expect(run()).rejects.toMatchObject({ code: 'conflict' });
    expect(tx.transactWrite).not.toHaveBeenCalled();
  });

  it('ignores a tombstone on an id this request did not ask for', async () => {
    snapshot([], 1, new Map(), new Set(['itm_01J8XKQ2M4N5P6R7S8T9V0W1D9']));

    await expect(run()).resolves.toBeDefined();
  });

  it('refuses to overflow the list, before attempting the write', async () => {
    vi.mocked(listRepository.planListItemWrites).mockResolvedValue({
      list: list({ itemCount: 500 }),
      ranks: ['n0'],
    });

    await expect(run()).rejects.toThrow(AppError);
    expect(tx.transactWrite).not.toHaveBeenCalled();
  });

  it('validates collection behaviour on the exact transaction basis', async () => {
    vi.mocked(listRepository.planListItemWrites).mockResolvedValue({
      list: list({ behaviour: 'watch' }),
      ranks: ['n0'],
    });

    await expect(run()).rejects.toMatchObject({ code: 'validation_failed' });
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
    snapshot([existingItem()]);

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
    vi.mocked(listRepository.snapshotListItems).mockImplementation(() => {
      attempt += 1;
      // First read: Chicken is unchecked, so it would be extended. Second: checked.
      return Promise.resolve({
        items: [existingItem({ checked: attempt > 1 })],
        rankVersion: 1,
        itemVersion: attempt,
        ingredientDestinationBindings: new Map(),
        tombstonedDestinationIds: new Set<string>(),
      }) as never;
    });
    vi.mocked(tx.transactWrite).mockImplementationOnce((_items, options) => {
      // Past the create span, so this is a stale-read signal rather than a taken item id.
      throw (
        options as { onConditionFailed: (index: number) => Error }
      ).onConditionFailed(4);
    });

    const result = await run();

    expect(vi.mocked(listRepository.snapshotListItems).mock.calls).toHaveLength(2);
    expect(tx.transactWrite).toHaveBeenCalledTimes(2);
    expect(result.ingredients[0]?.outcome).toBe('created');
  });

  /**
   * The P1 raised in review: the service snapshotted the list, classified against it, and
   * then let rank allocation read `rankVersion` **again**. A create landing between the two
   * was adopted by the later read, so the condition passed and the duplicate the
   * classification existed to prevent was written anyway.
   *
   * Deterministic here: the snapshot is taken at version 1 and rank planning finds 2.
   */
  it('reclassifies rather than committing under a version it did not read', async () => {
    snapshot([], 1);
    vi.mocked(listRepository.planListItemWrites).mockImplementationOnce(() => {
      throw new listRepository.ListSnapshotStaleError();
    });

    await run();

    expect(vi.mocked(listRepository.snapshotListItems).mock.calls).toHaveLength(2);
    expect(tx.transactWrite).toHaveBeenCalledOnce();
  });

  it('asks rank allocation to commit under the exact version it snapshotted', async () => {
    vi.mocked(listRepository.snapshotListItems).mockResolvedValue({
      items: [],
      rankVersion: 7,
      itemVersion: 11,
      ingredientDestinationBindings: new Map(),
      tombstonedDestinationIds: new Set<string>(),
    });

    await run();

    expect(vi.mocked(listRepository.planListItemWrites).mock.calls[0]?.[4]).toMatchObject(
      {
        expectedRankVersion: 7,
        expectedItemVersion: 11,
      },
    );
  });

  it('gives up with the retryable conflict after three raced attempts', async () => {
    // An extension, so the create span is empty and this index is past it.
    snapshot([existingItem()]);
    vi.mocked(tx.transactWrite).mockImplementation((_items, options) => {
      throw (
        options as { onConditionFailed: (index: number) => Error }
      ).onConditionFailed(4);
    });

    await expect(run()).rejects.toMatchObject({ code: 'internal' });
    expect(tx.transactWrite).toHaveBeenCalledTimes(3);
  });

  /**
   * The one failure that must not loop: a client-minted `itm_` already taken. Re-reading
   * cannot free it, so a `503` telling the caller to retry would never come good.
   *
   * Not reachable from the ordinary replay — a row this action created is unchecked and
   * already carries this label, so the re-run classifies it as unchanged and composes no
   * create at all. What reaches here is a replay after the receipt expired onto a row the
   * user has since checked.
   */
  it('answers conflict, once, when the destination item id is already taken', async () => {
    vi.mocked(idempotencyRepository.loadReceipt).mockResolvedValue(undefined);
    vi.mocked(tx.transactWrite).mockImplementation((_items, options) => {
      throw (
        options as { onConditionFailed: (index: number) => Error }
      ).onConditionFailed(1);
    });

    await expect(
      addIngredientsToList(USER, MEAL, input(), NOW, undefined, 'key-1'),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(tx.transactWrite).toHaveBeenCalledOnce();
  });

  /**
   * DynamoDB reports only the first failing item, and the item `Put` sits before the receipt
   * — so the loser of a same-key race lands on the create slot, not on its receipt. Answering
   * `409` there would tell a caller their write failed at the moment the winner performed it.
   * A stored receipt under the key is what tells the two apart.
   */
  it('hands a same-key race back as one, so the winner’s receipt answers it', async () => {
    vi.mocked(idempotencyRepository.loadReceipt).mockResolvedValue({
      body: '{}',
    } as never);
    vi.mocked(tx.transactWrite).mockImplementation((_items, options) => {
      throw (
        options as { onConditionFailed: (index: number) => Error }
      ).onConditionFailed(1);
    });

    await expect(
      addIngredientsToList(USER, MEAL, input(), NOW, undefined, 'key-1'),
    ).rejects.toMatchObject({ name: 'IdempotencyRaceError' });
    expect(tx.transactWrite).toHaveBeenCalledOnce();
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

    const call = vi.mocked(listRepository.appendListItemCreates).mock.calls[0];
    const created = call?.[2];
    expect(created?.[0]?.itemId).toBe(ITEM_ONE);
    expect(call?.[5]?.get(ITEM_ONE)).toEqual({
      listId: LIST,
      requestedItemId: ITEM_ONE,
      itemId: ITEM_ONE,
      sourceActivityId: MEAL,
      ingredientId: CHICKEN,
      outcome: 'created',
    });
  });

  it('accepts an omitted item id and mints only when it creates a row', async () => {
    const result = await run(meal(), [{ ingredientId: CHICKEN }]);

    expect(result.ingredients[0]?.item.itemId).toBe('itm_01J8XKQ2M4N5P6R7S8T9V0W1ZZ');
    expect(listRepository.newItemId).toHaveBeenCalledOnce();
    expect(listRepository.appendIngredientDestinationBinding).not.toHaveBeenCalled();
  });

  it('needs no id at all when an unchecked row absorbs the selection', async () => {
    snapshot([existingItem()]);

    const result = await run(meal(), [{ ingredientId: CHICKEN }]);

    expect(result.ingredients[0]?.item.itemId).toBe(existingItem().itemId);
    expect(listRepository.newItemId).not.toHaveBeenCalled();
    expect(listRepository.appendIngredientDestinationBinding).not.toHaveBeenCalled();
  });

  it('stores a full 200-character unscheduled meal title as provenance', async () => {
    const undated = meal({ title: 'M'.repeat(200) });
    delete (undated as { schedule?: unknown }).schedule;

    const result = await run(undated);

    expect(result.sourceLabel).toHaveLength(200);
    expect(result.ingredients[0]?.item.sourceLabel).toHaveLength(200);
  });

  it('appends the meal title when another meal already used the label', async () => {
    snapshot([
      existingItem({
        title: 'Potatoes',
        sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1Y9',
        sourceLabel: 'Sunday dinner',
      }),
    ]);

    const result = await run();

    expect(result.sourceLabel).toBe('Sunday dinner · Chicken tacos');
  });

  it('does not split a rule-5 label when checking collisions', async () => {
    snapshot([
      existingItem({
        title: 'Potatoes',
        sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1Y9',
        sourceLabel: 'Sunday dinner · Other meal',
        sourceProvenance: [
          {
            activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1Y9',
            label: 'Sunday dinner · Other meal',
          },
        ],
      }),
    ]);

    expect((await run()).sourceLabel).toBe('Sunday dinner');
  });

  it('ignores its own earlier rows when deciding whether the label collides', async () => {
    snapshot([
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
    snapshot([existingItem()]);

    const result = await run();

    expect(result.ingredients[0]?.outcome).toBe('labelled');
    expect(listRepository.appendSourceLabelExtension).toHaveBeenCalledOnce();
    expect(
      vi.mocked(listRepository.appendListItemCreates).mock.calls[0]?.[2],
    ).toHaveLength(0);
  });

  it('matches case-insensitively, on trimmed titles', async () => {
    snapshot([existingItem({ title: '  cHiCkEn  ' })]);

    expect((await run()).ingredients[0]?.outcome).toBe('labelled');
  });

  it('creates a second row when the match is checked, because it was bought', async () => {
    snapshot([existingItem({ checked: true })]);

    const result = await run();

    expect(result.ingredients[0]?.outcome).toBe('created');
    expect(listRepository.appendSourceLabelExtension).not.toHaveBeenCalled();
  });

  it('appends to an existing label rather than replacing it', async () => {
    snapshot([
      existingItem({
        sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1Y8',
        sourceLabel: 'Thursday lunch',
      }),
    ]);

    const result = await run();

    expect(result.ingredients[0]?.item.sourceLabel).toBe(
      'Thursday lunch · Sunday dinner',
    );
    expect(result.ingredients[0]?.item.sourceProvenance).toEqual([
      {
        activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1Y8',
        label: 'Thursday lunch',
      },
      { activityId: MEAL, label: 'Sunday dinner' },
    ]);
  });

  /** A re-tap after a lost response must not read `Sunday dinner · Sunday dinner`. */
  it('writes nothing for a row that already carries this label', async () => {
    snapshot([existingItem({ sourceActivityId: MEAL, sourceLabel: 'Sunday dinner' })]);

    const result = await run();

    expect(result.ingredients[0]?.outcome).toBe('labelled');
    expect(listRepository.appendSourceLabelExtension).not.toHaveBeenCalled();
    expect(
      vi.mocked(listRepository.appendListItemCreates).mock.calls[0]?.[2],
    ).toHaveLength(0);
  });

  it('recognises this meal on a row originally owned by another meal', async () => {
    snapshot([
      existingItem({
        sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1Y8',
        sourceLabel: 'Sunday dinner · Sunday dinner · Chicken tacos',
        sourceProvenance: [
          {
            activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1Y8',
            label: 'Sunday dinner',
          },
          { activityId: MEAL, label: 'Sunday dinner · Chicken tacos' },
        ],
      }),
    ]);

    const result = await run();

    expect(result.sourceLabel).toBe('Sunday dinner · Chicken tacos');
    expect(listRepository.appendSourceLabelExtension).not.toHaveBeenCalled();
  });

  it('rejects an extension whose completed rendered label exceeds its bound', async () => {
    snapshot([
      existingItem({
        sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1Y8',
        sourceLabel: 'x'.repeat(3990),
      }),
    ]);

    await expect(run()).rejects.toMatchObject({ code: 'validation_failed' });
    expect(tx.transactWrite).not.toHaveBeenCalled();
  });

  it('compares whole segments, so a prefix is not a match', async () => {
    snapshot([
      existingItem({
        sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1Y8',
        sourceLabel: 'Sunday',
      }),
    ]);

    await run();

    expect(listRepository.appendSourceLabelExtension).toHaveBeenCalledOnce();
  });

  it('groups two identical titles onto the one matching row', async () => {
    snapshot([existingItem()]);
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

    expect(result.ingredients.map((row) => row.outcome)).toEqual([
      'labelled',
      'labelled',
    ]);
    expect(new Set(result.ingredients.map((row) => row.item.itemId))).toEqual(
      new Set([existingItem().itemId]),
    );
    expect(listRepository.appendSourceLabelExtension).toHaveBeenCalledOnce();
  });

  it('creates one row for two identical titles when neither exists', async () => {
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

    expect(result.ingredients.map((row) => row.outcome)).toEqual(['created', 'labelled']);
    expect(new Set(result.ingredients.map((row) => row.item.itemId))).toEqual(
      new Set([ITEM_ONE]),
    );
    expect(
      vi.mocked(listRepository.appendListItemCreates).mock.calls[0]?.[2],
    ).toHaveLength(1);
    expect(listRepository.appendIngredientDestinationBinding).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requestedItemId: ITEM_TWO,
        itemId: ITEM_ONE,
        ingredientId: TORTILLAS,
      }),
      NOW,
      undefined,
    );
  });

  it('persists a supplied destination id absorbed by an existing row', async () => {
    snapshot([existingItem()]);

    await run();

    expect(listRepository.appendIngredientDestinationBinding).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requestedItemId: ITEM_ONE,
        itemId: existingItem().itemId,
        ingredientId: CHICKEN,
        outcome: 'labelled',
      }),
      NOW,
      undefined,
    );
  });

  it('rejects reuse of a created destination id for another ingredient', async () => {
    const target = existingItem({ itemId: ITEM_ONE });
    snapshot(
      [target],
      1,
      new Map([
        [
          ITEM_ONE,
          {
            listId: LIST,
            requestedItemId: ITEM_ONE,
            itemId: ITEM_ONE,
            sourceActivityId: MEAL,
            ingredientId: CHICKEN,
            outcome: 'created' as const,
          },
        ],
      ]),
    );

    await expect(
      run(meal(), [{ ingredientId: TORTILLAS, itemId: ITEM_ONE }]),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(tx.transactWrite).not.toHaveBeenCalled();
  });

  it('consults a durable binding after its target is checked and renamed', async () => {
    const target = existingItem({ title: 'Bought chicken', checked: true });
    snapshot(
      [target],
      1,
      new Map([
        [
          ITEM_ONE,
          {
            listId: LIST,
            requestedItemId: ITEM_ONE,
            itemId: target.itemId,
            sourceActivityId: MEAL,
            ingredientId: CHICKEN,
            outcome: 'labelled' as const,
          },
        ],
      ]),
    );

    const result = await run();

    expect(result.ingredients[0]).toMatchObject({
      outcome: 'labelled',
      item: { itemId: target.itemId, title: 'Bought chicken', checked: true },
    });
    expect(listRepository.appendSourceLabelExtension).not.toHaveBeenCalled();
    expect(
      vi.mocked(listRepository.appendListItemCreates).mock.calls[0]?.[2],
    ).toHaveLength(0);
  });

  it('never reuses a bound id after its target was deleted', async () => {
    snapshot(
      [],
      1,
      new Map([
        [
          ITEM_ONE,
          {
            listId: LIST,
            requestedItemId: ITEM_ONE,
            itemId: existingItem().itemId,
            sourceActivityId: MEAL,
            ingredientId: CHICKEN,
            outcome: 'labelled' as const,
          },
        ],
      ]),
    );

    await expect(run()).rejects.toMatchObject({ code: 'conflict' });
    expect(tx.transactWrite).not.toHaveBeenCalled();
  });

  it('does not let a checked replay target absorb a fresh same-title ingredient', async () => {
    const target = existingItem({ title: 'Bought chicken', checked: true });
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
    snapshot(
      [target],
      1,
      new Map([
        [
          ITEM_ONE,
          {
            listId: LIST,
            requestedItemId: ITEM_ONE,
            itemId: target.itemId,
            sourceActivityId: MEAL,
            ingredientId: CHICKEN,
            outcome: 'labelled' as const,
          },
        ],
      ]),
    );

    const result = await run(twoChickens, [
      { ingredientId: CHICKEN, itemId: ITEM_ONE },
      { ingredientId: TORTILLAS, itemId: ITEM_TWO },
    ]);

    expect(result.ingredients).toMatchObject([
      { ingredientId: CHICKEN, item: { itemId: target.itemId, checked: true } },
      { ingredientId: TORTILLAS, outcome: 'created', item: { itemId: ITEM_TWO } },
    ]);
    expect(vi.mocked(listRepository.appendListItemCreates).mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({ itemId: ITEM_TWO, checked: false }),
    ]);
    expect(listRepository.appendSourceLabelExtension).not.toHaveBeenCalled();
  });
});

describe('the response', () => {
  it('reads in the order the ingredients were sent, whatever happened to each', async () => {
    snapshot([existingItem({ title: 'Tortillas (8)' })]);

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
    snapshot([existingItem()]);

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
