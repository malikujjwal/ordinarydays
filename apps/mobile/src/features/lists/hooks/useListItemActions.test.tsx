import { ApiError } from '@od/shared/client';
import { fixedClock, type Instant } from '@od/shared/time';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockProvider } from '@/hooks/useClock';
import type { ListItemRow } from '@/lib/sqlite/listItemsRepository';
import { useToast } from '@/stores/toast';
import { useListItemActions } from './useListItemActions';

/**
 * Deleting one item, and the six seconds it can be taken back in
 * (§P3-29, §P3-10, `interaction-contract.md` §4.1, §4.2).
 *
 * Web sends on the tap and uses the response deadline/token. Native commits on the tap and
 * accepts Undo offline; its dependent compensation receives that token in the sync engine.
 */

const calls = vi.hoisted(() => ({
  useDelete: vi.fn(),
  uuid: vi.fn(() => 'inverse-key'),
  remove: vi.fn(),
  undo: vi.fn(),
  patch: vi.fn(),
  activity: vi.fn(),
  prepareDelete: vi.fn(),
  undoDelete: vi.fn(),
  commitDelete: vi.fn(),
  requestDeleteSync: vi.fn(),
}));

vi.mock('@od/shared/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@od/shared/client')>()),
  deleteListItem: calls.remove,
  undoListOperation: calls.undo,
  patchListItem: calls.patch,
  getActivity: calls.activity,
}));

vi.mock('expo-crypto', () => ({ randomUUID: calls.uuid }));

vi.mock('./useDeleteListItem', () => ({
  useDeleteListItem: calls.useDelete,
}));

const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const NOW = '2026-08-27T14:00:00.000Z' as Instant;

const ITEM: ListItemRow = {
  itemId: 'itm_01J000000000000000000000AA',
  listId: LIST_ID,
  rank: 'm',
  title: 'Chicken',
  state: 'open',
};

function wrapper({ children }: { children: ReactNode }) {
  return <ClockProvider clock={fixedClock(NOW)}>{children}</ClockProvider>;
}

function setup() {
  const onSaved = vi.fn();
  const onRemoving = vi.fn();
  const onRemoved = vi.fn();
  const { result } = renderHook(
    () => useListItemActions({ onSaved, onRemoving, onRemoved }),
    { wrapper },
  );
  return { actions: result, onSaved, onRemoving, onRemoved };
}

const receipt = (expiresAt: string) => ({
  affectedCount: 1,
  undoToken: 'opaque-token',
  undoExpiresAt: expiresAt as Instant,
});

beforeEach(() => {
  vi.clearAllMocks();
  calls.useDelete.mockReturnValue({ kind: 'online' });
  calls.uuid.mockReset();
  calls.uuid.mockReturnValue('inverse-key');
  useToast.setState({ current: undefined });
  calls.patch.mockResolvedValue(ITEM);
  calls.prepareDelete.mockResolvedValue(undefined);
  calls.undoDelete.mockResolvedValue(undefined);
  calls.commitDelete.mockResolvedValue(undefined);
});

describe('delete', () => {
  it('issues the delete immediately and offers the six-second undo from the server', async () => {
    calls.remove.mockResolvedValue(receipt('2026-08-27T14:00:06.000Z'));
    const { actions, onRemoved } = setup();

    act(() => actions.current.remove(ITEM));

    // On the tap, not at the end of the window (P2-24).
    await waitFor(() =>
      expect(calls.remove).toHaveBeenCalledWith(
        expect.anything(),
        LIST_ID,
        ITEM.itemId,
        'inverse-key',
      ),
    );
    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));

    const toast = useToast.getState().current;
    expect(toast?.message).toBe('Chicken deleted');
    expect(toast?.duration).toBe(6000);
    expect(calls.undo).not.toHaveBeenCalled();
  });

  /** The clamp, not the arithmetic: a generous server deadline still buys six seconds. */
  it('never offers longer than the contract, whatever the deadline says', async () => {
    calls.remove.mockResolvedValue(receipt('2026-08-27T14:05:00.000Z'));
    setup().actions.current.remove(ITEM);

    await waitFor(() => expect(useToast.getState().current?.duration).toBe(6000));
  });

  /** Past its own offer deadline on arrival: the delete stands, and Undo is not offered. */
  it('offers nothing when the deadline has already passed', async () => {
    calls.remove.mockResolvedValue(receipt('2026-08-27T13:59:59.000Z'));
    const { actions, onRemoved } = setup();

    act(() => actions.current.remove(ITEM));

    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
    expect(useToast.getState().current).toBeUndefined();
  });

  it('names the item and offers Retry when the delete fails', async () => {
    calls.remove.mockRejectedValue(
      new ApiError('internal', 'Try again.', 503, 'req-delete'),
    );
    const { actions } = setup();

    act(() => actions.current.remove(ITEM));

    await waitFor(() => expect(useToast.getState().current?.kind).toBe('message'));
    const toast = useToast.getState().current;
    expect(toast?.message).toBe('Something went wrong.');
    expect(toast && 'action' in toast ? toast.action?.label : undefined).toBe('Retry');
  });
});

