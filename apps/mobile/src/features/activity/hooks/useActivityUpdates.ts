import {
  deleteActivityUpdate,
  getActivityUpdates,
  postActivityUpdate,
} from '@od/shared/client';
import type { ActivityUpdate } from '@od/shared/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useCallback, useMemo, useState } from 'react';
import { raisePlanActivityFloor } from '@/features/agenda/hooks/usePlanActivityFloors';
import { apiClient } from '@/lib/apiClient';
import { describeApiFailure } from '@/lib/apiFailure';
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
  readonly dismissError: () => void;
}

const describeFailure = (error: unknown) =>
  describeApiFailure(error, "Couldn't save this.").message;

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
  readonly updates: readonly ActivityUpdate[];
  readonly cursor: string | undefined;
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
  const [error, setError] = useState<string>();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => activityUpdatesKey(activityId), [activityId]);
  const feed = useQuery({
    queryKey,
    queryFn: () => Promise.resolve<ActivityUpdatesCache>(embedded),
    initialData: embedded,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  }).data;

  const loadMoreMutation = useMutation({
    mutationFn: (cursor: string) => getActivityUpdates(apiClient, activityId, cursor),
    retry: 2,
    onSuccess: (page) => {
      queryClient.setQueryData<ActivityUpdatesCache>(queryKey, (current = embedded) => ({
        updates: newestFirst(dedupe([...current.updates, ...page.updates])),
        cursor: page.cursor,
      }));
      setError(undefined);
    },
    onError: (caught) => setError(describeFailure(caught)),
  });

  const postMutation = useMutation({
    mutationFn: (variables: PostVariables) =>
      postActivityUpdate(apiClient, activityId, variables.body, variables.idempotencyKey),
    retry: 2,
    onMutate: (variables) => {
      setPending((current) => [
        { localId: variables.localId, body: variables.body },
        ...current,
      ]);
    },
    onSuccess: (result) => {
      raisePlanActivityFloor(queryClient, activityId, result.lastActivityAt);
      queryClient.setQueryData<ActivityUpdatesCache>(queryKey, (current = embedded) => ({
        ...current,
        updates: newestFirst(dedupe([result.update, ...current.updates])),
      }));
      setError(undefined);
    },
    onError: (caught) => setError(describeFailure(caught)),
    onSettled: (_data, _caught, variables) => {
      setPending((current) =>
        current.filter((entry) => entry.localId !== variables.localId),
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (update: ActivityUpdate) =>
      deleteActivityUpdate(apiClient, activityId, update.updateId),
    retry: 2,
    onMutate: (update) => {
      const snapshot = queryClient.getQueryData<ActivityUpdatesCache>(queryKey);
      queryClient.setQueryData<ActivityUpdatesCache>(queryKey, (current = embedded) => ({
        ...current,
        updates: current.updates.filter((entry) => entry.updateId !== update.updateId),
      }));
      return snapshot;
    },
    onSuccess: () => setError(undefined),
    onError: (caught, _update, snapshot) => {
      if (snapshot !== undefined) queryClient.setQueryData(queryKey, snapshot);
      setError(describeFailure(caught));
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

  return {
    updates: newestFirst(feed.updates),
    pending,
    cursor: feed.cursor,
    isLoadingMore: loadMoreMutation.isPending,
    isPosting: postMutation.isPending,
    loadMore,
    post,
    remove,
    errorMessage: error,
    dismissError: () => setError(undefined),
  };
}
