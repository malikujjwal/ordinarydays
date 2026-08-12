import { describe, expect, it, vi } from 'vitest';
import type { ToastMessage, UndoToastMessage } from '@/stores/toast';
import { startUndoable } from './startUndoable';

function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function port() {
  let undo: UndoToastMessage | undefined;
  let failure: ToastMessage | undefined;
  return {
    toast: {
      showUndo: vi.fn((message: UndoToastMessage) => {
        undo = message;
        return 7;
      }),
      failUndo: vi.fn((_id: number, message: ToastMessage) => {
        failure = message;
        return 8;
      }),
    },
    get undo() {
      return undo;
    },
    get failure() {
      return failure;
    },
  };
}

describe('startUndoable helper', () => {
  it('starts the network immediately and compensates only after Undo', async () => {
    const pending = deferred();
    const apply = vi.fn();
    const revert = vi.fn();
    const compensate = vi.fn(() => Promise.resolve());
    const messages = port();

    startUndoable({
      apply,
      revert,
      restorePosition: vi.fn(),
      request: vi.fn(() => pending.promise),
      compensate,
      toast: messages.toast,
      message: 'Completed',
      failureMessage: 'Failed',
    });

    expect(apply).toHaveBeenCalledOnce();
    expect(messages.toast.showUndo).toHaveBeenCalledOnce();
    messages.undo?.onUndo();
    expect(revert).toHaveBeenCalledOnce();
    expect(compensate).not.toHaveBeenCalled();

    pending.resolve();
    await pending.promise;
    await vi.waitFor(() => expect(compensate).toHaveBeenCalledOnce());
  });

  it('rolls back a failed original and exposes Retry', async () => {
    const pending = deferred();
    const apply = vi.fn();
    const revert = vi.fn();
    const restorePosition = vi.fn();
    const request = vi.fn(() => pending.promise);
    const messages = port();

    startUndoable({
      apply,
      revert,
      restorePosition,
      request,
      compensate: vi.fn(() => Promise.resolve()),
      toast: messages.toast,
      message: 'Completed',
      failureMessage: "Couldn't complete this task.",
    });
    pending.reject(new Error('offline'));
    await pending.promise.catch(() => {});
    await vi.waitFor(() => expect(messages.toast.failUndo).toHaveBeenCalledOnce());

    expect(revert).toHaveBeenCalledOnce();
    expect(restorePosition).toHaveBeenCalledOnce();
    expect(messages.failure).toMatchObject({
      message: "Couldn't complete this task.",
      tone: 'error',
      action: { label: 'Retry' },
    });
  });
});
