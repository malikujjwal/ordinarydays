import { randomUUID } from 'expo-crypto';
import { useState } from 'react';
import { ListTransactionService } from '@/lib/sqlite/listTransactions';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import type { AttachListToPlanResult } from './useAttachListToPlan';
import type { ListIndexEntry } from './useLists';

/** Native accepts the relationship into SQLite and its durable outbox in one commit. */
export function useAttachListToPlan(): AttachListToPlanResult {
  const state = requireActiveNativeState();
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState<string>();

  return {
    attach: async (
      list: Pick<ListIndexEntry, 'listId' | 'updatedAt'>,
      sourceActivityId: string,
    ) => {
      const lists = state.lists;
      if (lists === undefined) {
        setError('Lists are still getting ready. Try again.');
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
        console.warn('native_list_attach_failed', {
          listId: list.listId,
          sourceActivityId,
          message: caught instanceof Error ? caught.message : String(caught),
        });
        setError("Couldn't add this list.");
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
