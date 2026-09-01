import {
  deleteActivityUpdate,
  getActivityUpdates,
  postActivityUpdate,
} from '@od/shared/client';
import type { ActivityUpdate } from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import { useCallback, useMemo, useRef, useState } from 'react';
import { apiClient } from '@/lib/apiClient';
import { usePlanActivityFloor } from '@/stores/planActivityFloor';

/**
 * The plan's Updates feed (P3-40, `plans-and-lists.md` §2.1 row 9).
 *
 * Seeded from the page the detail response **embeds** — opening a plan issues no second
 * request (P3-37's one-request rule) — and continued through `GET .../updates?cursor=` only
 * when the user reveals more. Like `usePlans`, this speaks HTTP on both platforms: the feed
 * has no SQLite projection (ADR-057 covers the agenda), so posting and deleting are
 * online-first everywhere.
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

function describeFailure(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  ) {
    const api = error as { status: number; message: string };
    return api.status >= 500 ? 'Something went wrong.' : api.message;
  }
  return "Couldn't save this.";
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

export function useActivityUpdates(
  activityId: string,
  embedded: { updates: readonly ActivityUpdate[]; cursor: string | undefined },
): ActivityUpdatesView {
  /**
   * Entries the user's own actions produced since the seed: posted rows (canonical, from the
   * response) and deleted ids. Kept **apart** from the embedded page so a detail refetch —
   * which replaces `embedded` wholesale — reconciles rather than resurrects: the merged view
   * below always reflects both the freshest server page and every local action.
   */
  const [posted, setPosted] = useState<readonly ActivityUpdate[]>([]);
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set());
  const [older, setOlder] = useState<readonly ActivityUpdate[]>([]);
  const [pending, setPending] = useState<readonly PendingUpdate[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(embedded.cursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string>();
  const raiseFloor = usePlanActivityFloor((state) => state.raise);

  /** A refetched detail carries a fresh first page; older pages hang off its cursor. */
  const seededCursor = useRef(embedded.cursor);
  if (seededCursor.current !== embedded.cursor) {
    seededCursor.current = embedded.cursor;
    setCursor(embedded.cursor);
    setOlder([]);
  }

  const updates = useMemo(
    () =>
      newestFirst(
        dedupe([...posted, ...embedded.updates, ...older]).filter(
          (entry) => !deleted.has(entry.updateId),
        ),
      ),
    [posted, embedded.updates, older, deleted],
  );

  const loadMore = useCallback(() => {
    if (cursor === undefined || loadingMore) return;
    setLoadingMore(true);
    getActivityUpdates(apiClient, activityId, cursor)
      .then((page) => {
        setOlder((current) => [...current, ...page.updates]);
        setCursor(page.cursor);
      })
      .catch((caught: unknown) => setError(describeFailure(caught)))
      .finally(() => setLoadingMore(false));
  }, [activityId, cursor, loadingMore]);

  const post = useCallback(
    async (body: string): Promise<boolean> => {
      const trimmed = body.trim();
      if (trimmed === '' || posting) return false;
      const localId = randomUUID();
      setPending((current) => [{ localId, body: trimmed }, ...current]);
      setPosting(true);
      try {
        const result = await postActivityUpdate(
          apiClient,
          activityId,
          trimmed,
          randomUUID(),
        );
        setPosted((current) => [result.update, ...current]);
        raiseFloor(activityId, result.lastActivityAt);
        return true;
      } catch (caught) {
        setError(describeFailure(caught));
        return false;
      } finally {
        setPending((current) => current.filter((entry) => entry.localId !== localId));
        setPosting(false);
      }
    },
    [activityId, posting, raiseFloor],
  );

  const remove = useCallback(
    async (update: ActivityUpdate): Promise<boolean> => {
      // The affordance never exists on a system entry; this guard makes the rule hold even
      // for a caller that bypassed the row.
      if (update.kind !== 'user') return false;
      setDeleted((current) => new Set(current).add(update.updateId));
      try {
        await deleteActivityUpdate(apiClient, activityId, update.updateId);
        return true;
      } catch (caught) {
        setDeleted((current) => {
          const next = new Set(current);
          next.delete(update.updateId);
          return next;
        });
        setError(describeFailure(caught));
        return false;
      }
    },
    [activityId],
  );

  return {
    updates,
    pending,
    cursor,
    isLoadingMore: loadingMore,
    isPosting: posting,
    loadMore,
    post,
    remove,
    errorMessage: error,
    dismissError: () => setError(undefined),
  };
}
