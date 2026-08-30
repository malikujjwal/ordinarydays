import { randomUUID } from 'expo-crypto';
import { useState } from 'react';
import type { AddListItemResult } from '@/hooks/useAddListItem';
import { nextCanonicalId } from '@/lib/canonicalIds';
import { appendedRank } from '@/lib/pendingListItem';
import { ListTransactionService } from '@/lib/sqlite/listTransactions';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';

/**
 * `Add to {list name}` on **native**: accepted into SQLite, then synced (P3-27, §P3-08).
 *
 * One confirmation mints **one** monotonic `itm_` and **one** mutation id, and commits the
 * visible row and the queued `['list','item-create']` intent in a single transaction. Both ids
 * are reused by every replay; a fresh id on a retry is how one item becomes two rows.
 *
 * ## The rank is read inside the transaction
 *
 * §5.6's rapid entry types several items in a row, each landing before the previous one has
 * synced. Reading the last committed rank inside the writer is what makes the second item sort
 * after the first rather than beside it — a rank captured when the screen rendered would be
 * the same value for both. The server still allocates the authoritative rank, and
 * acknowledgement replaces the row.
 */
export function useAddListItem(): AddListItemResult {
  const state = requireActiveNativeState();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();

  return {
    add: async (listId, fields) => {
      const items = state.listItems;
      const lists = state.lists;
      if (items === undefined || lists === undefined) {
        setError('Native list item state is not ready.');
        return undefined;
      }
      setAdding(true);
      try {
        const itemId = nextCanonicalId('itm');
        const intentId = randomUUID();
        const service = new ListTransactionService(state.outbox, lists, items);
        await state.account.transactions.run(async (transaction) => {
          const committed = await items.read(listId, transaction.database);
          return service.createItem(transaction, {
            listId,
            itemId,
            intentId,
            idempotencyKey: intentId,
            input: {
              itemId,
              title: fields.title,
              ...(fields.note === undefined ? {} : { note: fields.note }),
            },
            rank: appendedRank(committed),
          });
        }, 'interactive');
        state.sync.request('accepted-action');
        setError(undefined);
        return itemId;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Couldn't save this.");
        return undefined;
      } finally {
        setAdding(false);
      }
    },
    isAdding: adding,
    errorMessage: error,
    errorRequestId: undefined,
    dismissError: () => setError(undefined),
  };
}
