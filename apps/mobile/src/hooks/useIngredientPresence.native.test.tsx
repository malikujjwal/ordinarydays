import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCommitRevision } from '@/lib/sqlite/commitRevision';
import type { SqliteDatabase, SqliteReader } from '@/lib/sqlite/database';
import { type ListItemRow, ListItemsRepository } from '@/lib/sqlite/listItemsRepository';
import { FOUNDATION_MIGRATIONS, runMigrations } from '@/lib/sqlite/migrations';
import type { RevisionedProjectionReader } from '@/lib/sqlite/projectionReader';
import { RepositorySubscriptions } from '@/lib/sqlite/subscriptions';
import { SerializedTransactionRunner } from '@/lib/sqlite/transaction';
import { createNodeSqliteFactory } from '../../test/node-sqlite';
import { useIngredientPresence } from './useIngredientPresence.native';

const nativeState = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('@/lib/sqlite/nativeState', () => ({
  getActiveNativeState: () => nativeState.current,
  requireActiveNativeState: () => nativeState.current,
}));

const ACTIVITY = 'act_01J0000000000000000000000A';
const LIST_A = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const LIST_B = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const INGREDIENT_1 = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1';
const INGREDIENT_2 = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2';

const item = (
  itemId: string,
  listId: string,
  overrides: Partial<ListItemRow> = {},
): ListItemRow =>
  ({
    itemId,
    listId,
    rank: 'a',
    title: `Item ${itemId.slice(-2)}`,
    state: 'open',
    ...overrides,
  }) satisfies ListItemRow;

const PAGE = { rankVersion: 1, complete: true };

