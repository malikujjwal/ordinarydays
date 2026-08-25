import { BULK_UNDO_OFFER_SECONDS } from '@od/shared';
import type { UndoToastMessage } from '@/stores/toast';

/**
 * The toast a bulk list action offers, as a value (§P3-10, `interaction-contract.md` §4).
 *
 * ## Why this is a module and not part of the screen
 *
 * §P3-10 requires a test that "each bulk operation's toast appears with a **10-second**
 * window", and the shared toast defaults to six. A screen that assembled the descriptor
 * inline would put that number somewhere no test could reach until P3-27 ships the screen —
 * so the wrong window could be delivered for a whole task with everything green. This is the
 * smallest seam that holds the number and can be asserted now: pure, no hooks, no network.
 *
 * ## What the window is, and what it is not
 *
 * Ten seconds because "there is more to notice" — a toast saying `7 items cleared` asks the
 * user to check seven rows are gone, not one. It is a **presentation** deadline: the client
 * stops offering Undo at that instant, while an inverse the user already accepted stays valid
 * on the server for the whole replay retention. Nothing here decides whether an accepted
 * inverse may run.
 *
 * The network call fires immediately, not at the end of the window (the P2-24 rule): `onUndo`
 * is a **compensating** call, and closing the app without tapping it leaves the change
 * committed. That is why the caller passes both halves — what to do if the user takes it back,
 * and what to do when the window closes without them.
 */

/** The ten-second window every bulk reversible action gets, in the store's own units. */
export const BULK_UNDO_DURATION_MS = (BULK_UNDO_OFFER_SECONDS * 1000) as 10000;

export interface BulkUndoToastInput {
  /** What the server said it touched. The count the user is asked to notice. */
  readonly affectedCount: number;
  /** Fires the compensating call. Never a delayed commit. */
  readonly onUndo: () => void;
  /** Fires when the window closes, or when another toast replaces this one. */
  readonly onCommit: () => void;
}

/**
 * `7 items cleared` — the count, and what happened to them.
 *
 * Singular and plural both read as a sentence about rows, because the user is looking at rows.
 */
export function clearedItemsToast(input: BulkUndoToastInput): UndoToastMessage {
  return {
    message: `${String(input.affectedCount)} ${
      input.affectedCount === 1 ? 'item' : 'items'
    } cleared`,
    duration: BULK_UNDO_DURATION_MS,
    onUndo: input.onUndo,
    onCommit: input.onCommit,
  };
}

/** `7 items unchecked` — the same window, on a change that loses nothing. */
export function uncheckedItemsToast(input: BulkUndoToastInput): UndoToastMessage {
  return {
    message: `${String(input.affectedCount)} ${
      input.affectedCount === 1 ? 'item' : 'items'
    } unchecked`,
    duration: BULK_UNDO_DURATION_MS,
    onUndo: input.onUndo,
    onCommit: input.onCommit,
  };
}
