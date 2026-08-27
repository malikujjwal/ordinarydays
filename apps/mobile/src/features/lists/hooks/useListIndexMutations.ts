import {
  deleteList,
  type ListPage,
  patchList,
  undoListOperation,
} from '@od/shared/client';
import type { List } from '@od/shared/types';
import {
  type InfiniteData,
  type QueryClient,
  type QueryKey,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
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

type ListPages = InfiniteData<ListPage>;
type CachedList = ListPage['data'][number];
interface ListPosition {
  readonly pageIndex: number;
  readonly itemIndex: number;
  readonly list: CachedList;
}
interface ListQuerySnapshot {
  readonly key: QueryKey;
  readonly positions: readonly ListPosition[];
}
interface ListSnapshot {
  readonly listId: string;
  readonly queries: readonly ListQuerySnapshot[];
}

function projectList(
  queryClient: QueryClient,
  listId: string,
  update: ((list: CachedList) => CachedList) | undefined,
): void {
  queryClient.setQueriesData<ListPages>({ queryKey: LISTS_KEY }, (current) => {
    if (current === undefined) return current;
    return {
      ...current,
      pages: current.pages.map((page) => ({
        ...page,
        data:
          update === undefined
            ? page.data.filter((list) => list.listId !== listId)
            : page.data.map((list) => (list.listId === listId ? update(list) : list)),
      })),
    };
  });
}

function snapshotLists(queryClient: QueryClient, listId: string): ListSnapshot {
  const queries = queryClient
    .getQueriesData<ListPages>({ queryKey: LISTS_KEY })
    .flatMap(([key, data]) => {
      const positions =
        data?.pages.flatMap((page, pageIndex) =>
          page.data.flatMap((list, itemIndex) =>
            list.listId === listId ? [{ pageIndex, itemIndex, list }] : [],
          ),
        ) ?? [];
      return positions.length > 0 ? [{ key, positions }] : [];
    });
  return { listId, queries };
}

function restoreLists(queryClient: QueryClient, snapshot: ListSnapshot): void {
  for (const { key, positions } of snapshot.queries) {
    queryClient.setQueryData<ListPages>(key, (current) => {
      if (current === undefined) return current;
      const currentContainsList = current.pages.some((page) =>
        page.data.some((list) => list.listId === snapshot.listId),
      );
      if (currentContainsList) {
        const original = positions[0]?.list;
        if (original === undefined) return current;
        return {
          ...current,
          pages: current.pages.map((page) => ({
            ...page,
            data: page.data.map((list) =>
              list.listId === snapshot.listId ? original : list,
            ),
          })),
        };
      }
      const pages = current.pages.map((page) => ({
        ...page,
        data: page.data.filter((list) => list.listId !== snapshot.listId),
      }));
      for (const { pageIndex, itemIndex, list } of positions) {
        const page = pages[pageIndex];
        if (page === undefined) continue;
        const data = [...page.data];
        data.splice(Math.min(itemIndex, data.length), 0, list);
        pages[pageIndex] = { ...page, data };
      }
      return { ...current, pages };
    });
  }
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
    onMutate: async ({ list, archived }) => {
      await queryClient.cancelQueries({ queryKey: LISTS_KEY });
      const snapshot = snapshotLists(queryClient, list.listId);
      projectList(queryClient, list.listId, (current) => ({ ...current, archived }));
      return { snapshot };
    },
    onError: (_error, _variables, context) => {
      if (context !== undefined) restoreLists(queryClient, context.snapshot);
    },
    onSuccess: (result) => {
      projectList(queryClient, result.list.listId, () => result.list);
    },
  });
  const remove = useMutation({
    mutationFn: (list: List) => deleteList(apiClient, list.listId),
    onMutate: async (list) => {
      await queryClient.cancelQueries({ queryKey: LISTS_KEY });
      const snapshot = snapshotLists(queryClient, list.listId);
      projectList(queryClient, list.listId, undefined);
      return { snapshot };
    },
    onError: (_error, _variables, context) => {
      if (context !== undefined) restoreLists(queryClient, context.snapshot);
    },
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
                  void (async () => {
                    await queryClient.cancelQueries({ queryKey: LISTS_KEY });
                    const snapshot = snapshotLists(queryClient, list.listId);
                    projectList(queryClient, list.listId, (current) => ({
                      ...current,
                      archived: false,
                    }));
                    try {
                      const undone = await undoListOperation(
                        apiClient,
                        list.listId,
                        result.undoToken,
                        randomUUID(),
                      );
                      if (undone.outcome === 'applied') {
                        refresh();
                      } else {
                        restoreLists(queryClient, snapshot);
                        show({
                          message: `Couldn't undo archiving "${list.title}."`,
                          tone: 'error',
                        });
                      }
                    } catch {
                      restoreLists(queryClient, snapshot);
                      show({
                        message: `Couldn't undo archiving "${list.title}."`,
                        tone: 'error',
                      });
                    }
                  })();
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
    [clock, dismissToast, queryClient, refresh, setArchived, show, showUndo],
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
