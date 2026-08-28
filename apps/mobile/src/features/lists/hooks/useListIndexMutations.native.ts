import type { List } from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import { useCallback, useMemo, useRef } from 'react';
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
  const dismissToast = useToast((store) => store.dismiss);
  const latestPublication = useRef(0);

  const queueArchive = useCallback(
    async (list: List, archived: boolean, intentId: string) => {
      await state.account.transactions.run(
        (transaction) => service.setArchived(transaction, list, archived, intentId),
        'interactive',
      );
      state.sync.request('accepted-action');
      return intentId;
    },
    [service, state.account.transactions, state.sync],
  );

  const runArchive = useCallback(
    (list: List, archived: boolean, intentId: string, offerUndo: boolean) => {
      const publication = ++latestPublication.current;
      // The accepted action takes the singleton slot before durable append can settle.
      dismissToast();
      void queueArchive(list, archived, intentId)
        .then((originalIntentId) => {
          if (!offerUndo || publication !== latestPublication.current) return;
          showUndo(
            archivedListToast({
              title: list.title,
              onUndo: () => {
                const inverseIntentId = randomUUID();
                const runUndo = () => {
                  const undoPublication = ++latestPublication.current;
                  dismissToast();
                  void state.account.transactions
                    .run(
                      (transaction) =>
                        service.undoSettings(
                          transaction,
                          list.listId,
                          originalIntentId,
                          inverseIntentId,
                        ),
                      'interactive',
                    )
                    .then((result) => {
                      if (result.kind === 'queued') {
                        state.sync.request('accepted-action');
                      }
                    })
                    .catch(() => {
                      if (undoPublication !== latestPublication.current) return;
                      show({
                        message: `Couldn't undo archiving "${list.title}."`,
                        tone: 'error',
                        action: { label: 'Retry', onPress: runUndo },
                      });
                    });
                };
                runUndo();
              },
              onCommit: () => {
                void state.account.transactions.run(
                  (transaction) =>
                    service.commitArchiveUndoOffer(transaction, originalIntentId),
                  'interactive',
                );
              },
            }),
          );
        })
        .catch(() => {
          if (publication !== latestPublication.current) return;
          show({
            message: `Couldn't ${archived ? 'archive' : 'restore'} "${list.title}."`,
            tone: 'error',
            action: {
              label: 'Retry',
              onPress: () => runArchive(list, archived, intentId, offerUndo),
            },
          });
        });
    },
    [
      dismissToast,
      queueArchive,
      service,
      show,
      showUndo,
      state.account.transactions,
      state.sync,
    ],
  );

  const runDelete = useCallback(
    (list: List, intentId: string) => {
      const publication = ++latestPublication.current;
      dismissToast();
      void state.account.transactions
        .run((transaction) => service.remove(transaction, list, intentId), 'interactive')
        .then(() => state.sync.request('accepted-action'))
        .catch(() => {
          if (publication !== latestPublication.current) return;
          show({
            message: `Couldn't delete "${list.title}."`,
            tone: 'error',
            action: {
              label: 'Retry',
              onPress: () => runDelete(list, intentId),
            },
          });
        });
    },
    [dismissToast, service, show, state.account.transactions, state.sync],
  );

  const onArchive = useCallback(
    (list: List) => {
      runArchive(list, true, randomUUID(), true);
    },
    [runArchive],
  );

  const onRestore = useCallback(
    (list: List) => {
      runArchive(list, false, randomUUID(), false);
    },
    [runArchive],
  );

  const onDelete = useCallback(
    (list: List) => {
      runDelete(list, randomUUID());
    },
    [runDelete],
  );

  return { onArchive, onRestore, onDelete };
}
