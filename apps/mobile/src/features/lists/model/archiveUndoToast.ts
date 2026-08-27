import { UNDO_OFFER_SECONDS } from '@od/shared';
import type { UndoToastMessage } from '@/stores/toast';

/**
 * The toast an archive offers (`plans-and-lists.md` §5.6, `interaction-contract.md` §4).
 *
 * ## Six seconds, not ten
 *
 * Archiving is a **settings** mutation on one list, so it gets the ordinary undo window.
 * `bulkUndoToast.ts` holds the ten-second one, and the difference is not arbitrary: ten seconds
 * is for "there is more to notice" — seven rows gone at once. One list leaving the index is one
 * thing to notice. Keeping the two windows in separate named modules is what stops a screen
 * assembling either inline and getting the number wrong where no test can reach it.
 *
 * ## The token is the server's, and the call is compensating
 *
 * `PATCH /v1/lists/:id { archived: true }` returns `{ list, undoToken, undoExpiresAt }` when it
 * recorded an inverse. `onUndo` fires `POST /v1/lists/:id/undo` with that token immediately —
 * it is a compensating call, not a delayed commit (the P2-24 rule), so closing the app without
 * tapping leaves the list archived. Nothing here reconstructs the prior state; the server owns
 * the inverse and the client never sends rows back as authority.
 *
 * `undoExpiresAt` is the **offer** deadline, which is what this duration presents. An inverse
 * the user already accepted stays valid on the server for the whole replay retention, so a tap
 * at 5.9 seconds on a slow connection is not a race the client has to win.
 */

/** The six-second window a settings mutation gets, in the toast store's own units. */
export const SETTINGS_UNDO_DURATION_MS = (UNDO_OFFER_SECONDS * 1000) as 6000;

export interface ArchiveUndoToastInput {
  /** Named so the toast says which list left, not merely that one did. */
  readonly title: string;
  /** Fires the compensating undo call. Never a delayed commit. */
  readonly onUndo: () => void;
  /** Fires when the window closes, or when another toast replaces this one. */
  readonly onCommit: () => void;
}

/**
 * `Groceries archived` — the list, and what happened to it.
 *
 * The title rather than a count, because one list is the unit here and a user who archived the
 * wrong one needs to see *which* one to know they did.
 */
export function archivedListToast(input: ArchiveUndoToastInput): UndoToastMessage {
  return {
    message: `${input.title} archived`,
    duration: SETTINGS_UNDO_DURATION_MS,
    onUndo: input.onUndo,
    onCommit: input.onCommit,
  };
}
