import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ingredientPresenceKey } from '@/hooks/useIngredientPresence';
import { activityKey, LISTS_KEY } from '@/lib/queryKeys';
import { type NativeActivityState, setActiveNativeState } from '@/lib/sqlite/nativeState';
import { useAddIngredients } from './useAddIngredients';

/**
 * Device report 2026-09-11: on iOS `Add n to Groceries` wrote three times and the rows never
 * said `Added`, because the detail screen reads SQLite and this hook only invalidated React
 * Query. These cases pin the platform refresh and the single in-flight request.
 */
const mocks = vi.hoisted(() => ({
  add: vi.fn(),
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'idem-add' }));
vi.mock('@od/shared/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@od/shared/client')>();
  return { ...actual, addIngredientsToList: mocks.add };
});

const ACTIVITY = 'act_01J0000000000000000000000A';
const LIST = 'lst_01J0000000000000000000000G';
const INGREDIENT = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2';

function harness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const cleared = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () => useAddIngredients(ACTIVITY, { onSettledSelection: cleared }),
    { wrapper },
  );
  return { hook, invalidate, cleared };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.add.mockReset();
  mocks.add.mockResolvedValue({ listId: LIST, ingredients: [] });
});

afterEach(() => {
  setActiveNativeState(undefined);
});

describe('native (SQLite-backed detail)', () => {
  it('re-pulls the Activity and the destination list, then clears the selection', async () => {
    const pulled = deferred<unknown>();
    const pullActivity = vi.fn(() => pulled.promise);
    const pullListDetail = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn();
    setActiveNativeState({
      sync: { pullActivity, pullListDetail, request },
    } as unknown as NativeActivityState);
    const { hook, cleared } = harness();

    act(() => hook.result.current.mutate({ listId: LIST, ingredientIds: [INGREDIENT] }));

    await waitFor(() =>
      expect(pullActivity).toHaveBeenCalledWith({
        kind: 'activity',
        activityId: ACTIVITY,
      }),
    );
    expect(pullListDetail).toHaveBeenCalledWith(LIST);
    // Still busy, and the selection still stands, until the canonical row is installed.
    expect(hook.result.current.isPending).toBe(true);
    expect(cleared).not.toHaveBeenCalled();

    await act(async () => pulled.resolve({}));
    await waitFor(() => expect(hook.result.current.isPending).toBe(false));
    expect(cleared).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it('falls back to the engine wake when the targeted pull cannot install', async () => {
    const pullActivity = vi.fn().mockRejectedValue(new Error('deferred'));
    const request = vi.fn();
    setActiveNativeState({
      sync: { pullActivity, request },
    } as unknown as NativeActivityState);
    const { hook, cleared } = harness();

    act(() => hook.result.current.mutate({ listId: LIST, ingredientIds: [INGREDIENT] }));

    await waitFor(() => expect(cleared).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith('accepted-action');
  });
});

describe('web (React Query-backed detail)', () => {
  it('invalidates the Activity and the Lists without touching native state', async () => {
    const { hook, invalidate, cleared } = harness();

    act(() => hook.result.current.mutate({ listId: LIST, ingredientIds: [INGREDIENT] }));

    await waitFor(() => expect(cleared).toHaveBeenCalledOnce());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: activityKey(ACTIVITY) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: LISTS_KEY });
    // Option B, 2026-09-16: `Added` is `useIngredientPresence`'s read of the destination, not
    // the meal's marker, so that is the entry a successful add must invalidate.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ingredientPresenceKey(LIST) });
  });
});

describe('one request at a time', () => {
  it('drops a second tap while the first add is in flight', async () => {
    const response = deferred<unknown>();
    mocks.add.mockReturnValue(response.promise);
    const { hook, cleared } = harness();

    act(() => {
      hook.result.current.mutate({ listId: LIST, ingredientIds: [INGREDIENT] });
      hook.result.current.mutate({ listId: LIST, ingredientIds: [INGREDIENT] });
    });
    await waitFor(() => expect(hook.result.current.isPending).toBe(true));
    act(() => hook.result.current.mutate({ listId: LIST, ingredientIds: [INGREDIENT] }));
    expect(mocks.add).toHaveBeenCalledOnce();

    await act(async () => response.resolve({ listId: LIST, ingredients: [] }));
    await waitFor(() => expect(cleared).toHaveBeenCalledOnce());

    // Once settled, the next add is a new request.
    mocks.add.mockResolvedValue({ listId: LIST, ingredients: [] });
    act(() => hook.result.current.mutate({ listId: LIST, ingredientIds: [INGREDIENT] }));
    await waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(2));
  });
});
