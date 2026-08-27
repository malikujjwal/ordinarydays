import type { List } from '@od/shared/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '@/stores/toast';
import type { ListIndexMutations } from './useListIndexMutations';
import { useListIndexMutations } from './useListIndexMutations.native';

const calls = vi.hoisted(() => ({
  commit: vi.fn(),
  remove: vi.fn(),
  run: vi.fn(),
  setArchived: vi.fn(),
  sync: vi.fn(),
  undoArchive: vi.fn(),
  uuid: vi.fn(),
}));

vi.mock('expo-crypto', () => ({ randomUUID: calls.uuid }));

vi.mock('@/lib/sqlite/listTransactions', () => ({
  ListTransactionService: class {
    setArchived = calls.setArchived;
    undoArchive = calls.undoArchive;
    commitArchiveUndoOffer = calls.commit;
    remove = calls.remove;
  },
}));

vi.mock('@/lib/sqlite/nativeState', () => ({
  requireActiveNativeState: () => ({
    account: { transactions: { run: calls.run } },
    lists: {},
    outbox: {},
    sync: { request: calls.sync },
  }),
}));

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
  updatedAt: '2026-08-26T09:00:00.000Z',
  lastItemActivityAt: '2026-08-26T08:00:00.000Z',
};

beforeEach(() => {
  calls.commit.mockReset();
  calls.remove.mockReset();
  calls.run.mockReset();
  calls.run.mockReturnValue(new Promise(() => undefined));
  calls.setArchived.mockReset();
  calls.sync.mockReset();
  calls.undoArchive.mockReset();
  calls.uuid.mockReset();
  calls.uuid.mockReturnValue('native-list-intent');
  useToast.setState({ current: undefined });
});

function runTransactions(): void {
  calls.run.mockImplementation((work) => Promise.resolve(work({})));
}

function retryCurrentToast(): void {
  const current = useToast.getState().current;
  if (current?.kind !== 'message' || current.action === undefined) {
    throw new Error('Expected a retryable message toast.');
  }
  current.action.onPress();
}

describe('native List index mutations', () => {
  it.each([
    ['archive', (actions: ListIndexMutations) => actions.onArchive(LIST)],
    [
      'restore',
      (actions: ListIndexMutations) => actions.onRestore({ ...LIST, archived: true }),
    ],
    ['delete', (actions: ListIndexMutations) => actions.onDelete(LIST)],
  ] as const)('commits the previous Undo before %s durability settles', (_name, run) => {
    const onCommit = vi.fn();
    useToast.getState().showUndo({
      message: 'Previous action',
      onUndo: vi.fn(),
      onCommit,
    });
    const mounted = renderHook(() => useListIndexMutations());

    act(() => run(mounted.result.current));

    expect(calls.run).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledOnce();
    expect(useToast.getState().current).toBeUndefined();
  });

  it.each([
    ['archive', (actions: ListIndexMutations) => actions.onArchive(LIST)],
    [
      'restore',
      (actions: ListIndexMutations) => actions.onRestore({ ...LIST, archived: true }),
    ],
  ] as const)('retries %s with the same durable intent', async (_name, run) => {
    runTransactions();
    calls.setArchived
      .mockRejectedValueOnce(new Error('SQLite unavailable'))
      .mockResolvedValueOnce({});
    const mounted = renderHook(() => useListIndexMutations());

    act(() => run(mounted.result.current));
    await waitFor(() =>
      expect(useToast.getState().current).toMatchObject({
        action: { label: 'Retry' },
      }),
    );
    act(retryCurrentToast);

    await waitFor(() => expect(calls.setArchived).toHaveBeenCalledTimes(2));
    expect(calls.setArchived.mock.calls.map((call) => call[3])).toEqual([
      'native-list-intent',
      'native-list-intent',
    ]);
    expect(calls.uuid).toHaveBeenCalledOnce();
  });

  it('retries delete with the same durable intent', async () => {
    runTransactions();
    calls.remove
      .mockRejectedValueOnce(new Error('SQLite unavailable'))
      .mockResolvedValueOnce({});
    const mounted = renderHook(() => useListIndexMutations());

    act(() => mounted.result.current.onDelete(LIST));
    await waitFor(() =>
      expect(useToast.getState().current).toMatchObject({
        action: { label: 'Retry' },
      }),
    );
    act(retryCurrentToast);

    await waitFor(() => expect(calls.remove).toHaveBeenCalledTimes(2));
    expect(calls.remove.mock.calls.map((call) => call[2])).toEqual([
      'native-list-intent',
      'native-list-intent',
    ]);
    expect(calls.uuid).toHaveBeenCalledOnce();
  });

  it('retries archive Undo with the same inverse intent', async () => {
    runTransactions();
    calls.uuid
      .mockReturnValueOnce('native-forward-intent')
      .mockReturnValueOnce('native-inverse-intent')
      .mockReturnValue('new-intent');
    calls.setArchived.mockResolvedValueOnce({});
    calls.undoArchive
      .mockRejectedValueOnce(new Error('SQLite unavailable'))
      .mockResolvedValueOnce({ kind: 'queued' });
    const mounted = renderHook(() => useListIndexMutations());

    act(() => mounted.result.current.onArchive(LIST));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));
    act(() => useToast.getState().undo());
    await waitFor(() =>
      expect(useToast.getState().current).toMatchObject({
        action: { label: 'Retry' },
      }),
    );
    act(retryCurrentToast);

    await waitFor(() => expect(calls.undoArchive).toHaveBeenCalledTimes(2));
    expect(calls.undoArchive.mock.calls.map((call) => call[3])).toEqual([
      'native-inverse-intent',
      'native-inverse-intent',
    ]);
    expect(calls.uuid).toHaveBeenCalledTimes(2);
  });
});
