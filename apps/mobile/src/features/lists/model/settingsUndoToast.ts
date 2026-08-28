import type { Clock, Instant } from '@od/shared/time';
import type { DefaultSlot } from '@od/shared/types';
import type { UndoToastMessage } from '@/stores/toast';
import { SLOT_LABELS } from './listSettings';
import { remainingUndoOfferMs, UNDO_OFFER_DURATION_MS } from './undoOffer';

/**
 * The six-second toast every **additive** List settings change offers
 * ([`interaction-contract.md`](../../../../../docs/01-product/interaction-contract.md) §4.1's
 * three list-settings rows, [`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md)
 * §5.5, §P3-32).
 *
 * `archiveUndoToast.ts` is the pattern and the window is literally its constant: archiving,
 * toggling a capability, choosing a slot and upgrading a behaviour are four instances of the
 * same §4.1 row — one settings mutation, six seconds, `POST /v1/lists/:id/undo` with the
 * server's opaque token. This module exists rather than a fifth caller of
 * `archivedListToast` because the *message* differs per change and the archive one names a list
 * leaving the index, which none of these do.
 *
 * ## A toast is for undo, not for applause (§4.2)
 *
 * Every message here names the change so the six seconds mean something. None of them is shown
 * when the change recorded no inverse — a rename returns no token (`listSettingsMutation`'s
 * union), so a rename gets no toast, which is exactly §4.1 having no undo row for it.
 *
 * ## The window is the server's, clamped
 *
 * `undoExpiresAt` is the **offer** deadline. An inverse the user has already accepted stays
 * valid for the whole replay retention, so a tap at 5.9 seconds on a slow connection is not a
 * race the client has to win; and a response that arrives already past its deadline offers
 * nothing rather than offering a window that has closed.
 */

/** The same six seconds every single reversible action gets. Re-exported for the call sites. */
export const SETTINGS_UNDO_DURATION_MS = UNDO_OFFER_DURATION_MS;

/** {@link remainingUndoOfferMs}, under the name the settings call sites read best with. */
export function remainingSettingsUndoMs(
  undoExpiresAt: Instant,
  clock: Clock,
): number | undefined {
  return remainingUndoOfferMs(undoExpiresAt, clock);
}

/** Which additive settings change happened, in the words its toast reports it with. */
export type SettingsChange =
  | { readonly kind: 'setting'; readonly label: string; readonly next: boolean }
  | { readonly kind: 'slot'; readonly slot: DefaultSlot | null }
  | { readonly kind: 'state-mode'; readonly label: string };

/**
 * What happened, in the past tense and in the words of the control that did it.
 *
 * Deliberately not "Saved" or "Updated": §4.2's rule is that a routine mutation gets no toast at
 * all, so a toast that appears anyway has to earn it by saying what it will take back.
 */
export function settingsChangeMessage(change: SettingsChange): string {
  if (change.kind === 'setting') {
    return `${change.label} ${change.next ? 'on' : 'off'}`;
  }
  if (change.kind === 'slot') {
    return change.slot === null
      ? 'No longer a default destination'
      : `Default for ${SLOT_LABELS[change.slot]}`;
  }
  return `Item state set to ${change.label}`;
}

export interface SettingsUndoToastInput {
  readonly change: SettingsChange;
  /** Remaining server-authoritative offer window; local/offline callers use six seconds. */
  readonly duration?: number;
  /** Absolute server deadline; omitted for a local/offline offer that starts now. */
  readonly undoExpiresAt?: Instant;
  /** Fires the compensating `POST /v1/lists/:id/undo`. Never a second PATCH, never a delay. */
  readonly onUndo: () => void;
  /** Fires when the window closes, or when another toast replaces this one. */
  readonly onCommit: () => void;
}

export function settingsChangedToast(input: SettingsUndoToastInput): UndoToastMessage {
  return {
    message: settingsChangeMessage(input.change),
    duration: input.duration ?? SETTINGS_UNDO_DURATION_MS,
    ...(input.undoExpiresAt === undefined ? {} : { undoExpiresAt: input.undoExpiresAt }),
    onUndo: input.onUndo,
    onCommit: input.onCommit,
  };
}
