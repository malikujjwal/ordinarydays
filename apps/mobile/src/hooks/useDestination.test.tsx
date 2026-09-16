import type { List } from '@od/shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDestination } from './useDestination';

/**
 * The client half of Option B1's flattened destination (`docs/reports/
 * destination-flow-simplification-20260916.md`). Lists and the profile are seeded into the
 * cache; the resolved `list`, the flat `lists` set and the one profile write are what these
 * read. There is no `resolution` kind to assert on any more — a default naming a capable,
 * present list is `hasDefault: true`; anything else that names a destination is `false`.
 */

const OWNER = 'usr_01J0000000000000000000000B';
const list = (
  listId: string,
  title: string,
  slot: List['slot'],
  itemStateMode: List['itemStateMode'] = { mode: 'checkbox' },
): List =>
  ({
    schemaVersion: 2,
    listId,
    ownerId: OWNER,
    templateKey: 'groceries',
    title,
    icon: 'cart',
    emptyStateCopy: '',
    itemStateMode,
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
/** Capable, but never held the groceries slot — reachable only because B1 has no escape to
 *  restrict to: every capable list is already in the flat set. */
const CHECKLIST = list('lst_01J8XKQ2M4N5P6R7S8T9V0W1A3', 'Camping checklist', null);
const UNTITLED = {
  ...list('lst_01J8XKQ2M4N5P6R7S8T9V0W1A4', 'Untitled list', null, { mode: 'none' }),
  templateKey: 'blank',
};
const INCAPABLE_GROCERIES = {
  ...UNTITLED,
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1A5',
  title: 'Groceries without checkboxes',
  slot: 'groceries' as const,
};

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
  it('uses the only capable list silently, with no default write', async () => {
    const { wrapper } = seeded([GROCERIES]);
    const { result } = renderHook(() => useDestination('groceries', undefined), {
      wrapper,
    });
    await waitFor(() => expect(result.current.list?.title).toBe('Groceries'));
    expect(result.current.hasDefault).toBe(false);
    expect(result.current.lists.map((l) => l.title)).toEqual(['Groceries']);
  });

  it('excludes an Untitled blank list and a slotted-but-incapable list from the flat set', async () => {
    const { wrapper } = seeded([GROCERIES, UNTITLED, INCAPABLE_GROCERIES]);
    const { result } = renderHook(() => useDestination('groceries', undefined), {
      wrapper,
    });
    await waitFor(() => expect(result.current.list?.title).toBe('Groceries'));
    expect(result.current.lists.map((candidate) => candidate.title)).toEqual([
      'Groceries',
    ]);
  });

  it('offers every capable list regardless of slot, not only ones marked as the destination', async () => {
    const { wrapper } = seeded([GROCERIES, CHECKLIST]);
    const { result } = renderHook(() => useDestination('groceries', undefined), {
      wrapper,
    });
    await waitFor(() =>
      expect(result.current.lists.map((l) => l.title).sort()).toEqual([
        'Camping checklist',
        'Groceries',
      ]),
    );
    // Two capable lists and no default: nothing is silently chosen.
    expect(result.current.list).toBeUndefined();
    expect(result.current.hasDefault).toBe(false);
  });

  it('ignores an incapable override and falls back to the resolved destination', async () => {
    const { wrapper } = seeded([GROCERIES, UNTITLED]);
    const { result } = renderHook(() => useDestination('groceries', UNTITLED.listId), {
      wrapper,
    });
    await waitFor(() => expect(result.current.list?.title).toBe('Groceries'));
  });

  it('treats an incapable stored default as absent among several capable lists', async () => {
    const { wrapper } = seeded([GROCERIES, COSTCO, INCAPABLE_GROCERIES], {
      groceries: INCAPABLE_GROCERIES.listId,
    });
    const { result } = renderHook(() => useDestination('groceries', undefined), {
      wrapper,
    });
    await waitFor(() =>
      expect(result.current.lists.map((l) => l.title).sort()).toEqual([
        'Costco',
        'Groceries',
      ]),
    );
    expect(result.current.list).toBeUndefined();
    expect(result.current.hasDefault).toBe(false);
  });

  it('treats a default naming an archived list as absent', async () => {
    const { wrapper } = seeded([GROCERIES, { ...COSTCO, archived: true }], {
      groceries: COSTCO.listId,
    });
    const { result } = renderHook(() => useDestination('groceries', undefined), {
      wrapper,
    });
    await waitFor(() => expect(result.current.list?.title).toBe('Groceries'));
    expect(result.current.hasDefault).toBe(false);
  });

  it('treats a default naming a deleted list as absent', async () => {
    const { wrapper } = seeded([GROCERIES], { groceries: COSTCO.listId });
    const { result } = renderHook(() => useDestination('groceries', undefined), {
      wrapper,
    });
    await waitFor(() => expect(result.current.list?.title).toBe('Groceries'));
    expect(result.current.hasDefault).toBe(false);
  });

  it('keeps Watch unrestricted and honours a one-off blank-list override', async () => {
    const { wrapper } = seeded([GROCERIES, UNTITLED]);
    const { result } = renderHook(() => useDestination('watch', UNTITLED.listId), {
      wrapper,
    });
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.lists.map((candidate) => candidate.title).sort()).toEqual([
      'Groceries',
      'Untitled list',
    ]);
    expect(result.current.list?.title).toBe('Untitled list');
  });

  it('preselects a stored default among several capable lists, without writing', async () => {
    const { wrapper } = seeded([GROCERIES, COSTCO], { groceries: COSTCO.listId });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { result } = renderHook(() => useDestination('groceries', undefined), {
      wrapper,
    });
    await waitFor(() => expect(result.current.list?.title).toBe('Costco'));
    expect(result.current.hasDefault).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('honours a one-off override over a stored default, and never writes it', async () => {
    const { wrapper } = seeded([GROCERIES, COSTCO], { groceries: COSTCO.listId });
    const { result, rerender } = renderHook(
      ({ override }: { override: string | undefined }) =>
        useDestination('groceries', override),
      { wrapper, initialProps: { override: undefined as string | undefined } },
    );
    await waitFor(() => expect(result.current.list?.title).toBe('Costco'));
    rerender({ override: GROCERIES.listId });
    expect(result.current.list?.title).toBe('Groceries');
    // The override displaced the default; whether a *later* pick without an override would
    // remember is the picker's call (`DestinationSheet.test.tsx`), not this hook's.
    expect(result.current.hasDefault).toBe(true);
  });

  it('offers nothing but creation when no list is capable', async () => {
    const { wrapper } = seeded([UNTITLED]);
    const { result } = renderHook(() => useDestination('groceries', undefined), {
      wrapper,
    });
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.lists).toEqual([]);
    expect(result.current.list).toBeUndefined();
  });

  /** The only write this hook makes, and the only way a default is ever set. */
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
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.hasDefault).toBe(false);

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
    expect(result.current.hasDefault).toBe(true);
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
    expect(result.current.lists).toEqual([]);
    expect(result.current.list).toBeUndefined();
  });
});
