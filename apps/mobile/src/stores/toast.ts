import type { Instant } from '@od/shared/time';
import { create } from 'zustand';

/**
 * The confirmation slot (`interaction-contract.md` §4.2, `activities.md` §2.5).
 *
 * A store rather than local state because the toast must outlive the screen that caused it:
 * a save dismisses the compose modal and *then* the toast names where the item landed. A
 * toast owned by the modal would unmount with it.
 *
 * **One at a time, and a new one commits the previous** (§4.2). That is why this holds a
 * single value rather than a queue — a queue would let two undo windows overlap, and the
 * second toast would be describing an action the user can no longer see.
 */
export interface ToastMessage {
  message: string;
  tone?: 'neutral' | 'error';
  action?: { label: string; onPress: () => void };
  duration?: number;
}

export interface UndoToastMessage {
  message: string;
  duration?: number;
  undoExpiresAt?: Instant;
  onUndo: () => void;
  onCommit: () => void;
}

export type ActiveToast =
  | (ToastMessage & { id: number; kind: 'message' })
  | (Omit<UndoToastMessage, 'onUndo' | 'onCommit'> & {
      id: number;
      kind: 'undo';
      onUndo: () => void;
      onCommit: () => void;
    });

export interface ToastState {
  current: ActiveToast | undefined;
  show: (toast: ToastMessage) => number;
  showUndo: (toast: UndoToastMessage) => number;
  dismiss: (id?: number) => void;
  undo: (id?: number) => void;
  failUndo: (id: number, toast: ToastMessage) => number;
}

let nextToastId = 1;

const activeMessage = (toast: ToastMessage): ActiveToast => ({
  ...toast,
  id: nextToastId++,
  kind: 'message',
});

const activeUndo = (toast: UndoToastMessage): ActiveToast => ({
  ...toast,
  id: nextToastId++,
  kind: 'undo',
});

export const useToast = create<ToastState>()((set, get) => {
  const commitCurrent = (id?: number) => {
    const current = get().current;
    if (current === undefined || (id !== undefined && current.id !== id)) return;
    set({ current: undefined });
    if (current.kind === 'undo') current.onCommit();
  };

  const replace = (next: ActiveToast) => {
    commitCurrent();
    set({ current: next });
    return next.id;
  };

  return {
    current: undefined,
    show: (toast) => replace(activeMessage(toast)),
    showUndo: (toast) => replace(activeUndo(toast)),
    dismiss: commitCurrent,
    undo: (id) => {
      const current = get().current;
      if (
        current === undefined ||
        current.kind !== 'undo' ||
        (id !== undefined && current.id !== id)
      ) {
        return;
      }
      set({ current: undefined });
      current.onUndo();
    },
    failUndo: (id, toast) => {
      const current = get().current;
      const next = activeMessage(toast);
      if (current?.id === id && current.kind === 'undo') {
        // The original write did not happen, so ending its window is not a commit.
        set({ current: next });
        return next.id;
      }
      return replace(next);
    },
  };
});
