import { instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '@/stores/toast';
import { useListSettings } from './useListSettings.native';

/**
 * The durable half of the settings surface (§P3-32, ADR-057).
 *
 * `useListSettings.test.tsx` owns the protocol — one key per decision, the `409` becoming a
 * confirmation, the echoed object. What only this file can hold is that the three additive
 * controls ride the **existing** `['list','patch']` intent while the behaviour change is the
 * new one, that each accepted write asks the sync engine for a pass, and that Undo is the
 * durable compensation rather than a second PATCH.
 *
 * The transaction service is stubbed at the module boundary, exactly as
 * `useListIndexMutations.native.test.tsx` stubs it: the service's own behaviour is
 * `listTransactions.test.ts`'s, against real SQLite.
 */

const calls = vi.hoisted(() => ({
  changeBehaviour: vi.fn(),
  commit: vi.fn(),
  patchSettings: vi.fn(),
  run: vi.fn(),
  sync: vi.fn(),
  undoSettings: vi.fn(),
  uuid: vi.fn(),
}));

vi.mock('expo-crypto', () => ({ randomUUID: calls.uuid }));

vi.mock('@/lib/sqlite/listTransactions', () => ({
  ListTransactionService: class {
    patchSettings = calls.patchSettings;
    changeBehaviour = calls.changeBehaviour;
    undoSettings = calls.undoSettings;
    commitArchiveUndoOffer = calls.commit;
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
  updatedAt: instant.parse('2026-08-26T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-26T08:00:00.000Z'),
};

function setup(list: List = LIST) {
  const onChanged = vi.fn();
  const onServerChanged = vi.fn();
  return {
    ...renderHook(() => useListSettings({ list, onChanged, onServerChanged })),
    onChanged,
    onServerChanged,
  };
}

const tapUndo = () => {
  const current = useToast.getState().current;
  if (current?.kind !== 'undo') throw new Error('no undo toast is being offered');
  act(() => current.onUndo());
};

beforeEach(() => {
  for (const call of Object.values(calls)) call.mockReset();
  calls.uuid.mockReturnValue('native-settings-intent');
  // Every transaction runs its work and resolves, which is what an accepted write is.
  calls.run.mockImplementation((work: (transaction: unknown) => unknown) =>
    Promise.resolve(work({})),
  );
  calls.undoSettings.mockResolvedValue({ kind: 'queued' });
  useToast.setState({ current: undefined });
});

describe('the additive controls ride the existing list patch', () => {
  it('accepts a capability into SQLite and asks for a sync pass', async () => {
    const { result, onChanged } = setup();

    act(() => result.current.setCapability('checkable', false));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());

    expect(calls.patchSettings).toHaveBeenCalledWith(
      {},
      LIST,
      { capabilities: { checkable: false } },
      'native-settings-intent',
    );
    expect(calls.changeBehaviour).not.toHaveBeenCalled();
    expect(calls.sync).toHaveBeenCalledWith('accepted-action');
  });

  it('draws the change before the transaction resolves', () => {
    calls.run.mockReturnValue(new Promise(() => undefined));
    const { result } = setup();

    act(() => result.current.setCapability('supportsLocation', true));

    expect(result.current.view?.capabilities.supportsLocation).toBe(true);
  });

  it('sends a rename as one title patch, and offers no undo', async () => {
    const { result, onChanged } = setup();

    act(() => result.current.rename('Shopping'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());

    expect(calls.patchSettings).toHaveBeenCalledWith(
      {},
      LIST,
      { title: 'Shopping' },
      'native-settings-intent',
    );
    expect(useToast.getState().current).toBeUndefined();
  });

  /** §P3-32: Undo is the durable compensation, never a second PATCH. */
  it('undoes through the compensation and never through another patch', async () => {
    const { result } = setup();

    act(() => result.current.setSlot(null));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));
    calls.patchSettings.mockClear();
    tapUndo();
    await waitFor(() => expect(calls.undoSettings).toHaveBeenCalled());

    expect(calls.undoSettings).toHaveBeenCalledWith(
      {},
      LIST.listId,
      'native-settings-intent',
      'native-settings-intent',
    );
    expect(calls.patchSettings).not.toHaveBeenCalled();
    expect(result.current.view?.slot).toBe('groceries');
  });

  it('takes the failed field back and offers Retry', async () => {
    calls.run.mockRejectedValue(new Error('SQLite is busy'));
    const { result } = setup();

    act(() => result.current.setCapability('checkable', false));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('message'));

    expect(result.current.view?.capabilities.checkable).toBe(true);
    expect(useToast.getState().current?.message).toBe(`Couldn't change "Groceries."`);
  });
});

describe('the behaviour intent', () => {
  /** The inventory extension: its own service call, and the upgrade still gets its Undo. */
  it('enqueues an upgrade and offers Undo', async () => {
    const { result, onChanged } = setup();

    act(() => result.current.changeBehaviour('watch'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());

    expect(calls.changeBehaviour).toHaveBeenCalledWith(
      {},
      LIST,
      { behaviour: 'watch' },
      'native-settings-intent',
    );
    expect(result.current.confirmation).toBeUndefined();
    expect(result.current.view?.behaviour).toBe('watch');
    expect(useToast.getState().current?.message).toBe('Now a watchlist');
    expect(calls.sync).toHaveBeenCalledWith('accepted-action');
  });

  it('undoes an upgrade through the compensation, never a downgrade POST', async () => {
    const { result } = setup();

    act(() => result.current.changeBehaviour('watch'));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));
    calls.changeBehaviour.mockClear();
    tapUndo();
    await waitFor(() => expect(calls.undoSettings).toHaveBeenCalled());

    expect(calls.changeBehaviour).not.toHaveBeenCalled();
    expect(result.current.view?.behaviour).toBe('collection');
  });

  it('leaves the behaviour alone when the enqueue is refused', async () => {
    calls.run.mockRejectedValue(new Error('SQLite is busy'));
    const { result } = setup();

    act(() => result.current.changeBehaviour('watch'));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('message'));

    expect(result.current.view?.behaviour).toBe('collection');
    expect(result.current.busy).toBe(false);
  });
});
