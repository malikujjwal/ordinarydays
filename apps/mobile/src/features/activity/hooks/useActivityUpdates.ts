import { getActivityUpdates } from '@od/shared/client';
import type {
  ActivityUpdate,
  DeletedActivityUpdate,
  PostActivityUpdateResult,
} from '@od/shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useCallback, useRef, useState } from 'react';
import { apiClient } from '@/lib/apiClient';
import type {
  ActivityUpdateDeleteVariables,
  ActivityUpdatePostVariables,
} from '@/lib/mutationDefaults';
import { activityUpdateMutationKeys } from '@/lib/mutationKeys';
import { raisePlanActivityFloor } from '@/lib/planActivityFloors';
import { activityKey } from '@/lib/queryKeys';
import {
  type ActivityUpdatesFailure,
  type ActivityUpdatesView,
  dedupe,
  describeUpdatesFailure,
  EMPTY_UPDATES,
  newestFirst,
  type PendingUpdate,
} from '../model/updatesFeed';

export type {
  ActivityUpdatesFailure,
  ActivityUpdatesFailureAction,
  ActivityUpdatesView,
  PendingUpdate,
} from '../model/updatesFeed';

/**
 * The plan's Updates feed (P3-40, `plans-and-lists.md` §2.1 row 9) — web adapter.
 *
 * Seeded from the page the detail response **embeds** (opening a plan issues no second
 * request, P3-37) and continued through `GET .../updates?cursor=` only when the user reveals
 * more. Local writes are simple: a post shows a pending row, then the response row, and
 * invalidates the detail query; the strong detail read that follows is the reconciliation.
 * The response row and any delete mask are kept only until an embedded head contains them,
 * so an older in-flight detail response cannot hide a post or resurrect a delete, and nothing
 * needs to remember more than that.
 */
