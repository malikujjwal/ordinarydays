import type { Activity, List, ListItem } from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../lib/errors.js';
import { addIngredientsToList } from './ingredientsToListService.js';

/**
 * What this service decides, with the repositories mocked (`definition-of-done.md` §3).
 *
 * The pure rules are proved in `packages/shared/src/lists/__tests__` and the writes against a
 * real table in `test/integration/ingredientsToList.int.test.ts`. What is left here is the
 * service's own reasoning: what it refuses and in which order, which of the three write steps
 * it runs for a given classification, and what it never does twice.
 */
vi.mock('../repositories/activityRepository.js', () => ({
  recordIngredientsAddedToList: vi.fn(),
}));
vi.mock('../repositories/idempotencyRepository.js', () => ({
  writeReceiptOnly: vi.fn(),
}));
vi.mock('../repositories/listRepository.js', () => ({
  createListItems: vi.fn(),
  extendItemSourceLabel: vi.fn(),
  getListMeta: vi.fn(),
  ListFullError: class extends Error {},
  ListMutationRetryExhaustedError: class extends Error {},
  ListNotFoundError: class extends Error {},
  ListRankRepairRequiredError: class extends Error {},
  ListReadFenceError: class extends Error {},
  newItemId: vi.fn(() => 'itm_01J8XKQ2M4N5P6R7S8T9V0W1Z9'),
  readAllListItems: vi.fn(),
}));
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
const authz = await import('./authz.js');

const USER = 'usr_local_dev';
const MEAL = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const CHICKEN = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1';
const TORTILLAS = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2';
/** A Sunday, seven days after `NOW`, so §7.5 rule 1 applies. */
const NOW = '2026-08-18T09:00:00.000Z';
const SUNDAY = '2026-08-23';

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
    createdAt: NOW,
    lastActivityAt: NOW,
    updatedAt: NOW,
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
  itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1B1',
  listId: LIST,
  rank: 'n',
  itemRevision: 2,
  title: 'Chicken',
  checked: false,
  ...overrides,
});

const input = (ingredientIds: readonly string[] = [CHICKEN]) =>
  ({
    listId: LIST,
    ingredients: ingredientIds.map((ingredientId) => ({ ingredientId })),
  }) as never;

const run = (activity = meal(), ingredientIds?: readonly string[]) => {
  vi.mocked(authz.assertActivityAccess).mockResolvedValue({ activity } as never);
  return addIngredientsToList(USER, MEAL, input(ingredientIds), NOW);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authz.assertActivityAccess).mockResolvedValue({ activity: meal() } as never);
  vi.mocked(authz.assertListAccess).mockResolvedValue({
    index: { grant: true },
  } as never);
  vi.mocked(listRepository.getListMeta).mockResolvedValue(list());
  vi.mocked(listRepository.readAllListItems).mockResolvedValue([]);
  vi.mocked(listRepository.createListItems).mockImplementation(
    (_u, listId, _a, items) =>
      Promise.resolve(
        items.map((item, index) => ({
          ...item,
          listId,
          rank: `n${String(index)}`,
          itemRevision: 0,
        })),
      ) as never,
  );
  vi.mocked(listRepository.extendItemSourceLabel).mockImplementation(
    (_u, _l, _a, item, segment) =>
      Promise.resolve({
        ...item,
        sourceLabel:
          item.sourceLabel === undefined ? segment : `${item.sourceLabel} · ${segment}`,
      }) as never,
  );
});

/** What `createListItems` was handed, which is what the transaction will write. */
const created = () => vi.mocked(listRepository.createListItems).mock.calls[0]?.[3] ?? [];

