import type { List } from '@od/shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDestination } from './useDestination';

/**
 * The client half of P3-12's four-step rule (P3-43). Lists and the profile are seeded into
 * the cache; the resolver's answer and the one profile write are what these read.
 */

const OWNER = 'usr_01J0000000000000000000000B';
const list = (listId: string, title: string, slot: List['slot']): List =>
  ({
    schemaVersion: 2,
    listId,
    ownerId: OWNER,
    templateKey: 'groceries',
    title,
    icon: 'cart',
    emptyStateCopy: '',
    itemStateMode: { mode: 'checkbox' },
    featureConfig: {},
    slot,
    itemCount: 0,
    doneCount: 0,
    memberCount: 1,
    rankVersion: 0,
    archived: false,
    updatedAt: '2026-08-24T09:00:00.000Z',
    lastItemActivityAt: '2026-08-24T09:00:00.000Z',
  }) as unknown as List;

const GROCERIES = list('lst_01J8XKQ2M4N5P6R7S8T9V0W1A1', 'Groceries', 'groceries');
const COSTCO = list('lst_01J8XKQ2M4N5P6R7S8T9V0W1A2', 'Costco', 'groceries');
const PACKING = list('lst_01J8XKQ2M4N5P6R7S8T9V0W1A3', 'Packing', null);

function seeded(lists: readonly List[], defaultLists: Record<string, string> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // Seeded, and fresh: the resolver's inputs are what is under test, not their fetching.
  client.setQueryDefaults(['lists'], { staleTime: Number.POSITIVE_INFINITY });
  client.setQueryData(['lists'], {
    pages: [{ data: lists, meta: {} }],
    pageParams: [undefined],
  });
  client.setQueryData(['me'], {
    userId: OWNER,
    displayName: 'Dev',
    timezone: 'America/New_York',
    currency: 'USD',
    weekStartsOn: 1,
    defaultLists,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

afterEach(() => vi.unstubAllGlobals());

describe('useDestination', () => {
  it('uses the only eligible list silently, and still names it', async () => {
    const { wrapper } = seeded([GROCERIES, PACKING]);
    const { result } = renderHook(() => useDestination('groceries', undefined), {
      wrapper,
    });
    await waitFor(() => expect(result.current.resolution?.kind).toBe('use'));
    expect(result.current.list?.title).toBe('Groceries');
    expect(result.current.needsAnswer).toBe(false);
    // Packing holds no slot: never a candidate, but reachable through `Choose another list`.
    expect(result.current.candidates.map((l) => l.title)).toEqual(['Groceries']);
    expect(result.current.all.map((l) => l.title)).toEqual(['Groceries', 'Packing']);
  });

  it('asks once when several are eligible and no default is set', async () => {
    const { wrapper } = seeded([GROCERIES, COSTCO]);
    const { result } = renderHook(() => useDestination('groceries', undefined), {
      wrapper,
    });
    await waitFor(() => expect(result.current.resolution?.kind).toBe('ask'));
    expect(result.current.list).toBeUndefined();
    expect(result.current.needsAnswer).toBe(true);
  });

  it('honours a stored default among several, and a one-off override over it', async () => {
    const { wrapper } = seeded([GROCERIES, COSTCO], { groceries: COSTCO.listId });
    const { result, rerender } = renderHook(
      ({ override }: { override: string | undefined }) =>
        useDestination('groceries', override),
      { wrapper, initialProps: { override: undefined as string | undefined } },
    );
    await waitFor(() => expect(result.current.list?.title).toBe('Costco'));
    rerender({ override: GROCERIES.listId });
    expect(result.current.list?.title).toBe('Groceries');
    expect(result.current.needsAnswer).toBe(false);
  });

  it('offers nothing but creation when no list holds the slot', async () => {
    const { wrapper } = seeded([PACKING]);
    const { result } = renderHook(() => useDestination('groceries', undefined), {
      wrapper,
    });
    await waitFor(() => expect(result.current.resolution?.kind).toBe('none'));
    expect(result.current.list).toBeUndefined();
  });

  /** Remembering is the one profile write, and it lands in the same cache the tabs read. */
  it('remembers through PATCH /v1/me and updates the cached profile', async () => {
    const { wrapper, client } = seeded([GROCERIES, COSTCO]);
    const fetchSpy = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = {
        data: {
          userId: OWNER,
          displayName: 'Dev',
          timezone: 'America/New_York',
          currency: 'USD',
          weekStartsOn: 1,
          defaultLists: JSON.parse(init?.body ?? '{}').defaultLists,
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
          schemaVersion: 1,
        },
        meta: { requestId: 'req_test' },
      };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { result } = renderHook(() => useDestination('groceries', undefined), {
      wrapper,
    });
    await waitFor(() => expect(result.current.resolution?.kind).toBe('ask'));

    await act(() => result.current.remember(COSTCO.listId));

    // The seeded lists page may refetch on mount; the profile write is the one PATCH.
    const patches = fetchSpy.mock.calls.filter(
      (call) => (call[1] as { method?: string } | undefined)?.method === 'PATCH',
    );
    expect(patches).toHaveLength(1);
    const [url, init] = patches[0] as [string, { method: string; body: string }];
    expect(url).toContain('/v1/me');
    expect(JSON.parse(init.body)).toEqual({ defaultLists: { groceries: COSTCO.listId } });
    expect(
      (client.getQueryData(['me']) as { defaultLists: Record<string, string> })
        .defaultLists,
    ).toEqual({
      groceries: COSTCO.listId,
    });
    await waitFor(() => expect(result.current.list?.title).toBe('Costco'));
  });

  it('issues no request while disabled', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useDestination('groceries', undefined, false), {
      wrapper,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.resolution).toBeUndefined();
  });
});
