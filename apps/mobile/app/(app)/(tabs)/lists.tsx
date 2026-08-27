import { deleteList, getMe, patchList, undoListOperation } from '@od/shared/client';
import type { List } from '@od/shared/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { type Href, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { ListsScreen } from '@/features/lists/components/ListsScreen';
import { LISTS_KEY } from '@/features/lists/hooks/keys';
import { archivedListToast } from '@/features/lists/model/archiveUndoToast';
import { apiClient } from '@/lib/apiClient';
import { useToast } from '@/stores/toast';

/**
 * `/lists` — the Lists tab (P3-25).
 *
 * Thin by rule (`tech-stack.md` §3.2): read the clock, own the mutations, render one feature
 * component. `now` is resolved **here** because `coding-standards.md` §4.3 keeps the real clock
 * at the edge; every card's `Updated today` line is computed from the value this passes down.
 *
 * ## The mutations live here, and creation does not
 *
 * Archive, restore and delete are settings writes on a row the index already holds, so the tab
 * owns them. **Creation is not here at all** — `+ New list` opens P3-26's route and this file
 * creates nothing, which is what keeps the read path and the durable-create path from growing
 * into each other before P3-26 gives the second one an outbox.
 *
 * ## Why these are web-shaped calls on both platforms
 *
 * P3-25 is read-side only for the native slice: `ListsRepository` materializes what the sync
 * engine pulls, and nothing local writes to it. So a settings write goes to the API and the
 * next pull re-materializes the row. When P3-26 brings the transactional outbox into this
 * feature, these three become intents; until then a shared call with an invalidate is honest
 * about what it is, and pretending otherwise would mean a half-built outbox nobody could test.
 */
export default function ListsTab() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const showUndo = useToast((state) => state.showUndo);
  const show = useToast((state) => state.show);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: ({ signal }) => getMe(apiClient, signal),
    enabled: false,
  });

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
            // The offer exists only when the server recorded an inverse. No token, no toast:
            // a toast offering an Undo the server cannot perform is worse than none.
            if (!('undoToken' in result)) return;
            const { undoToken } = result;
            showUndo(
              archivedListToast({
                title: list.title,
                onUndo: () => {
                  // The inverse is a durable action in its own right and takes its own key.
                  void undoListOperation(
                    apiClient,
                    list.listId,
                    undoToken,
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

  return (
    <ListsScreen
      now={new Date()}
      {...(me.data?.userId === undefined ? {} : { viewerUserId: me.data.userId })}
      onOpenList={(listId) => router.push(`/lists/${listId}` as Href)}
      onNewList={() => router.push('/lists/new' as Href)}
      onArchive={onArchive}
      onRestore={onRestore}
      onDelete={onDelete}
    />
  );
}
