import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useIngredientPresence } from './useIngredientPresence';

/**
 * The web half of Option B (2026-09-16;
 * `docs/reports/destination-flow-simplification-20260916.md`): `Added` is presence on the
 * destination list, read here directly rather than through a stored meal marker.
 */

const ACTIVITY = 'act_01J0000000000000000000000A';
const LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const INGREDIENT_1 = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1';
const INGREDIENT_2 = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2';

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const LIST_VIEW = {
  schemaVersion: 2,
  listId: LIST,
  ownerId: 'usr_01J0000000000000000000000B',
  templateKey: 'groceries',
  title: 'Groceries',
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  itemStateMode: { mode: 'checkbox' },
  featureConfig: {},
  slot: 'groceries',
  itemCount: 0,
  doneCount: 0,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: '2026-09-16T12:00:00.000Z',
  lastItemActivityAt: '2026-09-16T12:00:00.000Z',
};

function stubListDetail(
  items: readonly {
    itemId: string;
    origins?: { activityId: string; ingredientId: string }[];
  }[],
) {
  const body = {
    data: {
      list: LIST_VIEW,
      items: items.map((item) => ({
        item: {
          itemId: item.itemId,
          listId: LIST,
          rank: 'a',
          title: 'An item',
          state: 'open',
          ...(item.origins === undefined ? {} : { origins: item.origins }),
        },
      })),
    },
    meta: { requestId: 'req_test' },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('useIngredientPresence (web)', () => {
  it('reads Added presence from a live item whose origins name this meal and ingredient', async () => {
    stubListDetail([
      {
        itemId: 'itm_01J000000000000000000000AA',
        origins: [{ activityId: ACTIVITY, ingredientId: INGREDIENT_1 }],
      },
    ]);
    const { result } = renderHook(() => useIngredientPresence(ACTIVITY, LIST), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.known).toBe(true));
    expect(result.current.present.has(INGREDIENT_1)).toBe(true);
    expect(result.current.present.has(INGREDIENT_2)).toBe(false);
  });

  it('offers an ingredient the destination has no live item for', async () => {
    stubListDetail([{ itemId: 'itm_01J000000000000000000000BB' }]);
    const { result } = renderHook(() => useIngredientPresence(ACTIVITY, LIST), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.known).toBe(true));
    expect(result.current.present.size).toBe(0);
  });

  it("does not mark an ingredient Added from another meal's origin", async () => {
    const otherActivity = 'act_01J0000000000000000000000B';
    stubListDetail([
      {
        itemId: 'itm_01J000000000000000000000CC',
        origins: [{ activityId: otherActivity, ingredientId: INGREDIENT_1 }],
      },
    ]);
    const { result } = renderHook(() => useIngredientPresence(ACTIVITY, LIST), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.known).toBe(true));
    expect(result.current.present.has(INGREDIENT_1)).toBe(false);
  });

  it('is unknown, never Added, and issues no request with no destination chosen', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { result } = renderHook(() => useIngredientPresence(ACTIVITY, undefined), {
      wrapper: wrapper(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toEqual({ present: new Set(), known: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
