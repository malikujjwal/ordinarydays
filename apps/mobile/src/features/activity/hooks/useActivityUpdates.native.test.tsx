import { ApiError } from '@od/shared/client';
import type { ActivityUpdate } from '@od/shared/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActivityUpdates } from './useActivityUpdates.native';

const nativeState = vi.hoisted(() => ({ current: undefined as unknown }));
const crypto = vi.hoisted(() => ({ uuid: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: crypto.uuid }));
vi.mock('@/lib/sqlite/nativeState', () => ({
  getActiveNativeState: () => nativeState.current,
  requireActiveNativeState: () => nativeState.current,
}));

const ACTIVITY = 'act_01J0000000000000000000000A';
const stored: ActivityUpdate = {
  updateId: 'upd_01J0000000000000000000000A',
  activityId: ACTIVITY,
  kind: 'user',
  authorUserId: 'usr_01J0000000000000000000000A',
  body: 'Already saved',
  createdAt: '2026-08-19T11:00:00.000Z',
  schemaVersion: 1,
};

const second: ActivityUpdate = {
  ...stored,
  updateId: 'upd_01J0000000000000000000000B',
  body: 'Second saved row',
  createdAt: '2026-08-20T11:00:00.000Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

beforeEach(() => {
  crypto.uuid.mockReset();
  crypto.uuid.mockReturnValue('stable-native-update-id');
});

afterEach(() => {
  nativeState.current = undefined;
  vi.restoreAllMocks();
});

describe('native useActivityUpdates durable adapter', () => {
  it('presents an accepted offline post from SQLite again after remount', async () => {
    let version = 0;
    let listener: (() => void) | undefined;
    let projection = {
      updates: [stored] as readonly ActivityUpdate[],
      pending: [] as readonly { localId: string; body: string }[],
      cursor: undefined,
    };
    const publish = () => {
      version += 1;
      listener?.();
    };
    const postUpdate = vi.fn(
      async (variables: { body: string; idempotencyKey: string }) => {
        projection = {
          ...projection,
          pending: [{ localId: variables.idempotencyKey, body: variables.body }],
        };
        publish();
        return { kind: 'accepted', status: 'queued', intent: {}, commitRevision: 1 };
      },
    );
    nativeState.current = {
      activities: {
        subscribeUpdates: (_activityId: string, next: () => void) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        updatesVersion: () => version,
        readUpdatesProjection: async () => projection,
      },
      coordinator: { postUpdate, deleteUpdate: vi.fn() },
      sync: {},
    };
    const embedded = { updates: [stored], cursor: undefined };
    const first = renderHook(() => useActivityUpdates(ACTIVITY, embedded));
    await waitFor(() => expect(first.result.current.updates).toEqual([stored]));

    await act(async () => {
      expect(await first.result.current.post(' Offline note ')).toBe(true);
    });
    await waitFor(() =>
      expect(first.result.current.pending).toEqual([
        { localId: 'stable-native-update-id', body: 'Offline note' },
      ]),
    );
    expect(postUpdate).toHaveBeenCalledWith({
      activityId: ACTIVITY,
      body: 'Offline note',
      idempotencyKey: 'stable-native-update-id',
    });
    first.unmount();

    const relaunched = renderHook(() => useActivityUpdates(ACTIVITY, embedded));
    await waitFor(() =>
      expect(relaunched.result.current.pending).toEqual(projection.pending),
    );
  });

  it('accepts two ordered offline posts while the first remains durably pending', async () => {
    let version = 0;
    let listener: (() => void) | undefined;
    let projection = {
      updates: [stored] as readonly ActivityUpdate[],
      pending: [] as readonly { localId: string; body: string }[],
      cursor: undefined,
    };
    const intents: Array<{ activityId: string; body: string; idempotencyKey: string }> =
      [];
    const publish = () => {
      version += 1;
      listener?.();
    };
    const postUpdate = vi.fn(
      async (variables: { activityId: string; body: string; idempotencyKey: string }) => {
        intents.push(variables);
        projection = {
          ...projection,
          pending: [
            { localId: variables.idempotencyKey, body: variables.body },
            ...projection.pending,
          ],
        };
        publish();
        return {
          kind: 'accepted',
          status: 'queued',
          intent: {},
          commitRevision: version,
        };
      },
    );
    nativeState.current = {
      activities: {
        subscribeUpdates: (_activityId: string, next: () => void) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        updatesVersion: () => version,
        readUpdatesProjection: async () => projection,
      },
      coordinator: { postUpdate, deleteUpdate: vi.fn() },
      sync: {},
    };
    crypto.uuid.mockReturnValueOnce('offline-a').mockReturnValueOnce('offline-b');
    const first = renderHook(() =>
      useActivityUpdates(ACTIVITY, { updates: [stored], cursor: undefined }),
    );
    await waitFor(() => expect(first.result.current.updates).toEqual([stored]));

    await act(async () => expect(await first.result.current.post('A')).toBe(true));
    await waitFor(() => expect(first.result.current.isPosting).toBe(false));
    await act(async () => expect(await first.result.current.post('B')).toBe(true));
    await waitFor(() =>
      expect(first.result.current.pending).toEqual([
        { localId: 'offline-b', body: 'B' },
        { localId: 'offline-a', body: 'A' },
      ]),
    );
    expect(intents.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      'offline-a',
      'offline-b',
    ]);
    first.unmount();

    const relaunched = renderHook(() =>
      useActivityUpdates(ACTIVITY, { updates: [stored], cursor: undefined }),
    );
    await waitFor(() =>
      expect(relaunched.result.current.pending).toEqual(projection.pending),
    );
  });

  it('observes terminal post rollback and preserves its structured failure', async () => {
    let version = 0;
    let listener: (() => void) | undefined;
    let projection = {
      updates: [stored] as readonly ActivityUpdate[],
      pending: [] as readonly { localId: string; body: string }[],
      cursor: undefined,
    };
    const gate = deferred<void>();
    const publish = () => {
      version += 1;
      listener?.();
    };
    nativeState.current = {
      activities: {
        subscribeUpdates: (_activityId: string, next: () => void) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        updatesVersion: () => version,
        readUpdatesProjection: async () => projection,
      },
      coordinator: {
        postUpdate: async (variables: { body: string; idempotencyKey: string }) => {
          projection = {
            ...projection,
            pending: [{ localId: variables.idempotencyKey, body: variables.body }],
          };
          publish();
          await gate.promise;
          projection = { ...projection, pending: [] };
          publish();
          return {
            kind: 'refused',
            error: new ApiError('internal', 'database detail', 503, 'req_native_post'),
          };
        },
        deleteUpdate: vi.fn(),
      },
      sync: {},
    };
    const mounted = renderHook(() =>
      useActivityUpdates(ACTIVITY, { updates: [stored], cursor: undefined }),
    );
    let outcome!: Promise<boolean>;
    act(() => {
      outcome = mounted.result.current.post('Offline failure');
    });
    await waitFor(() => expect(mounted.result.current.pending).toHaveLength(1));
    gate.resolve();
    await act(async () => expect(await outcome).toBe(false));
    await waitFor(() => expect(mounted.result.current.pending).toEqual([]));
    expect(mounted.result.current.updates).toEqual([stored]);
    expect(mounted.result.current.errorMessage).toBe('Something went wrong.');
    expect(mounted.result.current.errorRequestId).toBe('req_native_post');
    expect(mounted.result.current.errorAction).toBe('post');
  });

  it('observes exact delete rollback and preserves its structured failure', async () => {
    let version = 0;
    let listener: (() => void) | undefined;
    let projection = {
      updates: [second, stored] as readonly ActivityUpdate[],
      pending: [] as readonly { localId: string; body: string }[],
      cursor: undefined,
    };
    const gate = deferred<void>();
    const publish = () => {
      version += 1;
      listener?.();
    };
    nativeState.current = {
      activities: {
        subscribeUpdates: (_activityId: string, next: () => void) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        updatesVersion: () => version,
        readUpdatesProjection: async () => projection,
      },
      coordinator: {
        postUpdate: vi.fn(),
        deleteUpdate: async () => {
          const snapshot = projection;
          projection = { ...projection, updates: [second] };
          publish();
          await gate.promise;
          projection = snapshot;
          publish();
          return {
            kind: 'refused',
            error: new ApiError('internal', 'database detail', 503, 'req_native_delete'),
          };
        },
      },
      sync: {},
    };
    const mounted = renderHook(() =>
      useActivityUpdates(ACTIVITY, { updates: [second, stored], cursor: undefined }),
    );
    let outcome!: Promise<boolean>;
    act(() => {
      outcome = mounted.result.current.remove(stored);
    });
    await waitFor(() => expect(mounted.result.current.updates).toEqual([second]));
    gate.resolve();
    await act(async () => expect(await outcome).toBe(false));
    await waitFor(() => expect(mounted.result.current.updates).toEqual([second, stored]));
    expect(mounted.result.current.errorRequestId).toBe('req_native_delete');
    expect(mounted.result.current.errorAction).toBe('delete');
  });

  it('preserves structured paging failure details', async () => {
    let listener: (() => void) | undefined;
    nativeState.current = {
      activities: {
        subscribeUpdates: (_activityId: string, next: () => void) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        updatesVersion: () => 0,
        readUpdatesProjection: async () => ({
          updates: [stored],
          pending: [],
          cursor: 'cur_1',
        }),
      },
      coordinator: { postUpdate: vi.fn(), deleteUpdate: vi.fn() },
      sync: {
        pullActivityUpdates: vi
          .fn()
          .mockRejectedValue(
            new ApiError('internal', 'database detail', 503, 'req_native_page'),
          ),
      },
    };
    const mounted = renderHook(() =>
      useActivityUpdates(ACTIVITY, { updates: [stored], cursor: 'cur_1' }),
    );
    await waitFor(() => expect(mounted.result.current.cursor).toBe('cur_1'));
    act(() => mounted.result.current.loadMore());
    await waitFor(() => expect(mounted.result.current.errorAction).toBe('load'));
    expect(mounted.result.current.errorRequestId).toBe('req_native_page');
    expect(listener).toBeDefined();
  });
});
