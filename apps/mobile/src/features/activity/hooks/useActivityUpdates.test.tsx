import type { ActivityUpdate } from '@od/shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(() => {
  clients.get.mockReset();
  clients.post.mockReset();
  clients.remove.mockReset();
  clients.uuid.mockReset();
});

describe('useActivityUpdates web query ownership', () => {
  it('keeps an acknowledged deletion in the query cache across remounts', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
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

  it('retries a network failure under the same persisted idempotency identity', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const stored = update(2);
    clients.uuid.mockReturnValueOnce('local-id').mockReturnValueOnce('stable-idem');
    clients.post
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValue({ update: stored, lastActivityAt: stored.createdAt });
    const mounted = renderHook(
      () => useActivityUpdates(ACTIVITY, { updates: [], cursor: undefined }),
      { wrapper: wrapper(client) },
    );

    await act(async () => {
      expect(await mounted.result.current.post(' Note 2 ')).toBe(true);
    });
    await waitFor(() => expect(mounted.result.current.updates).toEqual([stored]));
    expect(clients.post).toHaveBeenCalledTimes(2);
    expect(clients.post.mock.calls[0]?.[3]).toBe('stable-idem');
    expect(clients.post.mock.calls[1]?.[3]).toBe('stable-idem');
  });
});
