import { ApiError, NetworkError } from '@od/shared/client';
import { instant } from '@od/shared/schemas';
import { fixedClock, type Instant } from '@od/shared/time';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockProvider } from '@/hooks/useClock';
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
const NOW = instant.parse('2026-08-31T16:00:00.000Z');
function bulkReceipt(
  overrides: Partial<{
    affectedCount: number;
    undoToken: string;
    undoExpiresAt: Instant;
  }> = {},
) {
  return {
    affectedCount: 2,
    undoToken: 'undo-bulk',
    undoExpiresAt: instant.parse('2026-08-31T16:00:10.000Z'),
    ...overrides,
  };
}

function setup(now: Instant = NOW) {
  const onChanged = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ClockProvider clock={fixedClock(now)}>{children}</ClockProvider>
  );
  const mounted = renderHook(() => useListBulkActions(onChanged), { wrapper });
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
    const receipt = bulkReceipt();
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
      undoExpiresAt: receipt.undoExpiresAt,
    });

    act(() => vi.advanceTimersByTime(10_000));
    expect(useToast.getState().current).toBeUndefined();
  });

  it('unchecks the checked set without deleting it and expires its toast', async () => {
    vi.useFakeTimers();
    const receipt = bulkReceipt();
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
      undoExpiresAt: receipt.undoExpiresAt,
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
      message: "Couldn't clear checked items.",
      requestId: 'req-bulk',
      action: { label: 'Retry' },
    });

    act(() => vi.advanceTimersByTime(6_000));
    expect(useToast.getState().current).toBeUndefined();
  });

  it('names an Uncheck all failure and carries its request id', async () => {
    calls.uncheck.mockRejectedValue(
      new ApiError('internal', 'Server unavailable.', 503, 'req-uncheck'),
    );
    const mounted = setup();

    await act(async () => {
      await mounted.result.current.uncheckAll(LIST_ID);
    });

    expect(useToast.getState().current).toMatchObject({
      message: "Couldn't uncheck items.",
      requestId: 'req-uncheck',
      action: { label: 'Retry' },
    });
  });

  it.each([
    ['forbidden', 403],
    ['not_found', 404],
    ['rate_limited', 429],
  ] as const)(
    'preserves the contracted %s API message without offering Retry',
    async (code, status) => {
      calls.clear.mockRejectedValue(
        new ApiError(
          code,
          `Contracted ${String(status)} message.`,
          status,
          'req-contract',
        ),
      );
      const mounted = setup();

      await act(async () => {
        await mounted.result.current.clearDone(LIST_ID);
      });

      expect(useToast.getState().current).toMatchObject({
        message: `Contracted ${String(status)} message.`,
        requestId: 'req-contract',
      });
      expect(useToast.getState().current).not.toHaveProperty('action');
    },
  );

  it('offers Retry for a client deadline failure from either bulk action', async () => {
    calls.clear.mockRejectedValue(new NetworkError('The request timed out.', undefined));
    calls.uncheck.mockRejectedValue(
      new NetworkError('The request timed out.', undefined),
    );
    const mounted = setup();

    await act(async () => {
      await mounted.result.current.clearDone(LIST_ID);
    });
    expect(useToast.getState().current).toMatchObject({
      message: "Couldn't clear checked items.",
      action: { label: 'Retry' },
    });

    await act(async () => {
      await mounted.result.current.uncheckAll(LIST_ID);
    });
    expect(useToast.getState().current).toMatchObject({
      message: "Couldn't uncheck items.",
      action: { label: 'Retry' },
    });
  });

  it('reuses the original idempotency key when Clear checked is retried', async () => {
    calls.uuid
      .mockReset()
      .mockReturnValueOnce('bulk-key')
      .mockReturnValue('replacement-key');
    calls.clear
      .mockRejectedValueOnce(new ApiError('internal', 'Unavailable.', 503, 'req-bulk'))
      .mockResolvedValueOnce(bulkReceipt({ affectedCount: 0 }));
    const mounted = setup();

    await act(async () => {
      await mounted.result.current.clearDone(LIST_ID);
    });
    const failure = useToast.getState().current;
    if (failure?.kind !== 'message') throw new Error('Expected a retry message');
    act(() => failure.action?.onPress());

    await waitFor(() => expect(calls.clear).toHaveBeenCalledTimes(2));
    expect(calls.clear).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      LIST_ID,
      'bulk-key',
    );
    expect(calls.clear).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      LIST_ID,
      'bulk-key',
    );
  });

  it('starts the same optimistic lifecycle again while a Retry is pending', async () => {
    const lifecycle = { onStarted: vi.fn(), onRejected: vi.fn() };
    calls.clear
      .mockRejectedValueOnce(new ApiError('internal', 'Unavailable.', 503, 'req-bulk'))
      .mockReturnValueOnce(new Promise(() => undefined));
    const mounted = setup();

    await act(async () => {
      await mounted.result.current.clearDone(LIST_ID, lifecycle);
    });
    expect(lifecycle.onStarted).toHaveBeenCalledOnce();
    expect(lifecycle.onRejected).toHaveBeenCalledOnce();
    const failure = useToast.getState().current;
    if (failure?.kind !== 'message') throw new Error('Expected a retry message');

    act(() => failure.action?.onPress());

    await waitFor(() => expect(calls.clear).toHaveBeenCalledTimes(2));
    expect(lifecycle.onStarted).toHaveBeenCalledTimes(2);
    expect(lifecycle.onRejected).toHaveBeenCalledOnce();
  });

  it('shortens the Clear checked offer to the server deadline after a slow response', async () => {
    vi.useFakeTimers();
    const receipt = bulkReceipt();
    calls.clear.mockResolvedValue(receipt);
    const mounted = setup(instant.parse('2026-08-31T16:00:04.000Z'));

    await act(async () => {
      await mounted.result.current.clearDone(LIST_ID);
    });

    expect(useToast.getState().current).toMatchObject({
      message: '2 items cleared',
      duration: 6_000,
      undoExpiresAt: receipt.undoExpiresAt,
    });
  });

  it('shortens the Uncheck all offer to the server deadline after a slow response', async () => {
    vi.useFakeTimers();
    const receipt = bulkReceipt();
    calls.uncheck.mockResolvedValue(receipt);
    const mounted = setup(instant.parse('2026-08-31T16:00:07.500Z'));

    await act(async () => {
      await mounted.result.current.uncheckAll(LIST_ID);
    });

    expect(useToast.getState().current).toMatchObject({
      message: '2 items unchecked',
      duration: 2_500,
      undoExpiresAt: receipt.undoExpiresAt,
    });
  });

  it('does not offer either bulk Undo after the server deadline has passed', async () => {
    const receipt = bulkReceipt();
    calls.clear.mockResolvedValue(receipt);
    calls.uncheck.mockResolvedValue(receipt);
    const mounted = setup(instant.parse('2026-08-31T16:00:10.000Z'));

    await act(async () => {
      await mounted.result.current.clearDone(LIST_ID);
    });
    expect(useToast.getState().current).toBeUndefined();

    await act(async () => {
      await mounted.result.current.uncheckAll(LIST_ID);
    });
    expect(useToast.getState().current).toBeUndefined();
  });

  it('names a failed bulk Undo, carries its request id, and reuses its key on Retry', async () => {
    calls.uuid
      .mockReset()
      .mockReturnValueOnce('bulk-key')
      .mockReturnValueOnce('undo-key')
      .mockReturnValue('replacement-key');
    calls.clear.mockResolvedValue(bulkReceipt());
    calls.undo
      .mockRejectedValueOnce(new ApiError('internal', 'Unavailable.', 503, 'req-undo'))
      .mockResolvedValueOnce({});
    const mounted = setup();

    await act(async () => {
      await mounted.result.current.clearDone(LIST_ID);
    });
    const offer = useToast.getState().current;
    if (offer?.kind !== 'undo') throw new Error('Expected a bulk Undo offer');
    act(() => useToast.getState().undo(offer.id));

    await waitFor(() =>
      expect(useToast.getState().current).toMatchObject({
        kind: 'message',
        message: "Couldn't undo clearing checked items.",
        requestId: 'req-undo',
        action: { label: 'Retry' },
      }),
    );
    const failure = useToast.getState().current;
    if (failure?.kind !== 'message') throw new Error('Expected an Undo failure');
    act(() => failure.action?.onPress());

    await waitFor(() => expect(calls.undo).toHaveBeenCalledTimes(2));
    expect(calls.undo).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      LIST_ID,
      'undo-bulk',
      'undo-key',
    );
    expect(calls.undo).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      LIST_ID,
      'undo-bulk',
      'undo-key',
    );
    expect(calls.uuid).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(useToast.getState().current).toBeUndefined());
  });
});
