import { getActivityUpdates } from '@od/shared/client';
import type {
  ActivityUpdate,
  DeletedActivityUpdate,
  PostActivityUpdateResult,
} from '@od/shared/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '@/lib/apiClient';
import { describeApiFailure } from '@/lib/apiFailure';
import type {
  ActivityUpdateDeleteVariables,
  ActivityUpdatePostVariables,
} from '@/lib/mutationDefaults';
import { activityUpdateMutationKeys } from '@/lib/mutationKeys';
import { raisePlanActivityFloor } from '@/lib/planActivityFloors';
import { activityUpdatesKey } from './keys';

/**
 * The plan's Updates feed (P3-40, `plans-and-lists.md` §2.1 row 9).
 *
 * Seeded from the page the detail response **embeds** — opening a plan issues no second
 * request (P3-37's one-request rule) — and continued through `GET .../updates?cursor=` only
 * when the user reveals more. This is the web adapter: the native sibling installs the feed,
 * cursor, and authoritative Plans timestamp in SQLite before presenting confirmation.
 *
 * ## The optimistic post, and what makes it safe
 *
 * `post` renders the entry at the head immediately under a local id, then replaces it with
 * the stored row from the response. The response's `lastActivityAt` is raised into
 * {@link usePlanActivityFloor} so the Plans tab moves the row at once and a stale
 * eventually-consistent refetch cannot move it back. A rejected post removes the local entry
 * and surfaces the failure — nothing pretends to have been recorded.
 */

/** A not-yet-acknowledged entry, rendered at the head under a local identity. */
export interface PendingUpdate {
  readonly localId: string;
  readonly body: string;
}

export type ActivityUpdatesFailureAction = 'load' | 'post' | 'delete';

export interface ActivityUpdatesFailure {
  readonly action: ActivityUpdatesFailureAction;
  readonly message: string;
  readonly requestId?: string;
}

export interface ActivityUpdatesView {
  readonly updates: readonly ActivityUpdate[];
  readonly pending: readonly PendingUpdate[];
  /** `undefined` once the feed's ordinary pagination is exhausted. */
  readonly cursor: string | undefined;
  readonly isLoadingMore: boolean;
  readonly isPosting: boolean;
  readonly loadMore: () => void;
  readonly post: (body: string) => Promise<boolean>;
  readonly remove: (update: ActivityUpdate) => Promise<boolean>;
  readonly errorMessage: string | undefined;
  readonly errorRequestId: string | undefined;
  readonly errorAction: ActivityUpdatesFailureAction | undefined;
  /** Replays failed paging/deletion; post retry is owned by the draft-preserving composer. */
  readonly retryFailure: () => Promise<boolean>;
  readonly dismissError: () => void;
}

function describeFailure(
  error: unknown,
  action: ActivityUpdatesFailureAction,
): ActivityUpdatesFailure {
  const fallback =
    action === 'load'
      ? "Couldn't load older updates."
      : action === 'post'
        ? "Couldn't post this update."
        : "Couldn't delete this update.";
  return { action, ...describeApiFailure(error, fallback) };
}

/** Newest first; the id tiebreak keeps two same-instant entries in one stable order. */
function newestFirst(entries: readonly ActivityUpdate[]): ActivityUpdate[] {
  return [...entries].sort((a, b) =>
    a.createdAt === b.createdAt
      ? b.updateId.localeCompare(a.updateId)
      : b.createdAt.localeCompare(a.createdAt),
  );
}

function dedupe(entries: readonly ActivityUpdate[]): ActivityUpdate[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.updateId)) return false;
    seen.add(entry.updateId);
    return true;
  });
}