describe('useIngredientPresence (native)', () => {
  let directory = '';
  let database: SqliteDatabase | undefined;
  let transactions: SerializedTransactionRunner | undefined;
  let listItems: ListItemsRepository | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ordinarydays-ingredient-presence-'));
    const opened = await createNodeSqliteFactory(directory).open('presence.sqlite');
    database = opened;
    await runMigrations(opened, FOUNDATION_MIGRATIONS);
    const subscriptions = new RepositorySubscriptions();
    transactions = new SerializedTransactionRunner(opened, subscriptions);
    const projections: RevisionedProjectionReader = {
      snapshot: <T,>(task: (reader: SqliteReader) => Promise<T>) =>
        opened.readTransaction(async (reader) => {
          const commitRevision = await readCommitRevision(reader);
          const data = await task(reader);
          return {
            data,
            commitRevision,
            source: 'reader' as const,
            metrics: { callCount: 0, durationMs: 0 },
          };
        }),
    };
    listItems = new ListItemsRepository(opened, subscriptions, projections);
    const pullListDetail = vi.fn().mockResolvedValue(undefined);
    nativeState.current = {
      listItems,
      sync: { pullListDetail, request: vi.fn() },
    };
  });

  afterEach(async () => {
    nativeState.current = undefined;
    await transactions?.shutdown();
    await database?.close();
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function seed(
    listId: string,
    rows: readonly ListItemRow[],
    page: { rankVersion: number; complete: boolean } = PAGE,
  ): Promise<void> {
    if (transactions === undefined || listItems === undefined)
      throw new Error('not ready');
    const repository = listItems;
    await transactions.run((transaction) =>
      repository.replaceFirstPage(transaction, listId, rows, page),
    );
  }

  it('reads Added for a row with a live origin match on the destination', async () => {
    await seed(LIST_A, [
      item('itm_01J000000000000000000000AA', LIST_A, {
        origins: [{ activityId: ACTIVITY, ingredientId: INGREDIENT_1 }],
      }),
    ]);
    const { result } = renderHook(() => useIngredientPresence(ACTIVITY, LIST_A));
    await waitFor(() => expect(result.current.known).toBe(true));
    expect(result.current.present.has(INGREDIENT_1)).toBe(true);
    expect(result.current.present.has(INGREDIENT_2)).toBe(false);
  });

  it('offers an ingredient with no matching origin on the destination', async () => {
    await seed(LIST_A, [item('itm_01J000000000000000000000AA', LIST_A)]);
    const { result } = renderHook(() => useIngredientPresence(ACTIVITY, LIST_A));
    await waitFor(() => expect(result.current.known).toBe(true));
    expect(result.current.present.size).toBe(0);
  });

  it('is unknown, requests `pullListDetail` (not `pullListItemPage`, which would return immediately with nothing to continue), and resolves once that pull lands', async () => {
    // `pullListDetail` is the method a real device would use to install page one
    // (`syncEngine.ts`'s fenced `installFirstItemPage`). Driving the mock through the real
    // repository write, rather than leaving it a bare stub, is what proves the hook actually
    // resolves once that read lands — a stub-only assertion would pass even if the hook asked
    // for the wrong read entirely.
    if (transactions === undefined || listItems === undefined)
      throw new Error('not ready');
    const repository = listItems;
    const runner = transactions;
    const { sync } = nativeState.current as {
      sync: { pullListDetail: ReturnType<typeof vi.fn> };
    };
    // Gated rather than resolved immediately: an ungated mock can install the row before the
    // assertion below ever observes the unknown state, which would let this test pass without
    // proving the hook actually renders unknown while nothing has landed yet.
    let releasePull: () => void = () => undefined;
    const pullGate = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    sync.pullListDetail.mockImplementation(async (listId: string) => {
      await pullGate;
      await runner.run((transaction) =>
        repository.replaceFirstPage(
          transaction,
          listId,
          [
            item('itm_01J000000000000000000000AA', listId, {
              origins: [{ activityId: ACTIVITY, ingredientId: INGREDIENT_1 }],
            }),
          ],
          PAGE,
        ),
      );
    });

    const { result } = renderHook(() => useIngredientPresence(ACTIVITY, LIST_A));

    await waitFor(() => expect(sync.pullListDetail).toHaveBeenCalledWith(LIST_A));
    expect(result.current).toEqual({ present: new Set(), known: false });

    releasePull();
    await waitFor(() => expect(result.current.known).toBe(true));
    expect(result.current.present.has(INGREDIENT_1)).toBe(true);
  });

  it('offers the ingredient again once the local projection loses the item', async () => {
    await seed(LIST_A, [
      item('itm_01J000000000000000000000AA', LIST_A, {
        origins: [{ activityId: ACTIVITY, ingredientId: INGREDIENT_1 }],
      }),
    ]);
    const { result } = renderHook(() => useIngredientPresence(ACTIVITY, LIST_A));
    await waitFor(() => expect(result.current.present.has(INGREDIENT_1)).toBe(true));

    // The delete flow's own commit ends with the same shape: the item gone, the page intact.
    await seed(LIST_A, []);

    await waitFor(() => expect(result.current.present.has(INGREDIENT_1)).toBe(false));
    expect(result.current.known).toBe(true);
  });

  it('does not mark Added from an item that lives on a different list', async () => {
    await seed(LIST_B, [
      item('itm_01J000000000000000000000BB', LIST_B, {
        origins: [{ activityId: ACTIVITY, ingredientId: INGREDIENT_1 }],
      }),
    ]);
    await seed(LIST_A, [item('itm_01J000000000000000000000AA', LIST_A)]);

    const { result } = renderHook(() => useIngredientPresence(ACTIVITY, LIST_A));
    await waitFor(() => expect(result.current.known).toBe(true));
    expect(result.current.present.has(INGREDIENT_1)).toBe(false);
  });

  it('resolves presence independently per destination, so a second list can hold the same ingredient', async () => {
    await seed(LIST_A, [
      item('itm_01J000000000000000000000AA', LIST_A, {
        origins: [{ activityId: ACTIVITY, ingredientId: INGREDIENT_1 }],
      }),
    ]);
    await seed(LIST_B, [
      item('itm_01J000000000000000000000BB', LIST_B, {
        origins: [{ activityId: ACTIVITY, ingredientId: INGREDIENT_1 }],
      }),
    ]);

    const { result, rerender } = renderHook(
      ({ listId }: { listId: string }) => useIngredientPresence(ACTIVITY, listId),
      { initialProps: { listId: LIST_A } },
    );
    await waitFor(() => expect(result.current.present.has(INGREDIENT_1)).toBe(true));

    rerender({ listId: LIST_B });
    await waitFor(() => expect(result.current.known).toBe(true));
    expect(result.current.present.has(INGREDIENT_1)).toBe(true);
  });
});
