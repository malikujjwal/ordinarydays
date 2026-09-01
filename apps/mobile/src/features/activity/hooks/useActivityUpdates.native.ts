import type { ActivityUpdate } from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { describeApiFailure } from '@/lib/apiFailure';
import { getActiveNativeState, requireActiveNativeState } from '@/lib/sqlite/nativeState';
import type { ActivityUpdatesView, PendingUpdate } from './useActivityUpdates';

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

/**
 * Native P3-40 adapter. Confirmed entries, pending posts, delete masks, paging state, and the
 * Activity ordering timestamp are read from SQLite. Network transport belongs exclusively to
 * the serialized sync owner; an accepted hook action is already durable and may finish offline.
 */
export function useActivityUpdates(
  activityId: string,
  embedded: { updates: readonly ActivityUpdate[]; cursor: string | undefined },
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
  const [error, setError] = useState<string>();
  const liveActivity = useRef(activityId);

  if (liveActivity.current !== activityId) {
    liveActivity.current = activityId;
    setPage({
      updates: newestFirst(embedded.updates),
      cursor: embedded.cursor,
      pending: [],
    });
    setLoadingMore(false);
    setError(undefined);
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
    void readCommitted(activityId);
  }, [activityId, readCommitted, version]);

  const loadMore = useCallback(() => {
    const cursor = page.cursor;
    if (cursor === undefined || loadingMore) return;
    const requested = activityId;
    const pullUpdates = state.sync.pullActivityUpdates;
    if (pullUpdates === undefined) {
      setError("Couldn't load older updates.");
      return;
    }
    setLoadingMore(true);
    void pullUpdates
      .call(state.sync, requested)
      .then(async () => {
        await readCommitted(requested);
        if (isCurrent(requested)) setError(undefined);
      })
      .catch((caught: unknown) => {
        if (isCurrent(requested)) setError(describeFailure(caught));
      })
      .finally(() => {
        if (isCurrent(requested)) setLoadingMore(false);
      });
  }, [activityId, isCurrent, loadingMore, page.cursor, readCommitted, state]);

  const post = useCallback(
    async (body: string): Promise<boolean> => {
      const trimmed = body.trim();
      if (trimmed === '' || page.pending.length > 0) return false;
      try {
        const idempotencyKey = randomUUID();
        const result = await state.coordinator.postUpdate({
          activityId,
          body: trimmed,
          idempotencyKey,
        });
        if (result.kind === 'refused') {
          if (isCurrent(activityId)) setError(describeFailure(result.error));
          return false;
        }
        if (isCurrent(activityId)) setError(undefined);
        return result.kind === 'accepted';
      } catch (caught: unknown) {
        if (isCurrent(activityId)) setError(describeFailure(caught));
        return false;
      }
    },
    [activityId, isCurrent, page.pending.length, state],
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
          if (isCurrent(activityId)) setError(describeFailure(result.error));
          return false;
        }
        if (isCurrent(activityId)) setError(undefined);
        return result.kind === 'accepted';
      } catch (caught: unknown) {
        if (isCurrent(activityId)) setError(describeFailure(caught));
        return false;
      }
    },
    [activityId, isCurrent, state],
  );

  const dismissError = useCallback(() => setError(undefined), []);
  return {
    updates: page.updates,
    pending: page.pending,
    cursor: page.cursor,
    isLoadingMore: loadingMore,
    isPosting: page.pending.length > 0,
    loadMore,
    post,
    remove,
    errorMessage: error,
    dismissError,
  };
}