interface ActivityUpdatesCache {
  /** The latest first page embedded by Activity detail. */
  readonly head: readonly ActivityUpdate[];
  /** Pages explicitly fetched through the continuation cursor. */
  readonly older: readonly ActivityUpdate[];
  /** Web writes acknowledged before an eventually-consistent detail read contains them. */
  readonly acknowledged: readonly ActivityUpdate[];
  /** Acknowledged deletes that an older detail projection must not resurrect. */
  readonly deletedUpdateIds: readonly string[];
  /** Pre-refresh local posts that a complete strong cursor chain may prove absent. */
  readonly reconcilingAcknowledgedIds?: readonly string[];
  /** Pre-refresh delete masks whose target has not appeared in the current strong chain. */
  readonly reconcilingDeletedUpdateIds?: readonly string[];
  /** Cursor that arrived with `head`, used to detect a newer embedded projection. */
  readonly headCursor: string | undefined;
  /** Value identity prevents render-created arrays from impersonating a fresh server head. */
  readonly headIdentity?: string;
  readonly cursor: string | undefined;
}

function headIdentity(embedded: {
  updates: readonly ActivityUpdate[];
  cursor: string | undefined;
  revision?: number;
}): string {
  return JSON.stringify([
    embedded.revision ?? null,
    embedded.cursor ?? null,
    embedded.updates.map((entry) => [
      entry.updateId,
      entry.kind,
      entry.authorUserId ?? null,
      entry.body,
      entry.createdAt,
      entry.schemaVersion,
    ]),
  ]);
}

function initialCache(embedded: {
  updates: readonly ActivityUpdate[];
  cursor: string | undefined;
  revision?: number;
}): ActivityUpdatesCache {
  return {
    head: embedded.updates,
    older: [],
    acknowledged: [],
    deletedUpdateIds: [],
    reconcilingAcknowledgedIds: [],
    reconcilingDeletedUpdateIds: [],
    headCursor: embedded.cursor,
    headIdentity: headIdentity(embedded),
    cursor: embedded.cursor,
  };
}

/**
 * A successful Activity-detail read is authoritative for the embedded head page. Local writes
 * remain overlays until that head contains their acknowledgement, so an older read cannot undo
 * a post/delete that this client already saw succeed.
 */
function reconcileEmbedded(
  current: ActivityUpdatesCache,
  embedded: {
    updates: readonly ActivityUpdate[];
    cursor: string | undefined;
    revision?: number;
  },
): ActivityUpdatesCache {
  const nextHeadIdentity = headIdentity(embedded);
  const currentHeadIdentity =
    current.headIdentity ??
    headIdentity({ updates: current.head, cursor: current.headCursor });
  if (currentHeadIdentity === nextHeadIdentity) {
    return current;
  }
  const embeddedIds = new Set(embedded.updates.map((entry) => entry.updateId));
  let acknowledged = current.acknowledged.filter(
    (entry) => !embeddedIds.has(entry.updateId),
  );
  let deletedUpdateIds = current.deletedUpdateIds;
  let reconcilingAcknowledgedIds = acknowledged.map((entry) => entry.updateId);
  let reconcilingDeletedUpdateIds = deletedUpdateIds.filter((id) => !embeddedIds.has(id));
  if (embedded.cursor === undefined) {
    const absentPosts = new Set(reconcilingAcknowledgedIds);
    const absentDeletes = new Set(reconcilingDeletedUpdateIds);
    acknowledged = acknowledged.filter((entry) => !absentPosts.has(entry.updateId));
    deletedUpdateIds = deletedUpdateIds.filter((id) => !absentDeletes.has(id));
    reconcilingAcknowledgedIds = [];
    reconcilingDeletedUpdateIds = [];
  }
  return {
    ...current,
    head: embedded.updates,
    older: [],
    acknowledged,
    deletedUpdateIds,
    reconcilingAcknowledgedIds,
    reconcilingDeletedUpdateIds,
    headCursor: embedded.cursor,
    headIdentity: nextHeadIdentity,
    cursor: embedded.cursor,
  };
}

function materialize(cache: ActivityUpdatesCache): ActivityUpdate[] {
  const deleted = new Set(cache.deletedUpdateIds);
  return newestFirst(
    dedupe([...cache.acknowledged, ...cache.head, ...cache.older]).filter(
      (entry) => !deleted.has(entry.updateId),
    ),
  );
}

