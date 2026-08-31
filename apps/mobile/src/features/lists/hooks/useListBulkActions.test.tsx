import { ApiError } from '@od/shared/client';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '@/stores/toast';
import { useListBulkActions } from './useListBulkActions';

const calls = vi.hoisted(() => ({
  clear: vi.fn(),
  uncheck: vi.fn(),
  undo: vi.fn(),
  uuid: vi.fn(),
}));

vi.mock('@od/shared/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@od/shared/client')>()),
  clearCheckedListItems: calls.clear,
  uncheckAllListItems: calls.uncheck,
  undoListOperation: calls.undo,
}));

vi.mock('expo-crypto', () => ({ randomUUID: calls.uuid }));
vi.mock('./useListIndexMutations', () => ({
  useListIndexMutations: () => ({ onArchive: vi.fn(), onDelete: vi.fn() }),
}));

const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const receipt = {
  affectedCount: 2,
  undoToken: 'undo-bulk',
  undoExpiresAt: '2026-08-31T16:00:10.000Z',
};

function setup() {
  const onChanged = vi.fn();
  const mounted = renderHook(() => useListBulkActions(onChanged));
  return { ...mounted, onChanged };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.uuid.mockReturnValue('bulk-key');
  useToast.getState().dismiss();
  useToast.setState({ current: undefined });
});

afterEach(() => vi.useRealTimers());

describe('List bulk actions', () => {
  it('clears the checked set, refreshes, and expires its List-detail toast', async () => {
    vi.useFakeTimers();
    calls.clear.mockResolvedValue(receipt);
    const mounted = setup();

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await mounted.result.current.clearDone(LIST_ID);
    });

    expect(accepted).toBe(true);
    expect(calls.clear).toHaveBeenCalledWith(expect.anything(), LIST_ID, 'bulk-key');
    expect(mounted.onChanged).toHaveBeenCalledOnce();
    expect(useToast.getState().current).toMatchObject({
      kind: 'undo',
      message: '2 items cleared',
      duration: 10_000,
    });

    act(() => vi.advanceTimersByTime(10_000));
    expect(useToast.getState().current).toBeUndefined();
  });

  it('unchecks the checked set without deleting it and expires its toast', async () => {
    vi.useFakeTimers();
    calls.uncheck.mockResolvedValue(receipt);
    const mounted = setup();

    await act(async () => {
      await mounted.result.current.uncheckAll(LIST_ID);
    });

    expect(calls.uncheck).toHaveBeenCalledWith(expect.anything(), LIST_ID, 'bulk-key');
    expect(mounted.onChanged).toHaveBeenCalledOnce();
    expect(useToast.getState().current).toMatchObject({
      kind: 'undo',
      message: '2 items unchecked',
      duration: 10_000,
    });

    act(() => vi.advanceTimersByTime(10_000));
    expect(useToast.getState().current).toBeUndefined();
  });

  it('rejects the optimistic preview on failure and expires the Retry toast', async () => {
    vi.useFakeTimers();
    calls.clear.mockRejectedValue(
      new ApiError('internal', 'Server unavailable.', 503, 'req-bulk'),
    );
    const mounted = setup();

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await mounted.result.current.clearDone(LIST_ID);
    });

    expect(accepted).toBe(false);
    expect(mounted.onChanged).not.toHaveBeenCalled();
    expect(useToast.getState().current).toMatchObject({
      kind: 'message',
      message: 'Something went wrong.',
      action: { label: 'Retry' },
    });

    act(() => vi.advanceTimersByTime(6_000));
    expect(useToast.getState().current).toBeUndefined();
  });
});