describe('what it refuses, before it writes anything', () => {
  it('rejects an activity that is not a meal', async () => {
    await expect(
      run(meal({ type: 'event', details: { kind: 'event' } })),
    ).rejects.toThrow(AppError);
    expect(listRepository.createListItems).not.toHaveBeenCalled();
  });

  /**
   * A `watch` or `meals` list requires typed `details` on every item, and an ingredient has
   * none to give — the row would be rejected by the list's own renderer.
   */
  it.each(['watch', 'meals'] as const)('rejects a %s destination', async (behaviour) => {
    vi.mocked(listRepository.getListMeta).mockResolvedValue(list({ behaviour }));

    await expect(run()).rejects.toThrow(AppError);
    expect(listRepository.createListItems).not.toHaveBeenCalled();
  });

  it('rejects an ingredient id the meal no longer has, and writes nothing at all', async () => {
    await expect(run(meal(), ['ing_01J8XKQ2M4N5P6R7S8T9V0W1C9'])).rejects.toThrow(
      AppError,
    );

    expect(listRepository.createListItems).not.toHaveBeenCalled();
    expect(listRepository.extendItemSourceLabel).not.toHaveBeenCalled();
    expect(activityRepository.recordIngredientsAddedToList).not.toHaveBeenCalled();
  });

  /**
   * One id twice is not something the picker can produce, so it is a client that has lost
   * track of which row is which — and guessing which of the two it meant is not this
   * service's to do.
   */
  it('rejects the same ingredient selected twice', async () => {
    await expect(run(meal(), [CHICKEN, CHICKEN])).rejects.toThrow(AppError);
    expect(listRepository.createListItems).not.toHaveBeenCalled();
  });

  it('rejects a meal whose ingredients are absent entirely', async () => {
    await expect(
      run(meal({ details: { kind: 'meal', mealSlot: 'dinner' } })),
    ).rejects.toThrow(AppError);
  });

  it('refuses to overflow the list, before attempting the write', async () => {
    vi.mocked(listRepository.getListMeta).mockResolvedValue(list({ itemCount: 500 }));

    await expect(run()).rejects.toThrow(AppError);
    expect(listRepository.createListItems).not.toHaveBeenCalled();
  });

  it('checks the meal before the list, so a stranger learns nothing about either', async () => {
    vi.mocked(authz.assertActivityAccess).mockRejectedValue(
      new AppError('not_found', 'Activity not found.'),
    );

    // Called directly rather than through `run`, which re-arms the access mock it is
    // exactly this test's business to leave rejecting.
    await expect(addIngredientsToList(USER, MEAL, input(), NOW)).rejects.toThrow(
      AppError,
    );
    expect(authz.assertListAccess).not.toHaveBeenCalled();
  });
});

describe('what it derives, and what it refuses to be told', () => {
  it('sets the title, the source activity and the label server-side', async () => {
    await run(meal(), [CHICKEN, TORTILLAS]);

    expect(created()).toEqual([
      expect.objectContaining({
        title: 'Chicken',
        sourceActivityId: MEAL,
        sourceLabel: 'Sunday dinner',
        checked: false,
      }),
      expect.objectContaining({ title: 'Tortillas (8)', sourceLabel: 'Sunday dinner' }),
    ]);
  });

  it('never resolves a slot: the destination is the one the request named', async () => {
    await run();

    expect(vi.mocked(listRepository.createListItems).mock.calls[0]?.[1]).toBe(LIST);
  });

  it('appends the meal title when another meal already used the label', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([
      existingItem({
        itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1B2',
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
        itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1B3',
        title: 'Tomatoes',
        sourceActivityId: MEAL,
        sourceLabel: 'Sunday dinner',
      }),
    ]);

    const result = await run();

    expect(result.sourceLabel).toBe('Sunday dinner');
  });

  it('ignores a hand-added row, which carries no label to collide with', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([
      existingItem({ itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1B4', title: 'Milk' }),
    ]);

    const result = await run();

    expect(result.sourceLabel).toBe('Sunday dinner');
  });

  it('uses the meal title for an unscheduled meal', async () => {
    const undated = meal();
    delete (undated as { schedule?: unknown }).schedule;

    const result = await run(undated);

    expect(result.sourceLabel).toBe('Chicken tacos');
  });
});

