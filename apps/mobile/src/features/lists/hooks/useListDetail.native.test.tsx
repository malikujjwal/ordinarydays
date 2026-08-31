import { instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { EffectCallback } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useListDetail } from './useListDetail.native';

const nativeState = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('@/lib/sqlite/nativeState', () => ({
  requireActiveNativeState: () => nativeState.current,
}));

/**
 * `useFocusEffect` re-runs its effect whenever the callback identity changes, exactly as
 * `useEffect(cb, [cb])` does. That identity semantics is the regression surface here: a
 * dependency minted fresh each render turns the focus effect into a per-render effect.
 */
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return {
    useFocusEffect: (callback: EffectCallback) => {
      useEffect(callback, [callback]);
    },
  };
});

const LIST: List = {
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0ABC',
  ownerId: 'usr_local_dev',
  schemaVersion: 2,
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
  rankVersion: 1,
  archived: false,
  updatedAt: instant.parse('2026-08-26T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-26T08:00:00.000Z'),
};

function nativeStub() {
  const readSnapshot = vi.fn(async () => ({
    commitRevision: 1,
    items: [],
    page: { rankVersion: 1, complete: true },
  }));
  const subscribe = vi.fn(() => () => undefined);
  const getLocal = vi.fn(async () => LIST);
  const pullListDetail = vi.fn(async () => undefined);
  const pullListItemPage = vi.fn(async () => undefined);
  return {
    stub: {
      account: { database: {}, transactions: { run: vi.fn(async () => undefined) } },
      lists: { getLocal },
      listItems: { readSnapshot, subscribe },
      sync: { pullListDetail, pullListItemPage },
    },
    readSnapshot,
    subscribe,
    pullListDetail,
  };
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

describe('the native list detail hook', () => {
  afterEach(() => {
    nativeState.current = undefined;
    vi.restoreAllMocks();
  });

  /**
   * The 2026-08-31 List Detail render loop: per-render `.bind()` identities reached the
   * focus effect's dependency array, so every render re-ran the effect, whose `refetch`
   * committed fresh state and scheduled the next render — ~75 renders/second for as long
   * as the screen stayed mounted, starving every timer in the app. Settled means settled:
   * one subscription, one detail pull, and no further activity while nothing changes.
   */
  it('settles into one subscription and one detail pull, not a per-render focus effect', async () => {
    const built = nativeStub();
    nativeState.current = built.stub;

    const mounted = renderHook(() => useListDetail(LIST.listId));
    await waitFor(() => expect(mounted.result.current.status).toBe('success'));

    await settle();
    const subscriptions = built.subscribe.mock.calls.length;
    const pulls = built.pullListDetail.mock.calls.length;
    await settle();

    expect(built.subscribe.mock.calls.length).toBe(subscriptions);
    expect(built.pullListDetail.mock.calls.length).toBe(pulls);
    expect(built.subscribe).toHaveBeenCalledTimes(1);
    expect(built.pullListDetail).toHaveBeenCalledTimes(1);
  });
});
