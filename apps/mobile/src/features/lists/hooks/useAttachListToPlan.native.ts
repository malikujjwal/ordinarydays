import type { List } from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import { useState } from 'react';
import { ListTransactionService } from '@/lib/sqlite/listTransactions';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import type { AttachListToPlanResult } from './useAttachListToPlan';

/** Native accepts the relationship into SQLite and its durable outbox in one commit. */
export function useAttachListToPlan(): AttachListToPlanResult {
  const state = requireActiveNativeState();
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState<string>();

  return {
    attach: async (list: List, sourceActivityId: string) => {
      const lists = state.lists;
      if (lists === undefined) {
        setError('Native Lists state is not ready.');
        return false;
      }
      setAttaching(true);
      try {
        const intentId = randomUUID();
        await state.account.transactions.run(
          (transaction) =>
            new ListTransactionService(state.outbox, lists).patchSettings(
              transaction,
              list,
              { sourceActivityId },
              intentId,
            ),
          'interactive',
        );
        state.sync.request('accepted-action');
        setError(undefined);
        return true;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Couldn't add this list.");
        return false;
      } finally {
        setAttaching(false);
      }
    },
    isAttaching: attaching,
    errorMessage: error,
    errorRequestId: undefined,
    dismissError: () => setError(undefined),
  };
}