describe('native durable delete', () => {
  beforeEach(() => {
    calls.useDelete.mockReturnValue({
      kind: 'durable',
      prepare: calls.prepareDelete,
      undo: calls.undoDelete,
      commit: calls.commitDelete,
      requestSync: calls.requestDeleteSync,
    });
    calls.uuid.mockReturnValueOnce('delete-key').mockReturnValueOnce('undo-key');
  });

  it('offers Undo immediately and leaves every network write to the ordered sync lane', async () => {
    const { actions, onRemoving } = setup();

    act(() => actions.current.remove(ITEM));

    await waitFor(() =>
      expect(calls.prepareDelete).toHaveBeenCalledWith(ITEM, 'delete-key'),
    );
    expect(onRemoving).toHaveBeenCalledTimes(1);
    expect(calls.requestDeleteSync).toHaveBeenCalledTimes(1);
    expect(calls.remove).not.toHaveBeenCalled();
    expect(useToast.getState().current).toEqual(
      expect.objectContaining({
        kind: 'undo',
        message: 'Chicken deleted',
        duration: 6000,
      }),
    );
  });

  it('accepts Undo locally while offline and queues the dependent compensation', async () => {
    const { actions, onRemoving, onRemoved } = setup();
    act(() => actions.current.remove(ITEM));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));

    act(() => useToast.getState().undo());

    await waitFor(() =>
      expect(calls.undoDelete).toHaveBeenCalledWith('delete-key', 'undo-key'),
    );
    expect(calls.undo).not.toHaveBeenCalled();
    expect(calls.remove).not.toHaveBeenCalled();
    expect(calls.requestDeleteSync).toHaveBeenCalledTimes(2);
    expect(onRemoving).toHaveBeenCalledTimes(2);
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it('retires an untouched offer without delaying or repeating the delete', async () => {
    const { actions } = setup();
    act(() => actions.current.remove(ITEM));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));

    act(() => useToast.getState().dismiss());

    await waitFor(() => expect(calls.commitDelete).toHaveBeenCalledWith('delete-key'));
    expect(calls.remove).not.toHaveBeenCalled();
  });
});

describe('undo within the offer window', () => {
  it('sends the opaque token under its own key and reconstructs nothing', async () => {
    calls.remove.mockResolvedValue(receipt('2026-08-27T14:00:06.000Z'));
    calls.undo.mockResolvedValue({
      data: { outcome: 'applied', affectedCount: 1 },
      meta: { requestId: 'req-1' },
    });
    const { actions, onRemoved } = setup();

    act(() => actions.current.remove(ITEM));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));

    act(() => useToast.getState().undo());

    await waitFor(() => expect(calls.undo).toHaveBeenCalledTimes(1));
    expect(calls.undo).toHaveBeenCalledWith(
      expect.anything(),
      LIST_ID,
      'opaque-token',
      'inverse-key',
    );
    // The server restores the id, rank, links and provenance; the client sends no rows back.
    expect(calls.undo.mock.calls[0]).toHaveLength(4);
    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(2));
  });

  /**
   * `expired` and `no_longer_applicable` are `200`s that wrote nothing, so the row did not come
   * back and the user is told rather than left believing it did.
   */
  it('says so when the token no longer applies', async () => {
    calls.remove.mockResolvedValue(receipt('2026-08-27T14:00:06.000Z'));
    calls.undo.mockResolvedValue({
      data: { outcome: 'expired' },
      meta: { requestId: 'req-2' },
    });
    const { actions } = setup();

    act(() => actions.current.remove(ITEM));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));
    act(() => useToast.getState().undo());

    await waitFor(() =>
      expect(useToast.getState().current?.message).toBe(
        'Couldn\'t undo deleting "Chicken."',
      ),
    );
  });

  /** Letting the window close commits: nothing further is sent (§4.2). */
  it('sends nothing when the window closes untouched', async () => {
    calls.remove.mockResolvedValue(receipt('2026-08-27T14:00:06.000Z'));
    const { actions } = setup();

    act(() => actions.current.remove(ITEM));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));

    act(() => useToast.getState().dismiss());

    expect(calls.undo).not.toHaveBeenCalled();
    expect(calls.remove).toHaveBeenCalledTimes(1);
  });
});

