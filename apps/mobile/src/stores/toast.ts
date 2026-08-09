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
}

export interface ToastState {
  current: ToastMessage | undefined;
  show: (toast: ToastMessage) => void;
  dismiss: () => void;
}

export const useToast = create<ToastState>()((set) => ({
  current: undefined,
  show: (toast) => set({ current: toast }),
  dismiss: () => set({ current: undefined }),
}));