describe('the duplicate rule chooses which write runs', () => {
  it('creates when nothing matches', async () => {
    const result = await run();

    expect(result.ingredients[0]?.outcome).toBe('created');
    expect(listRepository.extendItemSourceLabel).not.toHaveBeenCalled();
  });

  it('extends and creates nothing when an unchecked row matches', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([existingItem()]);

    const result = await run();

    expect(result.ingredients[0]?.outcome).toBe('labelled');
    expect(listRepository.extendItemSourceLabel).toHaveBeenCalledOnce();
    expect(listRepository.createListItems).not.toHaveBeenCalled();
  });

  it('matches case-insensitively, on trimmed titles', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([
      existingItem({ title: '  cHiCkEn  ' }),
    ]);

    const result = await run();

    expect(result.ingredients[0]?.outcome).toBe('labelled');
  });

  it('creates a second row when the match is checked, because it was bought', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([
      existingItem({ checked: true }),
    ]);

    const result = await run();

    expect(result.ingredients[0]?.outcome).toBe('created');
    expect(listRepository.extendItemSourceLabel).not.toHaveBeenCalled();
  });

  /**
   * The guard that makes step 1 replayable. Without it a retried action turns
   * `Sunday dinner` into `Sunday dinner · Sunday dinner`.
   */
  it('does not append a segment the row already carries', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([
      existingItem({ sourceActivityId: MEAL, sourceLabel: 'Sunday dinner' }),
    ]);

    const result = await run();

    expect(result.ingredients[0]?.outcome).toBe('labelled');
    expect(listRepository.extendItemSourceLabel).not.toHaveBeenCalled();
  });

  it('compares whole segments, so a prefix is not a match', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([
      existingItem({
        sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1Y8',
        sourceLabel: 'Sunday',
      }),
    ]);

    await run();

    expect(listRepository.extendItemSourceLabel).toHaveBeenCalledOnce();
  });

  it('lets only the first of two identical titles claim the one matching row', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([
      existingItem({ title: 'Chicken' }),
    ]);
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

    const result = await run(twoChickens, [CHICKEN, TORTILLAS]);

    expect(result.ingredients.map((row) => row.outcome)).toEqual(['labelled', 'created']);
  });
});

describe('the write-back', () => {
  it('names every selected row by id and by its current index', async () => {
    await run(meal(), [TORTILLAS]);

    expect(activityRepository.recordIngredientsAddedToList).toHaveBeenCalledWith(
      MEAL,
      LIST,
      [{ index: 1, ingredientId: TORTILLAS }],
    );
  });

  it('records a deduplicated ingredient too: the user did add it to that list', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([existingItem()]);

    await run();

    expect(activityRepository.recordIngredientsAddedToList).toHaveBeenCalledWith(
      MEAL,
      LIST,
      [{ index: 0, ingredientId: CHICKEN }],
    );
  });

  /** Step 3 is after the commit point, so it must never run before the rows exist. */
  it('runs after the creates, not before', async () => {
    const order: string[] = [];
    vi.mocked(listRepository.createListItems).mockImplementation(
      (_u, listId, _a, items) => {
        order.push('create');
        return Promise.resolve(
          items.map((item) => ({ ...item, listId, rank: 'n', itemRevision: 0 })),
        ) as never;
      },
    );
    vi.mocked(activityRepository.recordIngredientsAddedToList).mockImplementation(() => {
      order.push('record');
      return Promise.resolve();
    });

    await run();

    expect(order).toEqual(['create', 'record']);
  });
});

describe('the response', () => {
  it('reads in the order the ingredients were sent, whatever happened to each', async () => {
    vi.mocked(listRepository.readAllListItems).mockResolvedValue([
      existingItem({ title: 'Tortillas (8)' }),
    ]);

    const result = await run(meal(), [TORTILLAS, CHICKEN]);

    expect(result.ingredients.map((row) => row.ingredientId)).toEqual([
      TORTILLAS,
      CHICKEN,
    ]);
    expect(result.ingredients.map((row) => row.outcome)).toEqual(['labelled', 'created']);
  });

  it('carries the destination and the one label the operation used', async () => {
    const result = await run();

    expect(result.listId).toBe(LIST);
    expect(result.sourceLabel).toBe('Sunday dinner');
  });
});
