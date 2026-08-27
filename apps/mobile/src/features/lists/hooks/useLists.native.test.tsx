import { ApiError } from '@od/shared/client';
import type { List } from '@od/shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryInvalidationMetadata } from '@/lib/sqlite/subscriptions';
import { useLists } from './useLists.native';

/**
 * The native Lists reader (P3-25, ADR-057).
 *
 * The point of these assertions is the pivot itself: **rows come from SQLite, never from a
 * query cache**, a subscription re-reads at the revision it names, and a failed pull keeps what
 * is already committed rather than emptying the screen.
 */

const nativeState = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('@/lib/sqlite/nativeState', () => ({
  requireActiveNativeState: () => nativeState.current,
}));

vi.mock('@/hooks/usePendingIntents', () => ({ useIsOffline: () => false }));

vi.mock('expo-router', async () => {
  const react = await import('react');
  return {
    useFocusEffect: (effect: React.EffectCallback) => react.useEffect(effect, [effect]),
  };
});

const list = (title: string): List => ({
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  behaviour: 'collection',
  templateKey: 'groceries',
  title,
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  capabilities: { checkable: true, supportsLocation: false },
  slot: null,
  itemCount: 3,
  uncheckedCount: 3,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: '2026-08-24T09:00:00.000Z',
  lastItemActivityAt: '2026-08-26T09:00:00.000Z',
});

interface Harness {
  snapshots: { lists: readonly List[]; commitRevision: number }[];
  pullLists?: () => Promise<readonly List[]>;
}

function install({ snapshots, pullLists = () => Promise.resolve([]) }: Harness) {
  let listener: ((metadata: RepositoryInvalidationMetadata) => void) | undefined;
  let index = 0;
  const readSnapshot = vi.fn(() =>
    Promise.resolve(snapshots[Math.min(index++, snapshots.length - 1)]),
  );

  const state = {
    ownerUserId: 'usr_local_dev',
    lists: {
      readSnapshot,
      subscribe: (next: (metadata: RepositoryInvalidationMetadata) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    },
    sync: { pullLists: vi.fn(pullLists) },
  };
  nativeState.current = state;
  return { state, readSnapshot, notify: () => listener };
}

function mount() {
  const client = new QueryClient();
  client.setQueryData(['me'], { timezone: 'UTC' });
  return renderHook(() => useLists(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

describe('the native Lists reader', () => {
  afterEach(() => {
    nativeState.current = undefined;
    vi.restoreAllMocks();
  });

  it('reads committed rows from SQLite, not from the query cache', async () => {
    install({ snapshots: [{ lists: [list('Groceries')], commitRevision: 1 }] });
    const { result } = mount();

    await waitFor(() => expect(result.current.lists).toHaveLength(1));
    expect(result.current.lists[0]?.title).toBe('Groceries');
    expect(result.current.status).toBe('success');
    expect(result.current.viewerUserId).toBe('usr_local_dev');
  });

  /**
   * The complete drain is what lets the screen's `No lists yet` rule be decided at all: a paged
   * SQLite source would be a prefix of an order presented as complete.
   */
  it('never reports more pages, because the pull drained every cursor', async () => {
    install({ snapshots: [{ lists: [], commitRevision: 1 }] });
    const { result } = mount();

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.hasMore).toBe(false);
    expect(result.current.isLoadingMore).toBe(false);
  });

  it('pulls through the one serialized sync engine on focus', async () => {
    const { state } = install({ snapshots: [{ lists: [], commitRevision: 1 }] });
    mount();

    await waitFor(() => expect(state.sync.pullLists).toHaveBeenCalled());
  });

  /**
   * §5.3's refresh-failure class: cached content stays and the failure is reported beside it.
   * Emptying the screen because a refresh failed is the bug this asserts against.
   */
  it('keeps committed rows when the pull fails', async () => {
    install({
      snapshots: [{ lists: [list('Groceries')], commitRevision: 1 }],
      pullLists: () => Promise.reject(new Error('Network down')),
    });
    const { result } = mount();

    await waitFor(() => expect(result.current.message).toBe('Network down'));
    expect(result.current.lists).toHaveLength(1);
    // Rows survived, so this is a refresh failure rather than a load failure.
    expect(result.current.status).toBe('success');
  });

  it('preserves an API request id but does not invent one for local failures', async () => {
    install({
      snapshots: [{ lists: [list('Groceries')], commitRevision: 1 }],
      pullLists: () =>
        Promise.reject(
          new ApiError(
            'internal',
            'An unexpected error occurred.',
            500,
            'req_native_lists',
          ),
        ),
    });
    const first = mount();

    await waitFor(() => expect(first.result.current.requestId).toBe('req_native_lists'));
    expect(first.result.current.message).toBe('Something went wrong.');

    first.unmount();
    install({
      snapshots: [{ lists: [list('Groceries')], commitRevision: 1 }],
      pullLists: () => Promise.reject(new Error('SQLite unavailable')),
    });
    const local = mount();
    await waitFor(() => expect(local.result.current.message).toBe('SQLite unavailable'));
    expect(local.result.current.requestId).toBeUndefined();
  });

  it('becomes an error only when there is nothing committed to keep', async () => {
    install({
      snapshots: [{ lists: [], commitRevision: 1 }],
      pullLists: () => Promise.reject(new Error('Network down')),
    });
    const { result } = mount();

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.lists).toEqual([]);
  });

  /**
   * A subscription naming a revision must not be answered from a snapshot older than it — that
   * is how a screen renders the state a write just replaced.
   */
  it('waits for the revision a subscription named before rendering', async () => {
    const { notify, readSnapshot } = install({
      snapshots: [
        { lists: [], commitRevision: 1 },
        { lists: [], commitRevision: 1 },
        { lists: [], commitRevision: 1 },
        { lists: [list('Arrived')], commitRevision: 4 },
      ],
    });
    const { result } = mount();

    await waitFor(() => expect(result.current.status).toBe('success'));
    const before = readSnapshot.mock.calls.length;

    notify()?.({ scope: 'lists', commitRevision: 4 });

    await waitFor(() => expect(result.current.lists).toHaveLength(1));
    // It re-read rather than trusting the snapshot it already had.
    expect(readSnapshot.mock.calls.length).toBeGreaterThan(before);
  });

  it('refuses to run without its repository, rather than falling back to a cache', () => {
    nativeState.current = { lists: undefined, sync: {} };

    expect(() => mount()).toThrow('Native Lists state is not ready.');
  });
});
