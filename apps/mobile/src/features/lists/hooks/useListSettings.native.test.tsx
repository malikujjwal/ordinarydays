import { instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '@/stores/toast';
import { useListSettings } from './useListSettings.native';

const calls = vi.hoisted(() => ({
  patch: vi.fn(),
  undo: vi.fn(),
  commit: vi.fn(),
  run: vi.fn(),
  sync: vi.fn(),
  uuid: vi.fn(),
}));
vi.mock('expo-crypto', () => ({ randomUUID: calls.uuid }));
vi.mock('@/lib/sqlite/listTransactions', () => ({
  ListTransactionService: class {
    patchSettings = calls.patch;
    undoSettings = calls.undo;
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
  schemaVersion: 2,
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  templateKey: 'blank',
  title: 'Ideas',
  icon: 'list',
  emptyStateCopy: 'Add an item.',
  itemStateMode: { mode: 'none' },
  featureConfig: {},
  slot: null,
  itemCount: 0,
  doneCount: 0,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-08-28T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-28T09:00:00.000Z'),
};

beforeEach(() => {
  for (const call of Object.values(calls)) call.mockReset();
  calls.uuid.mockReturnValue('intent_settings');
  calls.run.mockImplementation((task: (transaction: object) => unknown) =>
    Promise.resolve(task({})),
  );
  calls.patch.mockResolvedValue({});
  calls.undo.mockResolvedValue({ kind: 'queued' });
  useToast.setState({ current: undefined });
});

describe('native canonical List settings', () => {
  it('persists one canonical outbox patch and updates the offline projection immediately', async () => {
    const onChanged = vi.fn();
    const mounted = renderHook(() =>
      useListSettings({ list: LIST, onChanged, onServerChanged: vi.fn() }),
    );

    act(() => mounted.result.current.setFeatureEnabled('place', true));

    expect(mounted.result.current.view?.featureConfig.place).toEqual({ enabled: true });
    await waitFor(() =>
      expect(calls.patch).toHaveBeenCalledWith(
        {},
        LIST,
        { featureConfig: { place: { enabled: true } } },
        'intent_settings',
      ),
    );
    expect(calls.sync).toHaveBeenCalledWith('accepted-action');
  });

  it('offers the same six-second settings Undo and queues the opaque inverse', async () => {
    const mounted = renderHook(() =>
      useListSettings({ list: LIST, onChanged: vi.fn(), onServerChanged: vi.fn() }),
    );
    act(() => mounted.result.current.setSlot('groceries'));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));

    act(() => {
      const toast = useToast.getState().current;
      if (toast?.kind !== 'undo') throw new Error('Expected Undo');
      toast.onUndo();
    });

    await waitFor(() =>
      expect(calls.undo).toHaveBeenCalledWith(
        {},
        LIST.listId,
        'intent_settings',
        'intent_settings',
      ),
    );
  });
});
