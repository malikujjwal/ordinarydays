import type { ListPage } from '@od/shared/client';
import { instant } from '@od/shared/schemas';
import { fixedClock, type Instant } from '@od/shared/time';
import type { List, ListSettingsMutation } from '@od/shared/types';
import {
  type InfiniteData,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockProvider } from '@/hooks/useClock';
import { useToast } from '@/stores/toast';
import { LISTS_KEY } from './keys';
import { useListIndexMutations } from './useListIndexMutations';

const calls = vi.hoisted(() => ({
  patch: vi.fn(),
}));

vi.mock('@od/shared/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@od/shared/client')>()),
  patchList: calls.patch,
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'idem-list-index' }));

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
  itemCount: 3,
  doneCount: 1,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-08-26T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-26T08:00:00.000Z'),
};

const NOW = '2026-08-27T14:00:00.000Z' as Instant;
type ArchiveWithUndo = Extract<ListSettingsMutation, { undoToken: string }>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const data: InfiniteData<ListPage> = {
    pages: [{ data: [LIST], meta: { requestId: 'req_lists' } }],
    pageParams: [undefined],
  };
  client.setQueryData(LISTS_KEY, data);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ClockProvider clock={fixedClock(NOW)}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </ClockProvider>
  );
  return renderHook(() => useListIndexMutations(), { wrapper });
}

beforeEach(() => {
  calls.patch.mockReset();
  useToast.setState({ current: undefined });
});

describe('the web archive Undo deadline', () => {
  it('commits the previous toast and offers nothing when the server deadline has expired', async () => {
    const pending = deferred<ArchiveWithUndo>();
    calls.patch.mockReturnValue(pending.promise);
    const response: ArchiveWithUndo = {
      list: { ...LIST, archived: true },
      undoToken: 'undo-expired',
      undoExpiresAt: '2000-01-01T00:00:00.000Z' as Instant,
    };
    const priorCommit = vi.fn();
    useToast.getState().showUndo({
      message: 'Still relevant',
      onUndo: vi.fn(),
      onCommit: priorCommit,
    });
    const mounted = setup();

    act(() => mounted.result.current.onArchive(LIST));

    expect(priorCommit).toHaveBeenCalledOnce();
    expect(useToast.getState().current).toBeUndefined();
    await waitFor(() => expect(calls.patch).toHaveBeenCalledOnce());
    await act(async () => {
      pending.resolve(response);
      await pending.promise;
    });
    expect(useToast.getState().current).toBeUndefined();
  });

  it('shows only the time remaining on the server offer', async () => {
    const pending = deferred<ArchiveWithUndo>();
    calls.patch.mockReturnValue(pending.promise);
    const response: ArchiveWithUndo = {
      list: { ...LIST, archived: true },
      undoToken: 'undo-current',
      undoExpiresAt: '2026-08-27T14:00:01.500Z' as Instant,
    };
    const mounted = setup();

    act(() => mounted.result.current.onArchive(LIST));
    await waitFor(() => expect(calls.patch).toHaveBeenCalledOnce());
    await act(async () => {
      pending.resolve(response);
      await pending.promise;
    });

    expect(useToast.getState().current).toMatchObject({
      kind: 'undo',
      message: 'Groceries archived',
      duration: 1500,
    });
  });
});
