import {
  ApiError,
  deleteList,
  deleteListForReplay,
  isRetryable,
  type ListPage,
  patchList,
  undoListOperation,
} from '@od/shared/client';
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
import { type ToastMessage, useToast } from '@/stores/toast';
import { LISTS_KEY } from './keys';
import type { ListIndexEntry } from './useLists';

export interface ListIndexMutations {
  readonly onArchive: (list: ListIndexEntry) => void;
  readonly onRestore: (list: ListIndexEntry) => void;
  readonly onDelete: (list: ListIndexEntry) => void;
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

function failureToast(error: unknown, message: string, retry: () => void): ToastMessage {
  let displayedMessage = message;
  if (error instanceof ApiError) {
    if (error.status === 403) {
      displayedMessage = 'Only the person who made this plan can change that.';
    } else if (error.status === 404) {
      displayedMessage = "This isn't here any more.";
    } else if (error.status === 429 && error.retryAfterSeconds !== undefined) {
      displayedMessage = `Too many requests. Try again in ${error.retryAfterSeconds} seconds.`;
    }
  }
  return {
    message: displayedMessage,
    tone: 'error',
    ...(error instanceof ApiError ? { requestId: error.requestId } : {}),
    ...(isRetryable(error) ? { action: { label: 'Retry', onPress: retry } } : {}),
  };
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
      list: ListIndexEntry;
      archived: boolean;
      idempotencyKey: string;
    }) => patchList(apiClient, list.listId, { archived }, list.updatedAt, idempotencyKey),
    onMutate: async ({ list, archived }) => {
      await queryClient.cancelQueries({ queryKey: LISTS_KEY });
      const snapshot = snapshotLists(queryClient, list.listId);
      projectList(queryClient, list.listId, (current) => ({ ...current, archived }));
      return { snapshot };
    },
    onError: (error, variables, context) => {
      if (error instanceof ApiError && error.status === 404) {
        projectList(queryClient, variables.list.listId, undefined);
        refresh();
      } else if (context !== undefined) {
        restoreLists(queryClient, context.snapshot);
      }
    },
    onSuccess: (result) => {
      projectList(queryClient, result.list.listId, () => result.list);
    },
  });
  const remove = useMutation({
    mutationFn: ({ list, replay }: { list: ListIndexEntry; replay: boolean }) =>
      replay
        ? deleteListForReplay(apiClient, list.listId)
        : deleteList(apiClient, list.listId),
    onMutate: async ({ list }) => {
      await queryClient.cancelQueries({ queryKey: LISTS_KEY });
      const snapshot = snapshotLists(queryClient, list.listId);
      projectList(queryClient, list.listId, undefined);
      return { snapshot };
    },
    onError: (error, variables, context) => {
      if (error instanceof ApiError && error.status === 404) {
        projectList(queryClient, variables.list.listId, undefined);
        refresh();
      } else if (context !== undefined) {
        restoreLists(queryClient, context.snapshot);
      }
    },
  });

  const mutateArchived = useCallback(
    (
      list: ListIndexEntry,
      archived: boolean,
      idempotencyKey: string,
      offerUndo: boolean,
    ) => {
      // Acceptance owns the singleton slot synchronously, before this request can settle.
      dismissToast();
      setArchived.mutate(
        { list, archived, idempotencyKey },
        {
          onSuccess: (result) => {
            refresh();
            if (!offerUndo || !('undoToken' in result)) return;
            const duration = remainingArchiveUndoMs(result.undoExpiresAt, clock);
            if (duration === undefined) return;
            showUndo(
              archivedListToast({
                title: list.title,
                duration,
                undoExpiresAt: result.undoExpiresAt,
                onUndo: () => {
                  const inverseIdempotencyKey = randomUUID();
                  const runUndo = () => {
                    dismissToast();
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
                          inverseIdempotencyKey,
                        );
                        if (undone.data.outcome === 'applied') {
                          refresh();
                        } else {
                          restoreLists(queryClient, snapshot);
                          show({
                            message: `Couldn't undo archiving "${list.title}."`,
                            tone: 'error',
                            requestId: undone.meta.requestId,
                          });
                        }
                      } catch (error) {
                        if (error instanceof ApiError && error.status === 404) {
                          projectList(queryClient, list.listId, undefined);
                          refresh();
                        } else {
                          restoreLists(queryClient, snapshot);
                        }
                        show(
                          failureToast(
                            error,
                            `Couldn't undo archiving "${list.title}."`,
                            runUndo,
                          ),
                        );
                      }
                    })();
                  };
                  runUndo();
                },
                onCommit: () => undefined,
              }),
            );
          },
          onError: (error) =>
            show(
              failureToast(
                error,
                `Couldn't ${archived ? 'archive' : 'restore'} "${list.title}."`,
                () => mutateArchived(list, archived, idempotencyKey, offerUndo),
              ),
            ),
        },
      );
    },
    [clock, dismissToast, queryClient, refresh, setArchived, show, showUndo],
  );

  const mutateDelete = useCallback(
    (list: ListIndexEntry, replay = false) => {
      // As with archive/restore, the accepted action commits any predecessor immediately.
      dismissToast();
      remove.mutate(
        { list, replay },
        {
          onSuccess: refresh,
          onError: (error) =>
            show(
              failureToast(error, `Couldn't delete "${list.title}."`, () =>
                mutateDelete(list, true),
              ),
            ),
        },
      );
    },
    [dismissToast, refresh, remove, show],
  );

  const onArchive = useCallback(
    (list: ListIndexEntry) => {
      mutateArchived(list, true, randomUUID(), true);
    },
    [mutateArchived],
  );

  const onRestore = useCallback(
    (list: ListIndexEntry) => {
      mutateArchived(list, false, randomUUID(), false);
    },
    [mutateArchived],
  );

  const onDelete = useCallback(
    (list: ListIndexEntry) => {
      mutateDelete(list);
    },
    [mutateDelete],
  );

  return { onArchive, onRestore, onDelete };
}
