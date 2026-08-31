import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from './toast';

beforeEach(() => useToast.setState({ current: undefined }));
afterEach(() => vi.useRealTimers());

describe('the singleton toast lifecycle', () => {
  it('retires a delete Undo toast on its own even when no screen rerenders', () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    useToast.getState().showUndo({
      message: 'Chicken deleted',
      duration: 6000,
      onUndo: vi.fn(),
      onCommit,
    });

    vi.advanceTimersByTime(6000);

    expect(useToast.getState().current).toBeUndefined();
    expect(onCommit).toHaveBeenCalledOnce();
  });
  it.each(['ordinary', 'undo'] as const)(
    'commits an active Undo once before an %s replacement',
    (replacement) => {
      const onCommit = vi.fn();
      useToast.getState().showUndo({ message: 'Completed', onUndo: vi.fn(), onCommit });

      if (replacement === 'ordinary') {
        useToast.getState().show({ message: 'Saved' });
      } else {
        useToast
          .getState()
          .showUndo({ message: 'Skipped', onUndo: vi.fn(), onCommit: vi.fn() });
      }

      expect(onCommit).toHaveBeenCalledOnce();
      expect(useToast.getState().current?.message).toBe(
        replacement === 'ordinary' ? 'Saved' : 'Skipped',
      );
    },
  );

  it('commits exactly once across repeated timeout/dismiss signals', () => {
    const onCommit = vi.fn();
    const id = useToast
      .getState()
      .showUndo({ message: 'Completed', onUndo: vi.fn(), onCommit });

    useToast.getState().dismiss(id);
    useToast.getState().dismiss(id);

    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('undo compensates without committing', () => {
    const onUndo = vi.fn();
    const onCommit = vi.fn();
    const id = useToast.getState().showUndo({ message: 'Completed', onUndo, onCommit });

    useToast.getState().undo(id);

    expect(onUndo).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
    expect(useToast.getState().current).toBeUndefined();
  });

  it('keeps legacy confirmation and error messages in the same slot', () => {
    useToast.getState().show({ message: 'Saved' });
    useToast.getState().show({ message: 'Try again', tone: 'error' });

    expect(useToast.getState().current).toMatchObject({
      kind: 'message',
      message: 'Try again',
      tone: 'error',
    });
  });
});
