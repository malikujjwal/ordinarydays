import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '@/stores/toast';
import { useListBulkActions } from './useListBulkActions.native';

const service = vi.hoisted(() => ({
  deleteItem: vi.fn(async () => ({})),
  patchItem: vi.fn(async () => ({})),
  undoDeletedItem: vi.fn(async () => ({ kind: 'queued' as const })),
  commitItemDeleteUndoOffer: vi.fn(async () => undefined),
}));
const calls = vi.hoisted(() => ({ uuid: vi.fn() }));
const nativeState = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('@/lib/sqlite/listTransactions', () => ({
  ListTransactionService: class {
    deleteItem = service.deleteItem;
    patchItem = service.patchItem;
    undoDeletedItem = service.undoDeletedItem;
    commitItemDeleteUndoOffer = service.commitItemDeleteUndoOffer;
  },
}));
vi.mock('@/lib/sqlite/nativeState', () => ({
  requireActiveNativeState: () => nativeState.current,
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => calls.uuid() }));
vi.mock('@/features/lists/hooks/useListIndexMutations', () => ({
  useListIndexMutations: () => ({ onArchive: vi.fn(), onDelete: vi.fn() }),
}));

const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const TRANSACTION = { database: {}, changed: vi.fn() };

const row = (id: string, state: 'open' | 'done') => ({
  itemId: `itm_01J00000000000000000000${id}`,
  listId: LIST_ID,
  rank: id.toLowerCase(),
  title: id,
  state,
});

function nativeStub(items: readonly ReturnType<typeof row>[]) {
  const run = vi.fn(async (task: (transaction: typeof TRANSACTION) => Promise<unknown>) =>
    task(TRANSACTION),
  );
  const request = vi.fn();
  const readSnapshot = vi.fn(async () => ({ commitRevision: 1, items }));
  nativeState.current = {
    lists: {},
    listItems: { readSnapshot },
    outbox: {},
    account: { transactions: { run } },
    sync: { request },
  };
  return { run, request, readSnapshot };
}

beforeEach(() => {
  let minted = 0;
  calls.uuid.mockReset().mockImplementation(() => {
    minted += 1;
    return `id-${minted}`;
  });
  service.deleteItem.mockClear();
  service.patchItem.mockClear();
  service.undoDeletedItem.mockClear();
  service.commitItemDeleteUndoOffer.mockClear();
  useToast.setState({ current: undefined });
});

