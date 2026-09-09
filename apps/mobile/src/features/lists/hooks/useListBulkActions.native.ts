import { randomUUID } from 'expo-crypto';
import { useCallback } from 'react';
import { useListIndexMutations } from '@/features/lists/hooks/useListIndexMutations';
import { ListTransactionService } from '@/lib/sqlite/listTransactions';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import { useToast } from '@/stores/toast';
import { clearedItemsToast, uncheckedItemsToast } from '../model/bulkUndoToast';
import type { BulkActionLifecycle, ListBulkActions } from './useListBulkActions';

/**
 * The two bulk actions as **durable local writes** (§P3-10, ADR-057).
 *
 * ## Instant, offline, and made of parts that already exist
 *
 * `Clear checked` enqueues one durable `item-delete` per checked row and `Uncheck all` one
 * durable `item-patch` per checked row, all in **one** SQLite transaction — the projection
 * changes the moment the tap lands, on a train exactly as on WiFi, and the intents replay
 * through the same ordered lane every other item write uses. Undo composes the same way:
 * each delete's own offer machinery for `Clear checked`, and a compensating `state: 'done'`
 * patch for `Uncheck all`. Closing the app mid-window leaves the change committed (§4.2).
 *
 * > **Raised in this PR.** §P3-10 describes the bulk endpoint's single Undo token, and web
 * > keeps that path. Native deliberately composes per-item durable intents instead: the
 * > bulk endpoint cannot be enqueued offline without a new durable intent kind, its own
 * > offer table and its own settlement, while the per-item primitives are already durable,
 * > ordered and recoverable. The cost is N requests where web sends one. If the single
 * > bulk request must also become the native transport, that is a follow-up with a schema
 * > migration attached, not a bug fix.
 */
export function useListBulkActions(onChanged: () => void): ListBulkActions {
  const state = requireActiveNativeState();
  const show = useToast((store) => store.show);
  const showUndo = useToast((store) => store.showUndo);
  const dismiss = useToast((store) => store.dismiss);
  const { onArchive, onDelete } = useListIndexMutations();

  const run = useCallback(
    async (
      listId: string,
      action: 'clear-done' | 'uncheck-all',
      lifecycle?: BulkActionLifecycle,
    ): Promise<boolean> => {
      lifecycle?.onStarted();
      // The accepted action owns the singleton toast slot before its window opens.
      dismiss();
      try {
        const lists = state.lists;
        const items = state.listItems;
        if (lists === undefined || items === undefined) {
          throw new Error('Native list item state is not ready.');
        }
        const service = new ListTransactionService(state.outbox, lists, items);
        const snapshot = await items.readSnapshot(listId);
        const moves = snapshot.items
          .filter((item) => item.state === 'done')
          .map((item) => ({ itemId: item.itemId, intentId: randomUUID() }));
        if (moves.length === 0) return true;

        await state.account.transactions.run(async (transaction) => {
          for (const move of moves) {
            if (action === 'clear-done') {
              await service.deleteItem(transaction, {
                listId,
                itemId: move.itemId,
                intentId: move.intentId,
                idempotencyKey: move.intentId,
              });
            } else {
              await service.patchItem(transaction, {
                listId,
                itemId: move.itemId,
                intentId: move.intentId,
                idempotencyKey: move.intentId,
                input: { state: 'open' },
              });
            }
          }
        }, 'interactive');
        state.sync.request('accepted-action');
        onChanged();

        showUndo(
          (action === 'clear-done' ? clearedItemsToast : uncheckedItemsToast)({
            affectedCount: moves.length,
            onUndo: () => {
              dismiss();
              // One inverse identity per row, minted before the writer so a transaction
              // retry cannot mint twice.
              const inverses = moves.map((move) => ({ ...move, undoId: randomUUID() }));
              void state.account.transactions
                .run(async (transaction) => {
                  for (const inverse of inverses) {
                    if (action === 'clear-done') {
                      await service.undoDeletedItem(
                        transaction,
                        inverse.intentId,
                        inverse.undoId,
                      );
                    } else {
                      try {
                        await service.patchItem(transaction, {
                          listId,
                          itemId: inverse.itemId,
                          intentId: inverse.undoId,
                          idempotencyKey: inverse.undoId,
                          input: { state: 'done' },
                        });
                      } catch (error) {
                        if (
                          !(error instanceof Error) ||
                          error.message !== 'The item is no longer available locally.'
                        ) {
                          throw error;
                        }
                      }
                    }
                  }
                }, 'interactive')
                .then(() => {
                  state.sync.request('accepted-action');
                  onChanged();
                })
                .catch(() => {
                  show({
                    message:
                      action === 'clear-done'
                        ? "Couldn't undo clearing checked items."
                        : "Couldn't undo unchecking items.",
                    tone: 'error',
                  });
                });
            },
            onCommit: () => {
              if (action !== 'clear-done') return;
              void state.account.transactions
                .run(async (transaction) => {
                  for (const move of moves) {
                    await service.commitItemDeleteUndoOffer(transaction, move.intentId);
                  }
                }, 'interactive')
                .catch((error: unknown) => {
                  if (__DEV__) {
                    console.debug('native_bulk_offer_commit_failed', {
                      listId,
                      message: error instanceof Error ? error.message : String(error),
                    });
                  }
                });
            },
          }),
        );
        return true;
      } catch (error) {
        lifecycle?.onRejected();
        if (__DEV__) {
          console.warn('native_bulk_action_failed', {
            listId,
            action,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        show({
          message:
            action === 'clear-done'
              ? "Couldn't clear checked items."
              : "Couldn't uncheck items.",
          tone: 'error',
        });
        return false;
      }
    },
    [dismiss, onChanged, show, showUndo, state],
  );

  return {
    clearDone: (listId, lifecycle) => run(listId, 'clear-done', lifecycle),
    uncheckAll: (listId, lifecycle) => run(listId, 'uncheck-all', lifecycle),
    archive: onArchive,
    remove: onDelete,
  };
}
