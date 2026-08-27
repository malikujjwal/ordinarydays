import { deleteList, patchList, undoListOperation } from '@od/shared/client';
import type { List } from '@od/shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useCallback } from 'react';
import {
  archivedListToast,
  remainingArchiveUndoMs,
} from '@/features/lists/model/archiveUndoToast';
import { useClock } from '@/hooks/useClock';
import { apiClient } from '@/lib/apiClient';
import { useToast } from '@/stores/toast';
import { LISTS_KEY } from './keys';

export interface ListIndexMutations {
  readonly onArchive: (list: List) => void;
  readonly onRestore: (list: List) => void;
  readonly onDelete: (list: List) => void;
}

/** Web keeps its online-first mutation adapter. */
export function useListIndexMutations(): ListIndexMutations {
  const queryClient = useQueryClient();
  const clock = useClock();
  const showUndo = useToast((state) => state.showUndo);
  const show = useToast((state) => state.show);
  const dismissToast = useToast((state) => state.dismiss);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: LISTS_KEY });
  }, [queryClient]);
  const setArchived = useMutation({
    mutationFn: ({
      list,
      archived,
      idempotencyKey,
    }: {
      list: List;
      archived: boolean;
      idempotencyKey: string;
    }) => patchList(apiClient, list.listId, { archived }, list.updatedAt, idempotencyKey),
  });
  const remove = useMutation({
    mutationFn: (list: List) => deleteList(apiClient, list.listId),
  });

  const onArchive = useCallback(
    (list: List) => {
      // A new action owns the singleton confirmation slot, even if its server-side
      // Undo offer has expired before the response arrives.
      dismissToast();
      setArchived.mutate(
        { list, archived: true, idempotencyKey: randomUUID() },
        {
          onSuccess: (result) => {
            refresh();
            if (!('undoToken' in result)) return;
            const duration = remainingArchiveUndoMs(result.undoExpiresAt, clock);
            if (duration === undefined) return;
            showUndo(
              archivedListToast({
                title: list.title,
                duration,
                undoExpiresAt: result.undoExpiresAt,
                onUndo: () => {
                  void undoListOperation(
                    apiClient,
                    list.listId,
                    result.undoToken,
                    randomUUID(),
                  ).then(refresh);
                },
                onCommit: () => undefined,
              }),
            );
          },
          onError: () =>
            show({ message: `Couldn't archive "${list.title}."`, tone: 'error' }),
        },
      );
    },
    [clock, dismissToast, refresh, setArchived, show, showUndo],
  );

  const onRestore = useCallback(
    (list: List) => {
      setArchived.mutate(
        { list, archived: false, idempotencyKey: randomUUID() },
        {
          onSuccess: refresh,
          onError: () =>
            show({ message: `Couldn't restore "${list.title}."`, tone: 'error' }),
        },
      );
    },
    [refresh, setArchived, show],
  );

  const onDelete = useCallback(
    (list: List) => {
      remove.mutate(list, {
        onSuccess: refresh,
        onError: () =>
          show({ message: `Couldn't delete "${list.title}."`, tone: 'error' }),
      });
    },
    [refresh, remove, show],
  );

  return { onArchive, onRestore, onDelete };
}
