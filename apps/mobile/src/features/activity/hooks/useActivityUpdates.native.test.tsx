import type { ActivityUpdate } from '@od/shared/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useActivityUpdates } from './useActivityUpdates.native';

const nativeState = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'stable-native-update-id' }));
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
});
