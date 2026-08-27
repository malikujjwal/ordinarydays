import type { List } from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import { useCallback, useMemo } from 'react';
import { archivedListToast } from '@/features/lists/model/archiveUndoToast';
import { ListTransactionService } from '@/lib/sqlite/listTransactions';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import { useToast } from '@/stores/toast';
import type { ListIndexMutations } from './useListIndexMutations';

export function useListIndexMutations(): ListIndexMutations {
  const state = requireActiveNativeState();
  if (state.lists === undefined) throw new Error('Native Lists state is not ready.');
  const lists = state.lists;
  const service = useMemo(
    () => new ListTransactionService(state.outbox, lists),
    [lists, state.outbox],
  );
  const showUndo = useToast((store) => store.showUndo);
  const show = useToast((store) => store.show);

  const queueArchive = useCallback(
    async (list: List, archived: boolean) => {
      await state.account.transactions.run(
        (transaction) => service.setArchived(transaction, list, archived, randomUUID()),
        'interactive',
      );
      state.sync.request('accepted-action');
    },
    [service, state.account.transactions, state.sync],
  );

  const onArchive = useCallback(
    (list: List) => {
      void queueArchive(list, true)
        .then(() => {
          showUndo(
            archivedListToast({
              title: list.title,
              onUndo: () => {
                void queueArchive(list, false).catch(() =>
                  show({ message: `Couldn't restore "${list.title}."`, tone: 'error' }),
                );
              },
              onCommit: () => undefined,
            }),
          );
        })
        .catch(() =>
          show({ message: `Couldn't archive "${list.title}."`, tone: 'error' }),
        );
    },
    [queueArchive, show, showUndo],
  );

  const onRestore = useCallback(
    (list: List) => {
      void queueArchive(list, false).catch(() =>
        show({ message: `Couldn't restore "${list.title}."`, tone: 'error' }),
      );
    },
    [queueArchive, show],
  );

  const onDelete = useCallback(
    (list: List) => {
      void state.account.transactions
        .run(
          (transaction) => service.remove(transaction, list, randomUUID()),
          'interactive',
        )
        .then(() => state.sync.request('accepted-action'))
        .catch(() =>
          show({ message: `Couldn't delete "${list.title}."`, tone: 'error' }),
        );
    },
    [service, show, state.account.transactions, state.sync],
  );

  return { onArchive, onRestore, onDelete };
}
