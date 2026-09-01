import { ApiError } from '@od/shared/client';
import type { ActivityUpdate } from '@od/shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerActivityMutationDefaults } from '@/lib/mutationDefaults';
import { activityUpdateMutationKeys } from '@/lib/mutationKeys';
import { activityUpdatesKey } from './keys';
import { useActivityUpdates } from './useActivityUpdates';

const clients = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  remove: vi.fn(),
  uuid: vi.fn(),
}));

vi.mock('@od/shared/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@od/shared/client')>()),
  getActivityUpdates: clients.get,
  postActivityUpdate: clients.post,
  deleteActivityUpdate: clients.remove,
}));
vi.mock('expo-crypto', () => ({ randomUUID: clients.uuid }));

const ACTIVITY = 'act_01J0000000000000000000000A';

function update(index: number): ActivityUpdate {
  return {
    updateId: `upd_01J0000000000000000000P${50 + index}`,
    activityId: ACTIVITY,
    kind: 'user',
    authorUserId: 'usr_01J0000000000000000000000B',
    body: `Note ${index}`,
    createdAt: `2026-08-1${index}T10:00:00.000Z`,
    schemaVersion: 1,
  };
}

function wrapper(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function queryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  registerActivityMutationDefaults(client, {} as never);
  return client;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  clients.get.mockReset();
  clients.post.mockReset();
  clients.remove.mockReset();
  clients.uuid.mockReset();
});

