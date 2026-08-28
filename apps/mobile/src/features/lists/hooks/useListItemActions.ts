import {
  ApiError,
  deleteListItem,
  getActivity,
  isRetryable,
  type PatchListItemInput,
  undoListOperation,
} from '@od/shared/client';
import { randomUUID } from 'expo-crypto';
import { useCallback } from 'react';
import { useClock } from '@/hooks/useClock';
import { apiClient } from '@/lib/apiClient';
import type { ListItemRow } from '@/lib/sqlite/listItemsRepository';
import { type ToastMessage, useToast } from '@/stores/toast';
import { deletedItemToast } from '../model/itemUndoToast';
import { remainingUndoOfferMs } from '../model/undoOffer';
import { usePatchListItem } from './usePatchListItem';

/**
 * Everything the item sheet writes, and the one read it makes (§P3-29).
 *
 * Shared by both platforms. Only the field PATCH differs — `usePatchListItem` resolves to the
 * durable native adapter or the online web one — so composing it here keeps the delete, its
 * Undo and the provenance probe in one file instead of two that would drift.
 *
 * ## Delete is online-first, on both platforms
 *
 * Deliberate, and the same shape as `useListBulkActions`, which is §P3-10's other half: `Clear
 * checked` and `Uncheck all` already delete items through one online call with the server's
 * opaque token. Undo **is** that token — §P3-10 restores the item id, its previous rank, its
 * live viewer links and its Activity provenance server-side, and the client is forbidden from
 * reconstructing any of it — so an offline delete would have nothing to offer Undo with until
 * its acknowledgement arrived.
 *
 * The consequence is stated rather than hidden: deleting an item needs a connection, and
 * `interaction-contract.md` §5.4's "Undo while offline: works" is not yet true for this action
 * on native. Closing that needs the item-scoped equivalent of the archive Undo offer the outbox
 * already keeps for lists, which is its own task — raised in this PR.
 *
 * The split is why the two callbacks are separate. A field edit is committed **locally** on
 * native, so its refresh is a re-read; a delete is committed on the **server**, so its refresh
 * has to be a pull. One callback for both would make an accepted offline edit ask the network
 * for permission to be displayed, which is the mistake `useListDetail`'s two methods exist to
 * prevent.
 *
 * ## The request fires on the tap, never at the end of the window
 *
 * The P2-24 rule (§4.2). `deleteListItem` goes immediately, the toast carries the six seconds
 * from the server's `undoExpiresAt`, and `onUndo` is a **compensating** call. Closing the app
 * mid-window leaves the item deleted, which is the correct outcome for a window nobody acted
 * in.
 */
export interface ListItemActions {
  /**
   * Sends one field and reports whether it was accepted.
   *
   * `false` means the caller reverts that field to its committed value — the toast naming the
   * failure and offering `Retry` has already been shown (`interaction-contract.md` §5.3).
   */
  readonly save: (item: ListItemRow, changes: PatchListItemInput) => Promise<boolean>;
  /** Deletes with no confirmation and offers the six-second Undo (§4.1). */
  readonly remove: (item: ListItemRow) => void;
  /**
   * Whether the provenance row's Activity still resolves (§7.5).
   *
   * There is no resolvability field on the wire, so this is the navigation attempt itself: a
   * `404` answers `false` and the row degrades to plain text for the rest of the sheet's life.
   * **Only** a `404`. Offline, or on a `500`, the answer is `true` and the caller navigates —
   * the Activity screen owns its own error and offline states, and a row that went dead because
   * the train entered a tunnel would be lying about the data.
   */
  readonly sourceResolves: (activityId: string) => Promise<boolean>;
  readonly isSaving: boolean;
}

function failureToast(error: unknown, message: string, retry: () => void): ToastMessage {
  let displayed = message;
  if (error instanceof ApiError) {
    if (error.status === 403) {
      displayed = 'Only the person who made this plan can change that.';
    } else if (error.status === 404) {
      displayed = "This isn't here any more.";
    } else if (error.status === 429 && error.retryAfterSeconds !== undefined) {
      displayed = `Too many requests. Try again in ${error.retryAfterSeconds} seconds.`;
    } else if (error.status >= 500) {
      displayed = 'Something went wrong.';
    }
  }
  return {
    message: displayed,
    tone: 'error',
    ...(error instanceof ApiError && error.requestId !== undefined
      ? { requestId: error.requestId }
      : {}),
    ...(isRetryable(error) ? { action: { label: 'Retry', onPress: retry } } : {}),
  };
}

export interface ListItemRefresh {
  /** After an accepted field edit. Native re-reads SQLite; web asks the server. */
  readonly onSaved: () => void;
  /** After the online delete or its Undo. Both platforms ask the server. */
  readonly onRemoved: () => void;
}

export function useListItemActions({
  onSaved,
  onRemoved,
}: ListItemRefresh): ListItemActions {
  const clock = useClock();
  const patch = usePatchListItem();
  const show = useToast((state) => state.show);
  const showUndo = useToast((state) => state.showUndo);
  const dismiss = useToast((state) => state.dismiss);

  const save = useCallback(
    async (item: ListItemRow, changes: PatchListItemInput): Promise<boolean> => {
      const outcome = await patch.patch(item, changes);
      if (outcome.ok) {
        onSaved();
        return true;
      }
      show(
        failureToast(outcome.error, `Couldn't save "${item.title}."`, () => {
          void save(item, changes);
        }),
      );
      return false;
    },
    [onSaved, patch.patch, show],
  );

  const undo = useCallback(
    (item: ListItemRow, undoToken: string) => {
      // Acceptance owns the singleton toast slot before this request can settle.
      dismiss();
      const idempotencyKey = randomUUID();
      const run = () => {
        void undoListOperation(apiClient, item.listId, undoToken, idempotencyKey)
          .then((response) => {
            onRemoved();
            if (response.data.outcome === 'applied') return;
            /*
             * `expired` and `no_longer_applicable` are `200`s: the server was asked to apply a
             * compensation and answered with what happened to it. Saying so is honest; a
             * silent no-op would leave the user believing the row came back.
             */
            show({
              message: `Couldn't undo deleting "${item.title}."`,
              tone: 'error',
              requestId: response.meta.requestId,
            });
          })
          .catch((error: unknown) => {
            show(failureToast(error, `Couldn't undo deleting "${item.title}."`, run));
          });
      };
      run();
    },
    [dismiss, onRemoved, show],
  );

  const remove = useCallback(
    (item: ListItemRow) => {
      dismiss();
      const run = () => {
        void deleteListItem(apiClient, item.listId, item.itemId)
          .then((result) => {
            onRemoved();
            const duration = remainingUndoOfferMs(result.undoExpiresAt, clock);
            // Past its own offer deadline on arrival: the delete stands, unoffered (§4.2).
            if (duration === undefined) return;
            showUndo(
              deletedItemToast({
                title: item.title,
                duration,
                undoExpiresAt: result.undoExpiresAt,
                onUndo: () => undo(item, result.undoToken),
                onCommit: () => undefined,
              }),
            );
          })
          .catch((error: unknown) => {
            show(failureToast(error, `Couldn't delete "${item.title}."`, run));
          });
      };
      run();
    },
    [clock, dismiss, onRemoved, show, showUndo, undo],
  );

  const sourceResolves = useCallback(async (activityId: string): Promise<boolean> => {
    try {
      await getActivity(apiClient, { kind: 'activity', activityId });
      return true;
    } catch (error) {
      return !(error instanceof ApiError && error.status === 404);
    }
  }, []);

  return { save, remove, sourceResolves, isSaving: patch.isSaving };
}
