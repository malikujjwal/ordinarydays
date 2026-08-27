import { UNDO_OFFER_SECONDS } from '@od/shared';
import type { OutboxRepository } from '@/lib/sqlite/outbox';
import type { SerializedTransactionRunner } from '@/lib/sqlite/transaction';

/** Runs exactly once while an account session is opening, before any sync engine exists. */
export function recoverAbandonedOutbox(
  transactions: SerializedTransactionRunner,
  outbox: OutboxRepository,
): Promise<number> {
  return transactions.run(async (transaction) => {
    const recovered = await outbox.recoverAbandoned(transaction.database);
    const expiredOffers = await outbox.expireUnacceptedListArchiveUndoOffers(
      transaction.database,
      Date.now() - UNDO_OFFER_SECONDS * 1000,
    );
    if (recovered > 0 || expiredOffers > 0) transaction.changed('outbox');
    return recovered;
  });
}
