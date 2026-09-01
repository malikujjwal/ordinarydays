import type { ActivityUpdate } from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { describeApiFailure } from '@/lib/apiFailure';
import { getActiveNativeState, requireActiveNativeState } from '@/lib/sqlite/nativeState';
import type {
  ActivityUpdatesFailure,
  ActivityUpdatesView,
  PendingUpdate,
} from './useActivityUpdates';

function describeFailure(
  error: unknown,
  action: ActivityUpdatesFailure['action'],
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

/**
 * Native P3-40 adapter. Confirmed entries, pending posts, delete masks, paging state, and the
 * Activity ordering timestamp are read from SQLite. Network transport belongs exclusively to
 * the serialized sync owner; an accepted hook action is already durable and may finish offline.
 */
export function useActivityUpdates(
  activityId: string,
  embedded: {
    updates: readonly ActivityUpdate[];
    cursor: string | undefined;
    revision?: number;
  },
): ActivityUpdatesView {
  const state = requireActiveNativeState();
  const version = useSyncExternalStore(
    (listener) => state.activities.subscribeUpdates(activityId, listener),
    () => state.activities.updatesVersion(activityId),
    () => 0,
  );
  const [page, setPage] = useState<{
    updates: readonly ActivityUpdate[];
    cursor: string | undefined;
    pending: readonly PendingUpdate[];
  }>(() => ({
    updates: newestFirst(embedded.updates),
    cursor: embedded.cursor,
    pending: [],
  }));
  const [loadingMore, setLoadingMore] = useState(false);
  /** True only while the local transaction is accepting a post, not while its intent is queued. */
  const [posting, setPosting] = useState(false);
  const [failure, setFailure] = useState<ActivityUpdatesFailure>();
  const [failedPost, setFailedPost] = useState<{
    readonly activityId: string;
    readonly body: string;
    readonly idempotencyKey: string;
  }>();
  const [failedDelete, setFailedDelete] = useState<ActivityUpdate>();
  const liveActivity = useRef(activityId);

  if (liveActivity.current !== activityId) {
    liveActivity.current = activityId;
    setPage({
      updates: newestFirst(embedded.updates),
      cursor: embedded.cursor,
      pending: [],
    });
    setLoadingMore(false);
    setPosting(false);
    setFailedPost(undefined);
    setFailure(undefined);
  }

  const isCurrent = useCallback(
    (requested: string) =>
      liveActivity.current === requested && getActiveNativeState() === state,
    [state],
  );

  const readCommitted = useCallback(
    async (requested: string) => {
      const committed = await state.activities.readUpdatesProjection(requested);
      if (isCurrent(requested)) {
        setPage({
          updates: committed.updates,
          cursor: committed.cursor,
          pending: committed.pending,
        });
      }
      return committed;
    },
    [isCurrent, state],
  );

  useEffect(() => {
    // Reading the subscription revision makes each committed repository publication reload.
    void version;
    void readCommitted(activityId).catch((caught: unknown) => {
      if (isCurrent(activityId)) setFailure(describeFailure(caught, 'load'));
    });
  }, [activityId, isCurrent, readCommitted, version]);

  const loadMore = useCallback(() => {
    const cursor = page.cursor;
    if (cursor === undefined || loadingMore) return;
    const requested = activityId;
    const pullUpdates = state.sync.pullActivityUpdates;
    if (pullUpdates === undefined) {
      setFailure({ action: 'load', message: "Couldn't load older updates." });
      return;
    }
    setLoadingMore(true);
    void pullUpdates
      .call(state.sync, requested)
      .then(async () => {
        await readCommitted(requested);
        if (isCurrent(requested)) setFailure(undefined);
      })
      .catch((caught: unknown) => {
        if (isCurrent(requested)) setFailure(describeFailure(caught, 'load'));
      })
      .finally(() => {
        if (isCurrent(requested)) setLoadingMore(false);
      });
  }, [activityId, isCurrent, loadingMore, page.cursor, readCommitted, state]);

  const attemptPost = useCallback(
    async (variables: {
      readonly activityId: string;
      readonly body: string;
      readonly idempotencyKey: string;
    }): Promise<boolean> => {
      setPosting(true);
      try {
        const result = await state.coordinator.postUpdate({
          activityId: variables.activityId,
          body: variables.body,
          idempotencyKey: variables.idempotencyKey,
        });
        if (result.kind === 'refused') {
          if (isCurrent(variables.activityId)) {
            setFailedPost(variables);
            setFailure(describeFailure(result.error, 'post'));
          }
          return false;
        }
        if (isCurrent(variables.activityId)) {
          setFailedPost(undefined);
          setFailure(undefined);
        }
        return result.kind === 'accepted';
      } catch (caught: unknown) {
        if (isCurrent(variables.activityId)) {
          setFailedPost(variables);
          setFailure(describeFailure(caught, 'post'));
        }
        return false;
      } finally {
        if (isCurrent(variables.activityId)) setPosting(false);
      }
    },
    [isCurrent, state],
  );

  const post = useCallback(
    async (body: string): Promise<boolean> => {
      const trimmed = body.trim();
      if (trimmed === '' || posting) return false;
      return attemptPost({ activityId, body: trimmed, idempotencyKey: randomUUID() });
    },
    [activityId, attemptPost, posting],
  );

  const remove = useCallback(
    async (update: ActivityUpdate): Promise<boolean> => {
      if (update.kind !== 'user') return false;
      try {
        const result = await state.coordinator.deleteUpdate({
          activityId,
          updateId: update.updateId,
          intentId: randomUUID(),
        });
        if (result.kind === 'refused') {
          if (isCurrent(activityId)) {
            setFailedDelete(update);
            setFailure(describeFailure(result.error, 'delete'));
          }
          return false;
        }
        if (isCurrent(activityId)) {
          setFailedDelete(undefined);
          setFailure(undefined);
        }
        return result.kind === 'accepted';
      } catch (caught: unknown) {
        if (isCurrent(activityId)) {
          setFailedDelete(update);
          setFailure(describeFailure(caught, 'delete'));
        }
        return false;
      }
    },
    [activityId, isCurrent, state],
  );

  const retryFailure = useCallback(async (): Promise<boolean> => {
    if (failure?.action === 'load') {
      loadMore();
      return true;
    }
    if (failure?.action === 'post' && failedPost !== undefined) {
      return attemptPost(failedPost);
    }
    if (failure?.action === 'delete' && failedDelete !== undefined) {
      return remove(failedDelete);
    }
    return false;
  }, [attemptPost, failedDelete, failedPost, failure?.action, loadMore, remove]);
  const dismissError = useCallback(() => setFailure(undefined), []);
  return {
    updates: page.updates,
    pending: page.pending,
    cursor: page.cursor,
    isLoadingMore: loadingMore,
    isPosting: posting,
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