describe('useActivityUpdates web query ownership', () => {
  it('keeps an acknowledged deletion in the query cache across remounts', async () => {
    const client = queryClient();
    const stale = update(1);
    clients.remove.mockResolvedValue({ updateId: stale.updateId });
    const first = renderHook(
      () => useActivityUpdates(ACTIVITY, { updates: [stale], cursor: undefined }),
      { wrapper: wrapper(client) },
    );

    await act(async () => {
      expect(await first.result.current.remove(stale)).toBe(true);
    });
    await waitFor(() => expect(first.result.current.updates).toEqual([]));
    first.unmount();

    const remounted = renderHook(
      () => useActivityUpdates(ACTIVITY, { updates: [stale], cursor: undefined }),
      { wrapper: wrapper(client) },
    );
    expect(remounted.result.current.updates).toEqual([]);
  });

  it('calls the shared client once when transport ultimately fails and rolls back the pending post', async () => {
    const client = queryClient();
    clients.uuid.mockReturnValueOnce('local-id').mockReturnValueOnce('stable-idem');
    const response = deferred<never>();
    clients.post.mockReturnValue(response.promise);
    const mounted = renderHook(
      () => useActivityUpdates(ACTIVITY, { updates: [], cursor: undefined }),
      { wrapper: wrapper(client) },
    );

    let outcome!: Promise<boolean>;
    act(() => {
      outcome = mounted.result.current.post(' Note 2 ');
    });
    await waitFor(() =>
      expect(mounted.result.current.pending).toEqual([
        { localId: 'local-id', body: 'Note 2' },
      ]),
    );
    response.reject(new TypeError('network unavailable'));
    await act(async () => expect(await outcome).toBe(false));

    expect(clients.post).toHaveBeenCalledTimes(1);
    expect(clients.post.mock.calls[0]?.[3]).toBe('stable-idem');
    expect(mounted.result.current.pending).toEqual([]);
    expect(mounted.result.current.updates).toEqual([]);
    expect(mounted.result.current.errorMessage).toBe("Couldn't post this update.");
    expect(mounted.result.current.errorAction).toBe('post');
  });

  it('reuses the accepted post idempotency key for an explicit retry', async () => {
    const client = queryClient();
    const posted = update(2);
    const embedded = { updates: [] as readonly ActivityUpdate[], cursor: undefined };
    clients.uuid.mockReturnValueOnce('local-id').mockReturnValueOnce('stable-idem');
    clients.post
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce({ update: posted, lastActivityAt: posted.createdAt });
    const mounted = renderHook(() => useActivityUpdates(ACTIVITY, embedded), {
      wrapper: wrapper(client),
    });

    await act(async () =>
      expect(await mounted.result.current.post('Note 2')).toBe(false),
    );
    expect(mounted.result.current.errorAction).toBe('post');

    await act(async () => {
      await mounted.result.current.retryFailure();
    });
    await waitFor(() => expect(clients.post).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mounted.result.current.updates).toEqual([posted]));

    expect(clients.post.mock.calls.map((call) => call[3])).toEqual([
      'stable-idem',
      'stable-idem',
    ]);
    expect(clients.uuid).toHaveBeenCalledTimes(2);
  });

  it('restores the exact delete snapshot and preserves the server request id', async () => {
    const client = queryClient();
    const first = update(1);
    const second = update(2);
    const response = deferred<never>();
    clients.remove.mockReturnValue(response.promise);
    const mounted = renderHook(
      () =>
        useActivityUpdates(ACTIVITY, {
          updates: [first, second],
          cursor: undefined,
        }),
      { wrapper: wrapper(client) },
    );

    let outcome!: Promise<boolean>;
    act(() => {
      outcome = mounted.result.current.remove(first);
    });
    await waitFor(() => expect(mounted.result.current.updates).toEqual([second]));
    response.reject(
      new ApiError('internal', 'database detail', 503, 'req_delete_update'),
    );
    await act(async () => expect(await outcome).toBe(false));

    expect(mounted.result.current.updates).toEqual([second, first]);
    expect(mounted.result.current.errorMessage).toBe('Something went wrong.');
    expect(mounted.result.current.errorRequestId).toBe('req_delete_update');
    expect(mounted.result.current.errorAction).toBe('delete');
    expect(clients.remove).toHaveBeenCalledTimes(1);
  });

  it('reconciles a newer embedded head without discarding an acknowledged local post', async () => {
    const client = queryClient();
    const stale = update(1);
    const newer = update(2);
    const local = update(3);
    clients.uuid.mockReturnValueOnce('local-id').mockReturnValueOnce('stable-idem');
    clients.post.mockResolvedValue({ update: local, lastActivityAt: local.createdAt });
    const mounted = renderHook(({ embedded }) => useActivityUpdates(ACTIVITY, embedded), {
      initialProps: { embedded: { updates: [stale], cursor: 'cur_stale' } },
      wrapper: wrapper(client),
    });

    mounted.rerender({ embedded: { updates: [newer], cursor: 'cur_new' } });
    await waitFor(() => expect(mounted.result.current.updates).toEqual([newer]));
    expect(mounted.result.current.cursor).toBe('cur_new');

    await act(async () => {
      expect(await mounted.result.current.post('Note 3')).toBe(true);
    });
    mounted.rerender({ embedded: { updates: [newer], cursor: 'cur_newer' } });
    await waitFor(() => expect(mounted.result.current.updates).toEqual([local, newer]));
    expect(mounted.result.current.cursor).toBe('cur_newer');
  });

  it('drops remotely deleted older entries when an authoritative head starts a new chain', async () => {
    const client = queryClient();
    const firstHead = update(3);
    const remotelyDeletedOlder = update(1);
    const refreshedHead = update(4);
    clients.get
      .mockResolvedValueOnce({ updates: [remotelyDeletedOlder], cursor: 'cur_tail' })
      .mockResolvedValueOnce({ updates: [], cursor: undefined });
    const mounted = renderHook(({ embedded }) => useActivityUpdates(ACTIVITY, embedded), {
      initialProps: { embedded: { updates: [firstHead], cursor: 'cur_old' } },
      wrapper: wrapper(client),
    });

    act(() => mounted.result.current.loadMore());
    await waitFor(() =>
      expect(mounted.result.current.updates).toEqual([firstHead, remotelyDeletedOlder]),
    );

    mounted.rerender({
      embedded: { updates: [refreshedHead], cursor: 'cur_refreshed' },
    });
    await waitFor(() => expect(mounted.result.current.updates).toEqual([refreshedHead]));

    act(() => mounted.result.current.loadMore());
    await waitFor(() => expect(clients.get).toHaveBeenCalledTimes(2));
    expect(mounted.result.current.updates).toEqual([refreshedHead]);
  });

  it('retires an acknowledged post when a later complete strong feed omits it', async () => {
    const client = queryClient();
    const firstHead = update(1);
    const refreshedHead = update(4);
    const locallyAcknowledged = update(3);
    clients.uuid.mockReturnValueOnce('local-id').mockReturnValueOnce('stable-idem');
    clients.post.mockResolvedValue({
      update: locallyAcknowledged,
      lastActivityAt: locallyAcknowledged.createdAt,
    });
    clients.get.mockResolvedValue({ updates: [], cursor: undefined });
    const mounted = renderHook(({ embedded }) => useActivityUpdates(ACTIVITY, embedded), {
      initialProps: { embedded: { updates: [firstHead], cursor: 'cur_old' } },
      wrapper: wrapper(client),
    });

    await act(async () => {
      expect(await mounted.result.current.post('Note 3')).toBe(true);
    });
    expect(mounted.result.current.updates).toContainEqual(locallyAcknowledged);

    mounted.rerender({
      embedded: { updates: [refreshedHead], cursor: 'cur_refreshed' },
    });
    await waitFor(() =>
      expect(mounted.result.current.updates).toEqual([
        refreshedHead,
        locallyAcknowledged,
      ]),
    );
    act(() => mounted.result.current.loadMore());
    await waitFor(() => expect(clients.get).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(client.getQueryData(activityUpdatesKey(ACTIVITY))).toMatchObject({
        cursor: undefined,
      }),
    );
    await waitFor(() => expect(mounted.result.current.cursor).toBeUndefined());
    expect(mounted.result.current.updates).toEqual([refreshedHead]);
  });

  it('uses the registered mutation-key recipe as the post request owner', async () => {
    const client = queryClient();
    const posted = update(2);
    const embedded = { updates: [] as readonly ActivityUpdate[], cursor: undefined };
    const registeredRecipe = vi.fn().mockResolvedValue({
      update: posted,
      lastActivityAt: posted.createdAt,
    });
    client.setMutationDefaults(activityUpdateMutationKeys.post, {
      mutationFn: registeredRecipe,
    });
    clients.uuid.mockReturnValueOnce('local-id').mockReturnValueOnce('stable-idem');
    const mounted = renderHook(() => useActivityUpdates(ACTIVITY, embedded), {
      wrapper: wrapper(client),
    });

    await act(async () => expect(await mounted.result.current.post('Note 2')).toBe(true));

    expect(registeredRecipe.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        activityId: ACTIVITY,
        body: 'Note 2',
        idempotencyKey: 'stable-idem',
      }),
    );
    expect(clients.post).not.toHaveBeenCalled();
  });

  it('preserves page failure details for an action-specific retry', async () => {
    const client = queryClient();
    clients.get.mockRejectedValue(
      new ApiError('internal', 'database detail', 503, 'req_updates_page'),
    );
    const mounted = renderHook(
      () => useActivityUpdates(ACTIVITY, { updates: [], cursor: 'cur_1' }),
      { wrapper: wrapper(client) },
    );

    act(() => mounted.result.current.loadMore());
    await waitFor(() => expect(mounted.result.current.errorAction).toBe('load'));
    expect(mounted.result.current.errorMessage).toBe('Something went wrong.');
    expect(mounted.result.current.errorRequestId).toBe('req_updates_page');
    expect(clients.get).toHaveBeenCalledTimes(1);
  });
});
