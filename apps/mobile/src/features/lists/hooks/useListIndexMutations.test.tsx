import { ApiError, type ListPage, NetworkError } from '@od/shared/client';
import { instant } from '@od/shared/schemas';
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
import { type ListIndexMutations, useListIndexMutations } from './useListIndexMutations';

const calls = vi.hoisted(() => ({
  patch: vi.fn(),
  remove: vi.fn(),
  removeReplay: vi.fn(),
  undo: vi.fn(),
  uuid: vi.fn(),
}));

vi.mock('@od/shared/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@od/shared/client')>()),
  patchList: calls.patch,
  deleteList: calls.remove,
  deleteListForReplay: calls.removeReplay,
  undoListOperation: calls.undo,
}));

vi.mock('expo-crypto', () => ({ randomUUID: calls.uuid }));

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
  updatedAt: instant.parse('2026-08-26T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-26T08:00:00.000Z'),
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

function retryCurrentToast(): void {
  const current = useToast.getState().current;
  if (current?.kind !== 'message' || current.action === undefined) {
    throw new Error('Expected a retryable message toast.');
  }
  current.action.onPress();
}

beforeEach(() => {
  calls.patch.mockReset();
  calls.remove.mockReset();
  calls.removeReplay.mockReset();
  calls.undo.mockReset();
  calls.uuid.mockReset();
  calls.uuid.mockReturnValue('idem-list-index');
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

  it.each([
    ['archive', (actions: ListIndexMutations) => actions.onArchive(LIST)],
    [
      'restore',
      (actions: ListIndexMutations) => actions.onRestore({ ...LIST, archived: true }),
    ],
  ] as const)(
    'retries %s with the original idempotency identity',
    async (_name, actOn) => {
      calls.uuid.mockReturnValueOnce('forward-identity').mockReturnValue('new-identity');
      calls.patch
        .mockRejectedValueOnce(
          new ApiError('internal', 'No response.', 500, 'req_list_mutation'),
        )
        .mockResolvedValueOnce({ list: LIST });
      const mounted = setup();

      act(() => actOn(mounted.result.current));
      await waitFor(() =>
        expect(useToast.getState().current).toMatchObject({
          requestId: 'req_list_mutation',
          action: { label: 'Retry' },
        }),
      );

      act(retryCurrentToast);
      await waitFor(() => expect(calls.patch).toHaveBeenCalledTimes(2));

      expect(calls.patch.mock.calls.map((call) => call[4])).toEqual([
        'forward-identity',
        'forward-identity',
      ]);
      expect(calls.uuid).toHaveBeenCalledOnce();
    },
  );

  it('retries delete as replay of the same list identity', async () => {
    calls.remove.mockRejectedValueOnce(
      new ApiError('internal', 'No response.', 500, 'req_delete_list'),
    );
    calls.removeReplay.mockResolvedValueOnce({ listId: LIST.listId });
    const mounted = setup();

    act(() => mounted.result.current.onDelete(LIST));
    await waitFor(() =>
      expect(useToast.getState().current).toMatchObject({
        requestId: 'req_delete_list',
        action: { label: 'Retry' },
      }),
    );

    act(retryCurrentToast);
    await waitFor(() => expect(calls.removeReplay).toHaveBeenCalledOnce());
    expect(calls.remove.mock.calls[0]?.[1]).toBe(LIST.listId);
    expect(calls.removeReplay.mock.calls[0]?.[1]).toBe(LIST.listId);
  });

  it('offers Retry for a transport failure without inventing a request id', async () => {
    calls.patch.mockRejectedValueOnce(
      new NetworkError('The network request failed.', new Error('offline')),
    );
    const mounted = setup();

    act(() => mounted.result.current.onArchive(LIST));
    await waitFor(() =>
      expect(useToast.getState().current).toMatchObject({
        action: { label: 'Retry' },
      }),
    );
    expect(useToast.getState().current).not.toHaveProperty('requestId');
  });

  it('renders the rate-limit delay instead of a generic mutation failure', async () => {
    calls.patch.mockRejectedValueOnce(
      new ApiError(
        'rate_limited',
        'Too many requests.',
        429,
        'req_rate_limit',
        undefined,
        30,
      ),
    );
    const mounted = setup();

    act(() => mounted.result.current.onRestore({ ...LIST, archived: true }));
    await waitFor(() =>
      expect(useToast.getState().current).toMatchObject({
        message: 'Too many requests. Try again in 30 seconds.',
        requestId: 'req_rate_limit',
      }),
    );
    expect(useToast.getState().current).not.toHaveProperty('action');
  });

  it('uses the required forbidden copy and does not offer Retry', async () => {
    calls.patch.mockRejectedValueOnce(
      new ApiError('forbidden', 'Server wording.', 403, 'req_forbidden'),
    );
    const mounted = setup();

    act(() => mounted.result.current.onArchive(LIST));

    await waitFor(() =>
      expect(useToast.getState().current).toMatchObject({
        message: 'Only the person who made this plan can change that.',
        requestId: 'req_forbidden',
      }),
    );
    expect(useToast.getState().current).not.toHaveProperty('action');
    expect(cached(mounted.client)).toEqual([LIST]);
  });

  it('removes a missing row and uses the required not-found copy', async () => {
    calls.patch.mockRejectedValueOnce(
      new ApiError('not_found', 'Server wording.', 404, 'req_not_found'),
    );
    const mounted = setup();

    act(() => mounted.result.current.onArchive(LIST));

    await waitFor(() =>
      expect(useToast.getState().current).toMatchObject({
        message: "This isn't here any more.",
        requestId: 'req_not_found',
      }),
    );
    expect(useToast.getState().current).not.toHaveProperty('action');
    expect(cached(mounted.client)).toEqual([]);
  });

  it('retries Undo with its original inverse identity and preserves the request id', async () => {
    calls.uuid
      .mockReturnValueOnce('archive-identity')
      .mockReturnValueOnce('inverse-identity')
      .mockReturnValue('new-identity');
    calls.patch.mockResolvedValueOnce({
      list: { ...LIST, archived: true },
      undoToken: 'undo-token',
      undoExpiresAt: '2999-08-26T10:00:06.000Z',
    });
    calls.undo
      .mockRejectedValueOnce(
        new ApiError('internal', 'No response.', 500, 'req_undo_list'),
      )
      .mockResolvedValueOnce({
        data: { outcome: 'applied', affectedCount: 1 },
        meta: { requestId: 'req_undo_replay' },
      });
    const mounted = setup();

    act(() => mounted.result.current.onArchive(LIST));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));
    act(() => useToast.getState().undo());
    await waitFor(() =>
      expect(useToast.getState().current).toMatchObject({
        requestId: 'req_undo_list',
        action: { label: 'Retry' },
      }),
    );

    act(retryCurrentToast);
    await waitFor(() => expect(calls.undo).toHaveBeenCalledTimes(2));
    expect(calls.undo.mock.calls.map((call) => call[3])).toEqual([
      'inverse-identity',
      'inverse-identity',
    ]);
    expect(calls.uuid).toHaveBeenCalledTimes(2);
  });

  it('shows the successful response request id when Undo is no longer applicable', async () => {
    calls.patch.mockResolvedValueOnce({
      list: { ...LIST, archived: true },
      undoToken: 'undo-token',
      undoExpiresAt: '2999-08-26T10:00:06.000Z',
    });
    calls.undo.mockResolvedValueOnce({
      data: { outcome: 'no_longer_applicable' },
      meta: { requestId: 'req_semantic_undo' },
    });
    const mounted = setup();

    act(() => mounted.result.current.onArchive(LIST));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));
    act(() => useToast.getState().undo());

    await waitFor(() =>
      expect(useToast.getState().current).toMatchObject({
        message: `Couldn't undo archiving "${LIST.title}."`,
        requestId: 'req_semantic_undo',
      }),
    );
  });

  it('removes a row when Undo learns that the list is missing', async () => {
    calls.patch.mockResolvedValueOnce({
      list: { ...LIST, archived: true },
      undoToken: 'undo-token',
      undoExpiresAt: '2999-08-26T10:00:06.000Z',
    });
    calls.undo.mockRejectedValueOnce(
      new ApiError('not_found', 'Server wording.', 404, 'req_undo_missing'),
    );
    const mounted = setup();

    act(() => mounted.result.current.onArchive(LIST));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));
    act(() => useToast.getState().undo());

    await waitFor(() => expect(cached(mounted.client)).toEqual([]));
    expect(useToast.getState().current).toMatchObject({
      message: "This isn't here any more.",
      requestId: 'req_undo_missing',
    });
    expect(useToast.getState().current).not.toHaveProperty('action');
  });

  it.each(['restore', 'delete'] as const)(
    'commits the previous Undo as soon as %s is accepted',
    (actionName) => {
      const onCommit = vi.fn();
      useToast.getState().showUndo({
        message: 'Previous action',
        onUndo: vi.fn(),
        onCommit,
      });
      calls.patch.mockReturnValue(new Promise(() => undefined));
      calls.remove.mockReturnValue(new Promise(() => undefined));
      const mounted = setup([{ ...LIST, archived: true }]);

      act(() =>
        actionName === 'restore'
          ? mounted.result.current.onRestore({ ...LIST, archived: true })
          : mounted.result.current.onDelete(LIST),
      );

      expect(onCommit).toHaveBeenCalledOnce();
    },
  );
});