describe('a field edit', () => {
  it('reports acceptance and refreshes the projection', async () => {
    const { actions, onSaved } = setup();

    await expect(actions.current.save(ITEM, { title: 'Tortillas' })).resolves.toBe(true);
    expect(calls.patch).toHaveBeenCalledWith(expect.anything(), LIST_ID, ITEM.itemId, {
      title: 'Tortillas',
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('reports refusal and names the item in the toast', async () => {
    /* The migration fence: retryable, and the sheet keeps what it was showing. */
    calls.patch.mockRejectedValue(
      new ApiError('internal', 'Migrating.', 503, 'req-fence'),
    );
    const { actions, onSaved } = setup();

    await expect(actions.current.save(ITEM, { title: 'Tortillas' })).resolves.toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
    const toast = useToast.getState().current;
    expect(toast?.message).toBe('Something went wrong.');
    expect(toast && 'action' in toast ? toast.action?.label : undefined).toBe('Retry');
  });
});

describe('the provenance probe (§7.5)', () => {
  it('answers false only on a 404', async () => {
    const { actions } = setup();

    calls.activity.mockRejectedValueOnce(
      new ApiError('not_found', 'Gone.', 404, 'req-source'),
    );
    await expect(actions.current.sourceResolves('act_1')).resolves.toBe(false);

    // Offline, or a server fault: unknown is not gone, so the caller still navigates.
    calls.activity.mockRejectedValueOnce(new Error('Network request failed'));
    await expect(actions.current.sourceResolves('act_1')).resolves.toBe(true);

    calls.activity.mockResolvedValueOnce({ activity: {} });
    await expect(actions.current.sourceResolves('act_1')).resolves.toBe(true);
  });
});

it('hands a failure after dismissal to the editor-owned latest-draft retry', async () => {
  let reject: (error: unknown) => void = () => undefined;
  calls.patch.mockReturnValueOnce(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  const retrySave = vi.fn();
  const { result, unmount } = renderHook(
    () =>
      useListItemActions({
        onSaved: vi.fn(),
        onRemoved: vi.fn(),
        inlineSaveFeedback: true,
        retrySave,
      }),
    { wrapper },
  );
  let pending: Promise<boolean> = Promise.resolve(false);
  act(() => {
    pending = result.current.save(ITEM, { title: 'Earlier request' });
  });
  unmount();
  await act(async () => {
    reject(new ApiError('internal', 'Failed', 503, 'req_failed'));
    await pending;
  });
  const toast = useToast.getState().current;
  if (!toast || !('action' in toast) || !toast.action)
    throw new Error('Expected a surviving Retry action');
  toast.action.onPress();
  expect(retrySave).toHaveBeenCalledOnce();
  expect(calls.patch).toHaveBeenCalledTimes(1);
});

it('offers the latest draft Retry when an already-failed editor closes and releases it with the toast', async () => {
  calls.patch.mockRejectedValue(new ApiError('internal', 'Failed', 503, 'req_failed'));
  const retrySave = vi.fn();
  const releaseFailed = vi.fn();
  const { result, unmount } = renderHook(
    () =>
      useListItemActions({
        onSaved: vi.fn(),
        onRemoved: vi.fn(),
        inlineSaveFeedback: true,
        retrySave,
        releaseFailed,
      }),
    { wrapper },
  );
  await act(async () => {
    await result.current.save(ITEM, { title: 'Failed draft' });
  });
  expect(useToast.getState().current).toBeUndefined();
  act(() => result.current.finishEditing(true));
  unmount();
  expect(useToast.getState().current?.message).toBe('Something went wrong.');
  await act(async () => useToast.getState().dismiss());
  expect(releaseFailed).toHaveBeenCalledOnce();
});

it('transfers all failed drafts to a replacement failure toast from the same editor', async () => {
  calls.patch.mockRejectedValue(new ApiError('internal', 'Failed', 503, 'req_failed'));
  const retrySave = vi.fn();
  const releaseFailed = vi.fn();
  const { result, unmount } = renderHook(
    () =>
      useListItemActions({
        onSaved: vi.fn(),
        onRemoved: vi.fn(),
        inlineSaveFeedback: true,
        retrySave,
        releaseFailed,
      }),
    { wrapper },
  );
  const closed = result.current;
  act(() => closed.finishEditing(false));
  unmount();
  await act(async () => {
    await closed.save(ITEM, { title: 'Latest title' });
  });
  await act(async () => {
    await closed.save(ITEM, { note: 'Latest note' });
  });
  expect(releaseFailed).not.toHaveBeenCalled();
  const toast = useToast.getState().current;
  if (!toast || !('action' in toast) || !toast.action) throw new Error('Expected Retry');
  await act(async () => {
    useToast.getState().dismiss();
    toast.action?.onPress();
  });
  expect(retrySave).toHaveBeenCalledOnce();
  expect(releaseFailed).not.toHaveBeenCalled();
});