export function useActivityUpdates(
  activityId: string,
  embedded: {
    updates: readonly ActivityUpdate[] | undefined;
    cursor: string | undefined;
  },
): ActivityUpdatesView {
  const head = embedded.updates ?? EMPTY_UPDATES;
  const queryClient = useQueryClient();
  /** Rows this client posted, until an embedded head includes them. */
  const [posted, setPosted] = useState<readonly ActivityUpdate[]>([]);
  /** Ids this client deleted, until an embedded head no longer includes them. */
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set());
  const [older, setOlder] = useState<readonly ActivityUpdate[]>([]);
  const [cursor, setCursor] = useState(embedded.cursor);
  const [pending, setPending] = useState<readonly PendingUpdate[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<ActivityUpdatesFailure>();
  const [failedPost, setFailedPost] = useState<ActivityUpdatePostVariables>();
  const [failedDelete, setFailedDelete] = useState<ActivityUpdate>();
  const [failedCursor, setFailedCursor] = useState<string>();

  /**
   * Adjust-on-prop-change, as state so a discarded render re-runs it. A different activity
   * under the same mounted screen resets everything; a new embedded head (a refetch) resets
   * only the continuation and retires the local rows and masks it now accounts for. The
   * head is compared by identity: the query cache's structural sharing keeps the same array
   * across equal refetches, so identity changes exactly when the server page did.
   */
  const [seed, setSeed] = useState({ activityId, head, cursor: embedded.cursor });
  if (seed.activityId !== activityId) {
    setSeed({ activityId, head, cursor: embedded.cursor });
    setPosted([]);
    setDeleted(new Set());
    setOlder([]);
    setCursor(embedded.cursor);
    setPending([]);
    setLoadingMore(false);
    setFailure(undefined);
    setFailedPost(undefined);
    setFailedDelete(undefined);
    setFailedCursor(undefined);
  } else if (seed.head !== head || seed.cursor !== embedded.cursor) {
    setSeed({ activityId, head, cursor: embedded.cursor });
    const ids = new Set(head.map((entry) => entry.updateId));
    setPosted((current) => current.filter((entry) => !ids.has(entry.updateId)));
    setDeleted((current) => new Set([...current].filter((id) => ids.has(id))));
    setOlder([]);
    setCursor(embedded.cursor);
  }
  /** Guards async callbacks: a response that started under a previous activity is dropped. */
  const liveActivity = useRef(activityId);
  liveActivity.current = activityId;
  /** The head a continuation was requested against; a page for an older head is dropped. */
  const liveHead = useRef(head);
  liveHead.current = head;

  const refreshDetail = useCallback(
    () => queryClient.invalidateQueries({ queryKey: activityKey(activityId) }),
    [activityId, queryClient],
  );

  const postMutation = useMutation<
    PostActivityUpdateResult,
    unknown,
    ActivityUpdatePostVariables
  >({
    mutationKey: activityUpdateMutationKeys.post,
    onMutate: (variables) => {
      setPending((current) => [
        { localId: variables.localId, body: variables.body },
        ...current,
      ]);
    },
    onSuccess: (result, variables) => {
      // The floor is per-activity truth, so it is raised even if the screen moved on.
      raisePlanActivityFloor(queryClient, variables.activityId, result.lastActivityAt);
      if (liveActivity.current !== variables.activityId) return;
      setPosted((current) => dedupe([result.update, ...current]));
      setFailedPost(undefined);
      setFailure(undefined);
      void refreshDetail();
    },
    onError: (caught, variables) => {
      if (liveActivity.current !== variables.activityId) return;
      setFailedPost(variables);
      setFailure(describeUpdatesFailure(caught, 'post'));
    },
    onSettled: (_result, _caught, variables) => {
      setPending((current) =>
        current.filter((entry) => entry.localId !== variables.localId),
      );
    },
  });

  const deleteMutation = useMutation<
    DeletedActivityUpdate,
    unknown,
    ActivityUpdateDeleteVariables & { readonly update: ActivityUpdate }
  >({
    mutationKey: activityUpdateMutationKeys.delete,
    onMutate: (variables) => {
      setDeleted((current) => new Set(current).add(variables.updateId));
    },
    onSuccess: (_deleted, variables) => {
      if (liveActivity.current !== variables.activityId) return;
      setFailedDelete(undefined);
      setFailure(undefined);
      void refreshDetail();
    },
    onError: (caught, variables) => {
      if (liveActivity.current !== variables.activityId) return;
      setDeleted((current) => {
        const next = new Set(current);
        next.delete(variables.updateId);
        return next;
      });
      setFailedDelete(variables.update);
      setFailure(describeUpdatesFailure(caught, 'delete'));
    },
  });

  const loadPage = useCallback(
    async (requestedCursor: string): Promise<boolean> => {
      const requested = activityId;
      const requestedHead = liveHead.current;
      setLoadingMore(true);
      try {
        const page = await getActivityUpdates(apiClient, activityId, requestedCursor);
        if (liveActivity.current !== requested) return false;
        // A strong refetch installed a new head (and cursor) while this page was in flight:
        // the page belongs to the old chain and would resurrect deletes or skip entries.
        if (liveHead.current !== requestedHead) return false;
        setOlder((current) => dedupe([...current, ...page.updates]));
        setCursor(page.cursor);
        setFailedCursor(undefined);
        setFailure(undefined);
        return true;
      } catch (caught) {
        if (liveActivity.current === requested) {
          setFailedCursor(requestedCursor);
          setFailure(describeUpdatesFailure(caught, 'load'));
        }
        return false;
      } finally {
        if (liveActivity.current === requested) setLoadingMore(false);
      }
    },
    [activityId],
  );

  const loadMore = useCallback(() => {
    if (cursor === undefined || loadingMore) return;
    void loadPage(cursor);
  }, [cursor, loadPage, loadingMore]);

  const post = useCallback(
    async (body: string): Promise<boolean> => {
      const trimmed = body.trim();
      if (trimmed === '' || postMutation.isPending) return false;
      try {
        await postMutation.mutateAsync({
          activityId,
          body: trimmed,
          localId: randomUUID(),
          idempotencyKey: randomUUID(),
        });
        return true;
      } catch {
        return false;
      }
    },
    [activityId, postMutation],
  );

  const remove = useCallback(
    async (update: ActivityUpdate): Promise<boolean> => {
      // The affordance never exists on a system entry; this guard makes the rule hold even
      // for a caller that bypassed the row.
      if (update.kind !== 'user') return false;
      try {
        await deleteMutation.mutateAsync({
          activityId,
          updateId: update.updateId,
          update,
        });
        return true;
      } catch {
        return false;
      }
    },
    [activityId, deleteMutation],
  );

  const retryFailure = useCallback(async (): Promise<boolean> => {
    try {
      if (failure?.action === 'load' && failedCursor !== undefined) {
        return loadPage(failedCursor);
      }
      if (failure?.action === 'post' && failedPost !== undefined) {
        // The same idempotency key, so a retry after a lost response cannot post twice.
        await postMutation.mutateAsync(failedPost);
        return true;
      }
      if (failure?.action === 'delete' && failedDelete !== undefined) {
        return remove(failedDelete);
      }
      return false;
    } catch {
      return false;
    }
  }, [
    failedCursor,
    failedDelete,
    failedPost,
    failure?.action,
    loadPage,
    postMutation,
    remove,
  ]);

  const dismissError = useCallback(() => setFailure(undefined), []);

  return {
    updates: newestFirst(
      dedupe([...posted, ...head, ...older]).filter(
        (entry) => !deleted.has(entry.updateId),
      ),
    ),
    pending,
    cursor,
    isLoadingMore: loadingMore,
    isPosting: postMutation.isPending,
    loadMore,
    post,
    remove,
    errorMessage: failure?.message,
    errorRequestId: failure?.requestId,
    errorAction: failure?.action,
    retryFailure,
    dismissError,
  };
}
