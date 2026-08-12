import type { ToastMessage, UndoToastMessage } from '@/stores/toast';

export interface UndoToastPort {
  showUndo: (toast: UndoToastMessage) => number;
  failUndo: (id: number, toast: ToastMessage) => number;
}

export interface UndoableAction {
  apply: () => void;
  revert: () => void;
  /** Optional server-failure rollback when it differs from a user-requested Undo. */
  rollbackFailure?: () => void;
  restorePosition: () => void;
  request: () => Promise<unknown>;
  compensate: () => Promise<unknown>;
  toast: UndoToastPort;
  message: string;
  failureMessage: string;
  compensationFailureMessage?: string;
}

/**
 * Starts a write immediately and makes Undo a local rollback plus compensating write.
 * The toast timer only releases its callbacks; it never controls when the network runs.
 */
export function startUndoable(action: UndoableAction): void {
  let undone = false;
  let requestSucceeded = false;
  let compensationStarted = false;
  action.apply();
  const request = action.request();

  const retryCompensation = () => {
    action.revert();
    action.restorePosition();
    void action.compensate().catch(() => {
      action.apply();
      action.toast.failUndo(toastId, {
        message: action.compensationFailureMessage ?? "Couldn't undo this.",
        tone: 'error',
        action: { label: 'Retry', onPress: retryCompensation },
      });
    });
  };

  const compensateAfterUndo = () => {
    if (compensationStarted) return;
    compensationStarted = true;
    void action.compensate().catch(() => {
      action.apply();
      action.toast.failUndo(toastId, {
        message: action.compensationFailureMessage ?? "Couldn't undo this.",
        tone: 'error',
        action: { label: 'Retry', onPress: retryCompensation },
      });
    });
  };

  const toastId = action.toast.showUndo({
    message: action.message,
    onCommit: () => {},
    onUndo: () => {
      undone = true;
      action.revert();
      action.restorePosition();
      if (requestSucceeded) compensateAfterUndo();
    },
  });

  void request
    .then(() => {
      requestSucceeded = true;
      if (undone) compensateAfterUndo();
    })
    .catch(() => {
      if (undone) return;
      (action.rollbackFailure ?? action.revert)();
      action.restorePosition();
      action.toast.failUndo(toastId, {
        message: action.failureMessage,
        tone: 'error',
        action: { label: 'Retry', onPress: () => startUndoable(action) },
      });
    });
}
