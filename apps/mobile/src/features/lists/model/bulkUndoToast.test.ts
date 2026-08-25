import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '@/stores/toast';
import {
  BULK_UNDO_DURATION_MS,
  clearedItemsToast,
  uncheckedItemsToast,
} from './bulkUndoToast';

/**
 * §P3-10's client requirement: "each bulk operation's toast appears with a 10-second window".
 *
 * The shared toast defaults to **six** seconds, so the ten has to be asserted somewhere. This
 * is that somewhere — the descriptor these actions hand the toast singleton, checked both as a
 * value and through the store that renders it.
 */

beforeEach(() => {
  act(() => {
    useToast.setState({ current: undefined });
  });
});

describe('the bulk undo toast', () => {
  it.each([
    ['cleared', clearedItemsToast, '7 items cleared'],
    ['unchecked', uncheckedItemsToast, '7 items unchecked'],
  ])('names the count and offers ten seconds for %s', (_case, build, message) => {
    const toast = build({ affectedCount: 7, onUndo: vi.fn(), onCommit: vi.fn() });

    expect(toast.message).toBe(message);
    expect(toast.duration).toBe(10_000);
    expect(BULK_UNDO_DURATION_MS).toBe(10_000);
  });

  it('reads as a sentence about one row too', () => {
    expect(
      clearedItemsToast({ affectedCount: 1, onUndo: vi.fn(), onCommit: vi.fn() }).message,
    ).toBe('1 item cleared');
  });

  /**
   * Through the store, so a regression that dropped the duration on the way to `showUndo` —
   * and silently took the six-second default — fails here rather than shipping.
   */
  it('reaches the toast singleton with its ten-second window intact', () => {
    const onUndo = vi.fn();
    const onCommit = vi.fn();

    act(() => {
      useToast
        .getState()
        .showUndo(clearedItemsToast({ affectedCount: 7, onUndo, onCommit }));
    });

    const current = useToast.getState().current;
    expect(current?.kind).toBe('undo');
    expect(current?.duration).toBe(10_000);
    expect(current?.message).toBe('7 items cleared');
  });

  /**
   * The network call fires immediately and Undo is a **compensating** call (the P2-24 rule),
   * so tapping runs `onUndo` and letting the window close runs `onCommit`. Exactly one of
   * them, ever.
   */
  it('runs the compensation on Undo and the commit on dismissal, never both', () => {
    const onUndo = vi.fn();
    const onCommit = vi.fn();

    act(() => {
      useToast
        .getState()
        .showUndo(uncheckedItemsToast({ affectedCount: 3, onUndo, onCommit }));
    });
    act(() => {
      useToast.getState().undo();
    });

    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();

    act(() => {
      useToast
        .getState()
        .showUndo(clearedItemsToast({ affectedCount: 2, onUndo, onCommit }));
    });
    act(() => {
      useToast.getState().dismiss();
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
