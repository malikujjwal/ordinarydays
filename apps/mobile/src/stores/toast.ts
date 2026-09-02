import type { Instant } from '@od/shared/time';
import type { ToastAction } from '@od/ui';
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
/** The same shape the `Toast` primitive renders; one definition, not a lookalike. */
export type FollowUpAction = ToastAction;

/**
 * One contextual follow-up (`interaction-contract.md` §1a.2, `activities.md` §5.3) shown in
 * the confirmation slot: a question, its explicit choices, and the `✕` the host adds. It is
 * presentation only — every write happens behind one of the `actions`' own taps.
 */
export interface FollowUpPresentation {
  message: string;
  actions: readonly FollowUpAction[];
}

export interface ToastMessage {
  message: string;
  requestId?: string;
  tone?: 'neutral' | 'error';
  action?: { label: string; onPress: () => void };
  /** Renders the `✕`: the message is a question the reader may simply close. */
  dismissible?: boolean;
  duration?: number;
}

export interface UndoToastMessage {
  message: string;
  duration?: number;
  undoExpiresAt?: Instant;
  /** A follow-up offered alongside this confirmation's Undo (§1a.2). */
  followUp?: FollowUpPresentation;
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
  /**
   * Attaches a follow-up to the Undo toast it belongs to, once the server has described one.
   * Returns `false` — and shows nothing — when that toast is no longer current: a follow-up
   * never outlives, replaces, or extends the confirmation window it rides on (§4.2).
   */
  attachFollowUp: (id: number, followUp: FollowUpPresentation) => boolean;
}

let nextToastId = 1;
const DEFAULT_TOAST_DURATION_MS = 6000;

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
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const clearExpiry = () => {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = undefined;
  };

  const commitCurrent = (id?: number) => {
    const current = get().current;
    if (current === undefined || (id !== undefined && current.id !== id)) return;
    clearExpiry();
    set({ current: undefined });
    if (current.kind === 'undo') current.onCommit();
  };

  const scheduleExpiry = (toast: ActiveToast) => {
    clearExpiry();
    expiryTimer = setTimeout(
      () => commitCurrent(toast.id),
      Math.max(0, toast.duration ?? DEFAULT_TOAST_DURATION_MS),
    );
  };

  const replace = (next: ActiveToast) => {
    commitCurrent();
    set({ current: next });
    scheduleExpiry(next);
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
      clearExpiry();
      set({ current: undefined });
      current.onUndo();
    },
    attachFollowUp: (id, followUp) => {
      const current = get().current;
      if (current === undefined || current.id !== id || current.kind !== 'undo')
        return false;
      set({ current: { ...current, followUp } });
      return true;
    },
    failUndo: (id, toast) => {
      const current = get().current;
      const next = activeMessage(toast);
      if (current?.id === id && current.kind === 'undo') {
        // The original write did not happen, so ending its window is not a commit.
        clearExpiry();
        set({ current: next });
        scheduleExpiry(next);
        return next.id;
      }
      return replace(next);
    },
  };
});
