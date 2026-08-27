import type { ListPage } from '@od/shared/client';
import type { List } from '@od/shared/types';
import {
  type InfiniteData,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '@/stores/toast';
import { LISTS_KEY } from './keys';
import { useListIndexMutations } from './useListIndexMutations';

const calls = vi.hoisted(() => ({
  patch: vi.fn(),
  remove: vi.fn(),
  undo: vi.fn(),
}));

vi.mock('@od/shared/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@od/shared/client')>()),
  patchList: calls.patch,
  deleteList: calls.remove,
  undoListOperation: calls.undo,
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'idem-list-index' }));

const LIST: List = {
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0ABC',
  ownerId: 'usr_local_dev',
  behaviour: 'collection',
  templateKey: 'groceries',
  title: 'Groceries',
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  capabilities: { checkable: true, supportsLocation: false },
  slot: 'groceries',
  itemCount: 3,
  uncheckedCount: 2,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: '2026-08-26T09:00:00.000Z',
  lastItemActivityAt: '2026-08-26T08:00:00.000Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function setup(lists: readonly List[] = [LIST]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const data: InfiniteData<ListPage> = {
    pages: [{ data: [...lists], meta: { requestId: 'req_lists' } }],
    pageParams: [undefined],
  };
  client.setQueryData(LISTS_KEY, data);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    ...renderHook(() => useListIndexMutations(), { wrapper }),
    client,
  };
}

function cached(client: QueryClient): ListPage['data'] {
  return (
    client
      .getQueryData<InfiniteData<ListPage>>(LISTS_KEY)
      ?.pages.flatMap((page) => page.data) ?? []
  );
}

beforeEach(() => {
  calls.patch.mockReset();
  calls.remove.mockReset();
  calls.undo.mockReset();
  useToast.setState({ current: undefined });
});

describe('web List index mutations', () => {
  it('archives immediately and restores the exact cache when the request fails', async () => {
    const pending = deferred<never>();
    calls.patch.mockReturnValue(pending.promise);
    const mounted = setup();

    act(() => mounted.result.current.onArchive(LIST));

    await waitFor(() => expect(cached(mounted.client)[0]?.archived).toBe(true));
    expect(calls.patch).toHaveBeenCalledOnce();

    pending.reject(new Error('offline'));
    await waitFor(() => expect(cached(mounted.client)).toEqual([LIST]));
  });

  it('restores an archived row immediately while the request is still pending', async () => {
    const archived = { ...LIST, archived: true };
    const pending = deferred<never>();
    calls.patch.mockReturnValue(pending.promise);
    const mounted = setup([archived]);

    act(() => mounted.result.current.onRestore(archived));

    await waitFor(() => expect(cached(mounted.client)[0]?.archived).toBe(false));
    expect(calls.patch).toHaveBeenCalledOnce();

    pending.reject(new Error('offline'));
    await waitFor(() => expect(cached(mounted.client)).toEqual([archived]));
  });

  it('deletes immediately and puts the row back at its prior position on failure', async () => {
    const pending = deferred<never>();
    calls.remove.mockReturnValue(pending.promise);
    const mounted = setup();

    act(() => mounted.result.current.onDelete(LIST));

    await waitFor(() => expect(cached(mounted.client)).toEqual([]));
    expect(calls.remove).toHaveBeenCalledOnce();

    pending.reject(new Error('offline'));
    await waitFor(() => expect(cached(mounted.client)).toEqual([LIST]));
  });

  it('does not roll back a later optimistic change to another list', async () => {
    const second = {
      ...LIST,
      listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0DEF',
      title: 'Packing',
      slot: null,
    };
    const deletePending = deferred<never>();
    const archivePending = deferred<never>();
    calls.remove.mockReturnValue(deletePending.promise);
    calls.patch.mockReturnValue(archivePending.promise);
    const mounted = setup([LIST, second]);

    act(() => mounted.result.current.onDelete(LIST));
    await waitFor(() => expect(cached(mounted.client)).toEqual([second]));

    act(() => mounted.result.current.onArchive(second));
    await waitFor(() => expect(cached(mounted.client)[0]?.archived).toBe(true));

    deletePending.reject(new Error('offline'));
    await waitFor(() =>
      expect(cached(mounted.client)).toEqual([LIST, { ...second, archived: true }]),
    );

    archivePending.reject(new Error('offline'));
    await waitFor(() => expect(cached(mounted.client)).toEqual([LIST, second]));
  });
});
