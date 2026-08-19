import type { OutboxRepository } from '@/lib/sqlite/outbox';
import type { SerializedTransactionRunner } from '@/lib/sqlite/transaction';

/** Runs exactly once while an account session is opening, before any sync engine exists. */
export function recoverAbandonedOutbox(
  transactions: SerializedTransactionRunner,
  outbox: OutboxRepository,
): Promise<number> {
  return transactions.run(async (transaction) => {
    const recovered = await outbox.recoverAbandoned(transaction.database);
    if (recovered > 0) transaction.changed('outbox');
    return recovered;
  });
}
