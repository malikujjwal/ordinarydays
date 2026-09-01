import {
  deleteActivityUpdate,
  getActivityUpdates,
  postActivityUpdate,
} from '@od/shared/client';
import type { ActivityUpdate } from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { apiClient } from '@/lib/apiClient';
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
 * Native P3-40 adapter. Confirmed entries, paging state, and the Activity ordering timestamp
 * are read from SQLite; hook state contains only transient presentation such as the pending
 * composer row and an optimistic delete mask.
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
  const [page, setPage] = useState(() => ({
    updates: newestFirst(embedded.updates),
    cursor: embedded.cursor,
  }));
  const [pending, setPending] = useState<readonly PendingUpdate[]>([]);
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const liveActivity = useRef(activityId);

  if (liveActivity.current !== activityId) {
    liveActivity.current = activityId;
    setPage({ updates: newestFirst(embedded.updates), cursor: embedded.cursor });
    setPending([]);
    setDeleted(new Set());
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
      const committed = await state.activities.readUpdates(requested);
      if (isCurrent(requested)) {
        setPage({ updates: committed.updates, cursor: committed.cursor });
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

  const updates = useMemo(
    () => page.updates.filter((entry) => !deleted.has(entry.updateId)),
    [deleted, page.updates],
  );

  const loadMore = useCallback(() => {
    const cursor = page.cursor;
    if (cursor === undefined || loadingMore) return;
    const requested = activityId;
    setLoadingMore(true);
    void getActivityUpdates(apiClient, requested, cursor)
      .then(async (response) => {
        if (getActiveNativeState() !== state) return;
        await state.account.transactions.run((transaction) =>
          state.activities.installUpdatePage(transaction, requested, response),
        );
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
      if (trimmed === '' || pending.length > 0) return false;
      const requested = activityId;
      const localId = randomUUID();
      setPending((current) => [{ localId, body: trimmed }, ...current]);
      try {
        const result = await postActivityUpdate(
          apiClient,
          requested,
          trimmed,
          randomUUID(),
        );
        if (getActiveNativeState() !== state) return false;
        await state.account.transactions.run((transaction) =>
          state.activities.installConfirmedUpdate(transaction, result),
        );
        await readCommitted(requested);
        if (isCurrent(requested)) setError(undefined);
        // Reconcile after the durable acknowledgement. A stale response is safe because the
        // repository clamps `last_activity_at` and preserves the confirmed feed row.
        void state.sync
          .pullActivity({ kind: 'activity', activityId: requested })
          .catch(() => undefined);
        return true;
      } catch (caught) {
        if (isCurrent(requested)) setError(describeFailure(caught));
        return false;
      } finally {
        if (isCurrent(requested)) {
          setPending((current) => current.filter((entry) => entry.localId !== localId));
        }
      }
    },
    [activityId, isCurrent, pending.length, readCommitted, state],
  );

  const remove = useCallback(
    async (update: ActivityUpdate): Promise<boolean> => {
      if (update.kind !== 'user') return false;
      const requested = activityId;
      setDeleted((current) => new Set(current).add(update.updateId));
      try {
        await deleteActivityUpdate(apiClient, requested, update.updateId);
        if (getActiveNativeState() !== state) return false;
        await state.account.transactions.run((transaction) =>
          state.activities.deleteConfirmedUpdate(transaction, requested, update.updateId),
        );
        await readCommitted(requested);
        if (isCurrent(requested)) {
          setDeleted((current) => {
            const next = new Set(current);
            next.delete(update.updateId);
            return next;
          });
          setError(undefined);
        }
        return true;
      } catch (caught) {
        if (isCurrent(requested)) {
          setDeleted((current) => {
            const next = new Set(current);
            next.delete(update.updateId);
            return next;
          });
          setError(describeFailure(caught));
        }
        return false;
      }
    },
    [activityId, isCurrent, readCommitted, state],
  );

  const dismissError = useCallback(() => setError(undefined), []);
  return {
    updates,
    pending,
    cursor: page.cursor,
    isLoadingMore: loadingMore,
    isPosting: pending.length > 0,
    loadMore,
    post,
    remove,
    errorMessage: error,
    dismissError,
  };
}