describe('durable native bulk actions', () => {
  it('clears checked rows as one local transaction of durable deletes', async () => {
    const built = nativeStub([row('AA', 'done'), row('BB', 'open'), row('CC', 'done')]);
    const onChanged = vi.fn();
    const mounted = renderHook(() => useListBulkActions(onChanged));

    let accepted = false;
    await act(async () => {
      accepted = await mounted.result.current.clearDone(LIST_ID);
    });

    expect(accepted).toBe(true);
    expect(built.run).toHaveBeenCalledTimes(1);
    expect(service.deleteItem).toHaveBeenCalledTimes(2);
    expect(service.deleteItem).toHaveBeenNthCalledWith(1, TRANSACTION, {
      listId: LIST_ID,
      itemId: row('AA', 'done').itemId,
      intentId: 'id-1',
      idempotencyKey: 'id-1',
    });
    expect(built.request).toHaveBeenCalledWith('accepted-action');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(useToast.getState().current).toMatchObject({
      kind: 'undo',
      message: '2 items cleared',
      duration: 10_000,
    });
  });

  it('undoes a clear by queuing each delete compensation on its original identity', async () => {
    nativeStub([row('AA', 'done'), row('CC', 'done')]);
    const onChanged = vi.fn();
    const mounted = renderHook(() => useListBulkActions(onChanged));
    await act(async () => {
      await mounted.result.current.clearDone(LIST_ID);
    });

    act(() => useToast.getState().undo());

    await waitFor(() => expect(service.undoDeletedItem).toHaveBeenCalledTimes(2));
    expect(service.undoDeletedItem).toHaveBeenNthCalledWith(
      1,
      TRANSACTION,
      'id-1',
      'id-3',
    );
    expect(service.undoDeletedItem).toHaveBeenNthCalledWith(
      2,
      TRANSACTION,
      'id-2',
      'id-4',
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
  });

  it('retires the unaccepted delete offers when the window commits', async () => {
    nativeStub([row('AA', 'done')]);
    const mounted = renderHook(() => useListBulkActions(vi.fn()));
    await act(async () => {
      await mounted.result.current.clearDone(LIST_ID);
    });

    act(() => useToast.getState().dismiss());

    await waitFor(() =>
      expect(service.commitItemDeleteUndoOffer).toHaveBeenCalledWith(TRANSACTION, 'id-1'),
    );
  });

  it('unchecks every checked row as durable patches, and undoes them the same way', async () => {
    nativeStub([row('AA', 'done'), row('BB', 'done')]);
    const mounted = renderHook(() => useListBulkActions(vi.fn()));
    await act(async () => {
      await mounted.result.current.uncheckAll(LIST_ID);
    });

    expect(service.patchItem).toHaveBeenCalledTimes(2);
    expect(service.patchItem).toHaveBeenNthCalledWith(1, TRANSACTION, {
      listId: LIST_ID,
      itemId: row('AA', 'done').itemId,
      intentId: 'id-1',
      idempotencyKey: 'id-1',
      input: { state: 'open' },
    });
    expect(useToast.getState().current).toMatchObject({
      kind: 'undo',
      message: '2 items unchecked',
      duration: 10_000,
    });

    act(() => useToast.getState().undo());

    await waitFor(() => expect(service.patchItem).toHaveBeenCalledTimes(4));
    expect(service.patchItem).toHaveBeenNthCalledWith(3, TRANSACTION, {
      listId: LIST_ID,
      itemId: row('AA', 'done').itemId,
      intentId: 'id-3',
      idempotencyKey: 'id-3',
      input: { state: 'done' },
    });
  });

  it('undoes surviving uncheck-all rows when another client deleted one item', async () => {
    nativeStub([row('AA', 'done'), row('BB', 'done')]);
    const mounted = renderHook(() => useListBulkActions(vi.fn()));
    await act(async () => {
      await mounted.result.current.uncheckAll(LIST_ID);
    });

    service.patchItem.mockImplementation(async (_transaction, variables) => {
      if (
        variables.itemId === row('AA', 'done').itemId &&
        variables.input?.state === 'done'
      ) {
        throw new Error('The item is no longer available locally.');
      }
      return {};
    });

    act(() => useToast.getState().undo());

    await waitFor(() => expect(service.patchItem).toHaveBeenCalledTimes(4));
    expect(service.patchItem).toHaveBeenNthCalledWith(4, TRANSACTION, {
      listId: LIST_ID,
      itemId: row('BB', 'done').itemId,
      intentId: 'id-4',
      idempotencyKey: 'id-4',
      input: { state: 'done' },
    });
    await waitFor(() => expect(useToast.getState().current).toBeUndefined());
  });

  it('does nothing at all for a list with no checked rows', async () => {
    const built = nativeStub([row('AA', 'open')]);
    const mounted = renderHook(() => useListBulkActions(vi.fn()));

    let accepted = false;
    await act(async () => {
      accepted = await mounted.result.current.clearDone(LIST_ID);
    });

    expect(accepted).toBe(true);
    expect(built.run).not.toHaveBeenCalled();
    expect(useToast.getState().current).toBeUndefined();
  });

  it('reports a refused local commit and leaves the caller to roll back its preview', async () => {
    const built = nativeStub([row('AA', 'done')]);
    built.run.mockRejectedValue(new Error('The item is no longer available locally.'));
    const lifecycle = { onStarted: vi.fn(), onRejected: vi.fn() };
    const mounted = renderHook(() => useListBulkActions(vi.fn()));

    let accepted = true;
    await act(async () => {
      accepted = await mounted.result.current.clearDone(LIST_ID, lifecycle);
    });

    expect(accepted).toBe(false);
    expect(lifecycle.onStarted).toHaveBeenCalledOnce();
    expect(lifecycle.onRejected).toHaveBeenCalledOnce();
    expect(useToast.getState().current).toMatchObject({
      kind: 'message',
      message: "Couldn't clear checked items.",
    });
  });
});
