import type { Instant } from '@od/shared/time';
import type { UndoToastMessage } from '@/stores/toast';
import { UNDO_OFFER_DURATION_MS } from './undoOffer';

/**
 * The toast deleting one list item offers
 * ([`interaction-contract.md`](../../../../../docs/01-product/interaction-contract.md) §4.1
 * "Delete a list item", §P3-10, §P3-29).
 *
 * ## Six seconds, no dialog, and the delete already happened
 *
 * §4.1 gives a single-item delete no confirmation and a six-second Undo. So the request fires
 * on the tap and this toast carries the window in which it can be taken back — the P2-24 rule,
 * stated in §4.2 as "the network call fires immediately, not at the end of the window". Closing
 * the app without tapping leaves the item deleted, which is the correct outcome and the reason
 * a delayed commit would be wrong.
 *
 * On native, `onUndo` accepts a durable compensation and redraws the exact local snapshot while
 * the ordered sync lane waits for the delete's opaque token. That snapshot is presentation,
 * never server authority: §P3-10 restores the same id, rank, viewer links and provenance from
 * the server's own inverse. Web sends that opaque compensation directly.
 *
 * ## The title, not a count
 *
 * `Chicken deleted` — the same shape as `Groceries archived`, for the same reason: one thing
 * left the screen, and somebody who deleted the wrong one needs to see *which* one to know
 * they did. `bulkUndoToast.ts` names a count because seven rows have no single name. The copy
 * is not pinned by a product doc; it follows the archive line rather than inventing a third
 * idiom (decided in P3-29, raised in its PR).
 */

/** The six-second window, from the one module that holds it. */
export { UNDO_OFFER_DURATION_MS as ITEM_UNDO_DURATION_MS } from './undoOffer';

export interface ItemUndoToastInput {
  /** The item's own title, so the toast says which row left. */
  readonly title: string;
  /** Remaining server-authoritative offer window, from `undoExpiresAt`. */
  readonly duration?: number;
  /** The absolute server deadline the window was measured against. */
  readonly undoExpiresAt?: Instant;
  /** Accepts the compensating Undo. Never a delayed commit. */
  readonly onUndo: () => void;
  /** Fires when the window closes, or when another toast replaces this one. */
  readonly onCommit: () => void;
}

/** `Chicken deleted` — the item, and what happened to it. */
export function deletedItemToast(input: ItemUndoToastInput): UndoToastMessage {
  return {
    message: `${input.title} deleted`,
    duration: input.duration ?? UNDO_OFFER_DURATION_MS,
    ...(input.undoExpiresAt === undefined ? {} : { undoExpiresAt: input.undoExpiresAt }),
    onUndo: input.onUndo,
    onCommit: input.onCommit,
  };
}
