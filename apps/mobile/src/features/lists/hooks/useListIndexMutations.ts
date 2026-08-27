import { deleteList, patchList, undoListOperation } from '@od/shared/client';
import type { List } from '@od/shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useCallback } from 'react';
import { archivedListToast } from '@/features/lists/model/archiveUndoToast';
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
  const showUndo = useToast((state) => state.showUndo);
  const show = useToast((state) => state.show);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: LISTS_KEY });
  }, [queryClient]);
  const setArchived = useMutation({
    mutationFn: ({ list, archived }: { list: List; archived: boolean }) =>
      patchList(apiClient, list.listId, { archived }, list.updatedAt),
  });
  const remove = useMutation({
    mutationFn: (list: List) => deleteList(apiClient, list.listId),
  });

  const onArchive = useCallback(
    (list: List) => {
      setArchived.mutate(
        { list, archived: true },
        {
          onSuccess: (result) => {
            refresh();
            if (!('undoToken' in result)) return;
            showUndo(
              archivedListToast({
                title: list.title,
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
    [refresh, setArchived, show, showUndo],
  );

  const onRestore = useCallback(
    (list: List) => {
      setArchived.mutate(
        { list, archived: false },
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
