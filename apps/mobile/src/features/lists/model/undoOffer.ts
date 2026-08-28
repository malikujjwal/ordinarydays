import { UNDO_OFFER_SECONDS } from '@od/shared';
import type { Clock, Instant } from '@od/shared/time';

/**
 * The single-action Undo window, and the one conversion from the server's deadline
 * ([`interaction-contract.md`](../../../../../docs/01-product/interaction-contract.md) §4).
 *
 * Extracted in P3-29 from `archiveUndoToast.ts`, which had held it since P3-25. A second
 * six-second offer — deleting one list item — needed the same clamp, and the alternative was
 * either a screen re-deriving the number inline or a module named for archiving being imported
 * by a delete. Both are how two windows for one contract start to differ.
 *
 * `bulkUndoToast.ts` keeps the **ten**-second one deliberately. Ten seconds is for "there is
 * more to notice" — seven rows gone at once; six is for one thing. Keeping the two in separate
 * named modules is what stops either being assembled inline where no test can reach it.
 */

/** The six seconds every single reversible action gets, in the toast store's own units. */
export const UNDO_OFFER_DURATION_MS = (UNDO_OFFER_SECONDS * 1000) as 6000;

/**
 * Converts the server's absolute offer deadline into the time the client may still display.
 *
 * `undefined` means **do not offer** — the deadline has passed, or the value is unparseable.
 * That is the only thing this decides: `undoExpiresAt` is the deadline for *offering* a new
 * Undo, never a replay deadline, so an inverse the user already accepted stays valid on the
 * server for the whole retention window and a tap at 5.9 seconds is not a race the client has
 * to win.
 *
 * The cap protects the six-second contract when the device clock trails the server's.
 */
export function remainingUndoOfferMs(
  undoExpiresAt: Instant,
  clock: Clock,
): number | undefined {
  const remaining = Math.min(
    UNDO_OFFER_DURATION_MS,
    Date.parse(undoExpiresAt) - Date.parse(clock.now()),
  );
  return Number.isFinite(remaining) && remaining > 0 ? remaining : undefined;
}
