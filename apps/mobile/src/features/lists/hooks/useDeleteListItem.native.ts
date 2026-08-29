import { ListTransactionService } from '@/lib/sqlite/listTransactions';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import type { DeleteListItemProjection } from './useDeleteListItem';

/** Native projects delete and Undo through one durable ordered lane. */
export function useDeleteListItem(): DeleteListItemProjection {
  const state = requireActiveNativeState();
  const dependencies = () => {
    if (state.lists === undefined || state.listItems === undefined) {
      throw new Error('Native list item state is not ready.');
    }
    return new ListTransactionService(state.outbox, state.lists, state.listItems);
  };

  return {
    kind: 'durable',
    prepare: async (item, intentId) => {
      const service = dependencies();
      await state.account.transactions.run(
        (transaction) =>
          service.deleteItem(transaction, {
            listId: item.listId,
            itemId: item.itemId,
            intentId,
            idempotencyKey: intentId,
          }),
        'interactive',
      );
    },
    undo: async (originalIntentId, inverseIntentId) => {
      const service = dependencies();
      await state.account.transactions.run(
        (transaction) =>
          service.undoDeletedItem(transaction, originalIntentId, inverseIntentId),
        'interactive',
      );
    },
    commit: async (originalIntentId) => {
      const service = dependencies();
      await state.account.transactions.run(
        (transaction) => service.commitItemDeleteUndoOffer(transaction, originalIntentId),
        'interactive',
      );
    },
    requestSync: () => state.sync.request('accepted-action'),
  };
}
