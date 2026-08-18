import {
  coordinateDurableAction,
  type DurableIntentDescriptor,
} from '@/lib/durableAction';
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
  originalIntent: DurableIntentDescriptor;
  inverseIntent: DurableIntentDescriptor;
  toast: UndoToastPort;
  message: string;
  failureMessage: string;
  compensationFailureMessage?: string;
}

/** Presentation-only binding from one observable durable action to the standard Undo toast. */
export function startUndoable(action: UndoableAction): void {
  void coordinateDurableAction({
    intent: action.originalIntent,
    apply: action.apply,
    revert: action.revert,
    rollback: action.rollbackFailure ?? action.revert,
    restorePosition: action.restorePosition,
    dispatch: action.request,
    inverse: { intent: action.inverseIntent, dispatch: action.compensate },
  }).then((durable) => {
    const fail = (message: string, retry: () => void) => {
      action.toast.failUndo(toastId, {
        message,
        tone: 'error',
        action: { label: 'Retry', onPress: retry },
      });
    };
    const toastId = action.toast.showUndo({
      message: action.message,
      onCommit: () => {},
      onUndo: () => {
        void durable.undo().then((inverse) =>
          inverse.attempt.then((outcome) => {
            if (outcome.status === 'refused' || outcome.status === 'needs_attention') {
              fail(action.compensationFailureMessage ?? "Couldn't undo this.", () => {
                void durable.undo();
              });
            }
          }),
        );
      },
    });
    void durable.attempt.then((outcome) => {
      if (outcome.status !== 'refused' && outcome.status !== 'needs_attention') return;
      fail(action.failureMessage, () => startUndoable(action));
    });
  });
}
