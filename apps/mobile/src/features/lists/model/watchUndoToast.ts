import { UNDO_OFFER_SECONDS } from '@od/shared';
import type { UndoToastMessage } from '@/stores/toast';

/**
 * The toast a watch status or progress write offers
 * ([`interaction-contract.md`](../../../../../docs/01-product/interaction-contract.md) §4.1,
 * §4.2; `plans-and-lists.md` §8.4; §P3-31).
 *
 * ## Six seconds, and why the number is not written here
 *
 * `UNDO_OFFER_SECONDS` is the shared constant `archiveUndoToast.ts` derives its window from
 * too, so the two agree at the source rather than by coincidence. `bulkUndoToast.ts` keeps the
 * **ten**-second one deliberately: ten is for "there is more to notice" — seven rows gone at
 * once — and one item changing status is one thing to notice.
 *
 * ## The undo is a compensating `PATCH`, not a delayed commit
 *
 * There is no server undo token on an item field write and there does not need to be: the
 * inverse of setting a status is setting the previous one, and the client knows what that was.
 * So the forward write goes on the tap (the P2-24 rule, §4.2), and `onUndo` sends the row's
 * prior `details` back. Closing the app mid-window leaves the change committed, which is the
 * right outcome for a window nobody acted in.
 *
 * ## What the toast says
 *
 * The item's title, and what happened to it — the shape `Groceries archived` set for a single
 * object, rather than `bulkUndoToast`'s count, which exists because seven rows have no one
 * name. Neither line is pinned by a product doc; both follow the archive line rather than
 * inventing a third idiom (decided in P3-31, raised in its PR).
 */

/** The six seconds a single reversible action gets, in the toast store's own units. */
export const WATCH_UNDO_DURATION_MS = (UNDO_OFFER_SECONDS * 1000) as 6000;

export interface WatchUndoToastInput {
  /** The item's own title, so the toast says which row changed. */
  readonly title: string;
  /** Fires the compensating `PATCH`. Never a delayed commit. */
  readonly onUndo: () => void;
  /** Fires when the window closes, or when another toast replaces this one. */
  readonly onCommit: () => void;
}

/** `Severance marked watched` — §3.2's swipe action, reported in its own words. */
export function markedWatchedToast(input: WatchUndoToastInput): UndoToastMessage {
  return {
    message: `${input.title} marked watched`,
    duration: WATCH_UNDO_DURATION_MS,
    onUndo: input.onUndo,
    onCommit: input.onCommit,
  };
}

/** `Severance updated` — §8.4's confirmed follow-up, which may move status and progress. */
export function watchProgressToast(input: WatchUndoToastInput): UndoToastMessage {
  return {
    message: `${input.title} updated`,
    duration: WATCH_UNDO_DURATION_MS,
    onUndo: input.onUndo,
    onCommit: input.onCommit,
  };
}