type PostVariables = ActivityUpdatePostVariables;

interface ContinuationRequest {
  readonly cursor: string;
  readonly headIdentity: string;
}

export function useActivityUpdates(
  activityId: string,
  embedded: {
    updates: readonly ActivityUpdate[];
    cursor: string | undefined;
    revision?: number;
  },
): ActivityUpdatesView {
  const [pending, setPending] = useState<readonly PendingUpdate[]>([]);
  const [failure, setFailure] = useState<ActivityUpdatesFailure>();
  const [failedPost, setFailedPost] = useState<PostVariables>();
  const [failedDelete, setFailedDelete] = useState<ActivityUpdate>();
  const [failedContinuation, setFailedContinuation] = useState<ContinuationRequest>();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => activityUpdatesKey(activityId), [activityId]);
  const cached = useQuery({
    queryKey,
    queryFn: () => Promise.resolve(initialCache(embedded)),
    initialData: initialCache(embedded),
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  }).data;
  const feed = reconcileEmbedded(cached, embedded);

  useEffect(() => {
    if (feed !== cached) {
      queryClient.setQueryData<ActivityUpdatesCache>(queryKey, (current) =>
        current === cached ? feed : current,
      );
    }
  }, [cached, feed, queryClient, queryKey]);

  const loadMoreMutation = useMutation({
    mutationFn: (request: ContinuationRequest) =>
      getActivityUpdates(apiClient, activityId, request.cursor),
    onSuccess: (page, request) => {
      queryClient.setQueryData<ActivityUpdatesCache>(
        queryKey,
        (current = initialCache(embedded)) => {
          const baseline = reconcileEmbedded(current, embedded);
          if (
            baseline.headIdentity !== request.headIdentity ||
            baseline.cursor !== request.cursor
          ) {
            return baseline;
          }
          const pageIds = new Set(page.updates.map((entry) => entry.updateId));
          let acknowledged = baseline.acknowledged.filter(
            (entry) => !pageIds.has(entry.updateId),
          );
          let deletedUpdateIds = baseline.deletedUpdateIds;
          let reconcilingAcknowledgedIds = (
            baseline.reconcilingAcknowledgedIds ?? []
          ).filter((id) => !pageIds.has(id));
          let reconcilingDeletedUpdateIds = (
            baseline.reconcilingDeletedUpdateIds ?? []
          ).filter((id) => !pageIds.has(id));
          if (page.cursor === undefined) {
            const absentPosts = new Set(reconcilingAcknowledgedIds);
            const absentDeletes = new Set(reconcilingDeletedUpdateIds);
            acknowledged = acknowledged.filter(
              (entry) => !absentPosts.has(entry.updateId),
            );
            deletedUpdateIds = deletedUpdateIds.filter((id) => !absentDeletes.has(id));
            reconcilingAcknowledgedIds = [];
            reconcilingDeletedUpdateIds = [];
          }
          return {
            ...baseline,
            older: dedupe([...baseline.older, ...page.updates]),
            acknowledged,
            deletedUpdateIds,
            reconcilingAcknowledgedIds,
            reconcilingDeletedUpdateIds,
            cursor: page.cursor,
          };
        },
      );
      setFailedContinuation(undefined);
      setFailure(undefined);
    },
    onError: (caught, request) => {
      setFailedContinuation(request);
      setFailure(describeFailure(caught, 'load'));
    },
  });

  const postMutation = useMutation<PostActivityUpdateResult, unknown, PostVariables>({
    mutationKey: activityUpdateMutationKeys.post,
    onMutate: (variables) => {
      setPending((current) => [
        { localId: variables.localId, body: variables.body },
        ...current,
      ]);
    },
    onSuccess: (result) => {
      raisePlanActivityFloor(queryClient, activityId, result.lastActivityAt);
      queryClient.setQueryData<ActivityUpdatesCache>(
        queryKey,
        (current = initialCache(embedded)) => ({
          ...current,
          acknowledged: dedupe([result.update, ...current.acknowledged]),
        }),
      );
      setFailedPost(undefined);
      setFailure(undefined);
    },
    onError: (caught, variables) => {
      setFailedPost(variables);
      setFailure(describeFailure(caught, 'post'));
    },
    onSettled: (_data, _caught, variables) => {
      setPending((current) =>
        current.filter((entry) => entry.localId !== variables.localId),
      );
    },
  });

  const deleteMutation = useMutation<
    DeletedActivityUpdate,
    unknown,
    ActivityUpdateDeleteVariables,
    ActivityUpdatesCache | undefined
  >({
    mutationKey: activityUpdateMutationKeys.delete,
    onMutate: (variables: ActivityUpdateDeleteVariables) => {
      const update = feed.head
        .concat(feed.older, feed.acknowledged)
        .find((entry) => entry.updateId === variables.updateId);
      const snapshot = queryClient.getQueryData<ActivityUpdatesCache>(queryKey);
      if (update === undefined) return snapshot;
      queryClient.setQueryData<ActivityUpdatesCache>(
        queryKey,
        (current = initialCache(embedded)) => ({
          ...current,
          deletedUpdateIds: [...new Set([...current.deletedUpdateIds, update.updateId])],
        }),
      );
      return snapshot;
    },
    onSuccess: () => {
      setFailedDelete(undefined);
      setFailure(undefined);
    },
    onError: (caught, variables, snapshot) => {
      if (snapshot !== undefined) queryClient.setQueryData(queryKey, snapshot);
      const update = feed.head
        .concat(feed.older, feed.acknowledged)
        .find((entry) => entry.updateId === variables.updateId);
      setFailedDelete(update);
      setFailure(describeFailure(caught, 'delete'));
    },
  });

  const loadMore = useCallback(() => {
    if (feed.cursor === undefined || loadMoreMutation.isPending) return;
    loadMoreMutation.mutate({
      cursor: feed.cursor,
      headIdentity:
        feed.headIdentity ??
        headIdentity({ updates: feed.head, cursor: feed.headCursor }),
    });
  }, [feed.cursor, feed.head, feed.headCursor, feed.headIdentity, loadMoreMutation]);

  const post = useCallback(
    async (body: string): Promise<boolean> => {
      const trimmed = body.trim();
      if (trimmed === '' || postMutation.isPending) return false;
      const localId = randomUUID();
      try {
        await postMutation.mutateAsync({
          activityId,
          body: trimmed,
          localId,
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
        await deleteMutation.mutateAsync({ activityId, updateId: update.updateId });
        return true;
      } catch {
        return false;
      }
    },
    [activityId, deleteMutation],
  );

  const retryFailure = useCallback(async (): Promise<boolean> => {
    try {
      if (failure?.action === 'load' && failedContinuation !== undefined) {
        await loadMoreMutation.mutateAsync(failedContinuation);
        return true;
      }
      if (failure?.action === 'post' && failedPost !== undefined) {
        await postMutation.mutateAsync(failedPost);
        return true;
      }
      if (failure?.action === 'delete' && failedDelete !== undefined) {
        await deleteMutation.mutateAsync({
          activityId,
          updateId: failedDelete.updateId,
        });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [
    activityId,
    deleteMutation,
    failedContinuation,
    failedDelete,
    failedPost,
    failure?.action,
    loadMoreMutation,
    postMutation,
  ]);

  return {
    updates: materialize(feed),
    pending,
    cursor: feed.cursor,
    isLoadingMore: loadMoreMutation.isPending,
    isPosting: postMutation.isPending,
    loadMore,
    post,
    remove,
    errorMessage: failure?.message,
    errorRequestId: failure?.requestId,
    errorAction: failure?.action,
    retryFailure,
    dismissError: () => setFailure(undefined),
  };
}
