import {
  deleteActivityUpdate,
  getActivityUpdates,
  postActivityUpdate,
} from '@od/shared/client';
import type { ActivityUpdate } from '@od/shared/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '@/lib/apiClient';
import { describeApiFailure } from '@/lib/apiFailure';
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
  readonly retryFailure: () => void;
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
  /** Cursor that arrived with `head`, used to detect a newer embedded projection. */
  readonly headCursor: string | undefined;
  readonly cursor: string | undefined;
}

function initialCache(embedded: {
  updates: readonly ActivityUpdate[];
  cursor: string | undefined;
}): ActivityUpdatesCache {
  return {
    head: embedded.updates,
    older: [],
    acknowledged: [],
    deletedUpdateIds: [],
    headCursor: embedded.cursor,
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
  embedded: { updates: readonly ActivityUpdate[]; cursor: string | undefined },
): ActivityUpdatesCache {
  if (current.head === embedded.updates && current.headCursor === embedded.cursor) {
    return current;
  }
  const embeddedIds = new Set(embedded.updates.map((entry) => entry.updateId));
  return {
    ...current,
    head: embedded.updates,
    acknowledged: current.acknowledged.filter(
      (entry) => !embeddedIds.has(entry.updateId),
    ),
    headCursor: embedded.cursor,
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

interface PostVariables {
  readonly body: string;
  readonly localId: string;
  readonly idempotencyKey: string;
}

export function useActivityUpdates(
  activityId: string,
  embedded: { updates: readonly ActivityUpdate[]; cursor: string | undefined },
): ActivityUpdatesView {
  const [pending, setPending] = useState<readonly PendingUpdate[]>([]);
  const [failure, setFailure] = useState<ActivityUpdatesFailure>();
  const [failedDelete, setFailedDelete] = useState<ActivityUpdate>();
  const [failedCursor, setFailedCursor] = useState<string>();
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
    if (feed !== cached) queryClient.setQueryData(queryKey, feed);
  }, [cached, feed, queryClient, queryKey]);

  const loadMoreMutation = useMutation({
    mutationFn: (cursor: string) => getActivityUpdates(apiClient, activityId, cursor),
    onSuccess: (page) => {
      queryClient.setQueryData<ActivityUpdatesCache>(
        queryKey,
        (current = initialCache(embedded)) => ({
          ...current,
          older: dedupe([...current.older, ...page.updates]),
          cursor: page.cursor,
        }),
      );
      setFailedCursor(undefined);
      setFailure(undefined);
    },
    onError: (caught, cursor) => {
      setFailedCursor(cursor);
      setFailure(describeFailure(caught, 'load'));
    },
  });

  const postMutation = useMutation({
    mutationFn: (variables: PostVariables) =>
      postActivityUpdate(apiClient, activityId, variables.body, variables.idempotencyKey),
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
      setFailure(undefined);
    },
    onError: (caught) => setFailure(describeFailure(caught, 'post')),
    onSettled: (_data, _caught, variables) => {
      setPending((current) =>
        current.filter((entry) => entry.localId !== variables.localId),
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (update: ActivityUpdate) =>
      deleteActivityUpdate(apiClient, activityId, update.updateId),
    onMutate: (update) => {
      const snapshot = queryClient.getQueryData<ActivityUpdatesCache>(queryKey);
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
    onError: (caught, update, snapshot) => {
      if (snapshot !== undefined) queryClient.setQueryData(queryKey, snapshot);
      setFailedDelete(update);
      setFailure(describeFailure(caught, 'delete'));
    },
  });

  const loadMore = useCallback(() => {
    if (feed.cursor === undefined || loadMoreMutation.isPending) return;
    loadMoreMutation.mutate(feed.cursor);
  }, [feed.cursor, loadMoreMutation]);

  const post = useCallback(
    async (body: string): Promise<boolean> => {
      const trimmed = body.trim();
      if (trimmed === '' || postMutation.isPending) return false;
      const localId = randomUUID();
      try {
        await postMutation.mutateAsync({
          body: trimmed,
          localId,
          idempotencyKey: randomUUID(),
        });
        return true;
      } catch {
        return false;
      }
    },
    [postMutation],
  );

  const remove = useCallback(
    async (update: ActivityUpdate): Promise<boolean> => {
      // The affordance never exists on a system entry; this guard makes the rule hold even
      // for a caller that bypassed the row.
      if (update.kind !== 'user') return false;
      try {
        await deleteMutation.mutateAsync(update);
        return true;
      } catch {
        return false;
      }
    },
    [deleteMutation],
  );

  const retryFailure = useCallback(() => {
    if (failure?.action === 'load' && failedCursor !== undefined) {
      loadMoreMutation.mutate(failedCursor);
    } else if (failure?.action === 'delete' && failedDelete !== undefined) {
      deleteMutation.mutate(failedDelete);
    }
  }, [deleteMutation, failedCursor, failedDelete, failure?.action, loadMoreMutation]);

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
