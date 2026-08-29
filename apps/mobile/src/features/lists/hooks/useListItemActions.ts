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
import { useDeleteListItem } from './useDeleteListItem';
import { usePatchListItem } from './usePatchListItem';

/**
 * Everything the item sheet writes, and the one read it makes (§P3-29).
 *
 * Shared by both platforms. The field PATCH and delete projection resolve to durable native
 * adapters or online web branches, so native network writes have one owner: the sync adapter.
 *
 * ## Delete is local-first on native
 *
 * Native commits the absent row and an ordered `item-delete` intent together before sending
 * the replay-protected request. Earlier checkbox writes therefore cannot reinstall the row,
 * navigation cannot resurrect it, and a lost response reuses the same key to recover the
 * server's opaque Undo receipt. Undo is another durable intent: it can be accepted while the
 * delete is offline or still in flight, then receives the opaque token at settlement. Web has
 * no SQLite projection and keeps the online path.
 *
 * ## The request fires on the tap, never at the end of the window
 *
 * The P2-24 rule (§4.2). Web calls `deleteListItem` immediately; native commits the intent and
 * requests its drain immediately. `onUndo` is always a compensation, never a delayed delete.
 * Closing the app mid-window leaves the item deleted when nobody accepted Undo.
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
  /** Re-reads the local projection after the tap has committed to SQLite. */
  readonly onRemoving?: () => void;
  /** After the web-only online delete or its Undo. */
  readonly onRemoved: () => void;
}

export function useListItemActions({
  onSaved,
  onRemoving,
  onRemoved,
}: ListItemRefresh): ListItemActions {
  const clock = useClock();
  const patch = usePatchListItem();
  const deletion = useDeleteListItem();
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

  const undoOnline = useCallback(
    (item: ListItemRow, undoToken: string) => {
      // Acceptance owns the singleton toast slot before this request can settle.
      dismiss();
      const idempotencyKey = randomUUID();
      const run = () => {
        void undoListOperation(apiClient, item.listId, undoToken, idempotencyKey)
          .then((response) => {
            if (response.data.outcome === 'applied') {
              onRemoved();
              return;
            }
            onRemoved();
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
      const intentId = randomUUID();
      if (deletion.kind === 'durable') {
        const run = () => {
          void deletion
            .prepare(item, intentId)
            .then(() => {
              onRemoving?.();
              deletion.requestSync();
              showUndo(
                deletedItemToast({
                  title: item.title,
                  onUndo: () => {
                    const inverseIntentId = randomUUID();
                    const acceptUndo = () => {
                      void deletion
                        .undo(intentId, inverseIntentId)
                        .then(() => {
                          onRemoving?.();
                          deletion.requestSync();
                        })
                        .catch((error: unknown) => {
                          show(
                            failureToast(
                              error,
                              `Couldn't undo deleting "${item.title}."`,
                              acceptUndo,
                            ),
                          );
                        });
                    };
                    acceptUndo();
                  },
                  onCommit: () => {
                    void deletion.commit(intentId).catch((error: unknown) => {
                      if (__DEV__) {
                        console.debug('native_item_delete_offer_commit_failed', {
                          intentId,
                          message: error instanceof Error ? error.message : String(error),
                        });
                      }
                    });
                  },
                }),
              );
            })
            .catch((error: unknown) => {
              show(failureToast(error, `Couldn't delete "${item.title}."`, run));
            });
        };
        run();
        return;
      }
      const run = () => {
        void deleteListItem(apiClient, item.listId, item.itemId, intentId)
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
                onUndo: () => undoOnline(item, result.undoToken),
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
    [clock, deletion, dismiss, onRemoved, onRemoving, show, showUndo, undoOnline],
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
