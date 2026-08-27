import { ApiError, getList, getListItems } from '@od/shared/client';
import type { List } from '@od/shared/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsOffline } from '@/hooks/usePendingIntents';
import { apiClient } from '@/lib/apiClient';
import type { ListItemRow } from '@/lib/sqlite/listItemsRepository';
import { mergeItemPages } from '../model/listDetail';

/**
 * One list's detail on **web**: online-first, page one from `GET /v1/lists/:id?includeItems`
 * and the rest from the items endpoint (P3-27).
 *
 * The native file beside this one reads the same shape out of SQLite. Metro resolves
 * `.native.ts` first, so the screen imports one name — the `useLists` pattern.
 *
 * ## Why the pages are held here rather than in an infinite query
 *
 * The `503` fence is not a retry. Its contract is "keep the committed projection, discard
 * **every** cursor, wait `Retry-After`, restart at page one, and install nothing until that
 * succeeds" — four statements about a projection an infinite query owns as one cache entry.
 * Refetching that entry replays the stale cursors the fence just invalidated; resetting it
 * throws away the rows the contract says to keep. So the pages live in this hook's own state
 * and only the individual requests go through the query client's transport.
 */
export interface ListDetailView {
  readonly status: 'pending' | 'success' | 'error';
  readonly list: List | undefined;
  readonly items: readonly ListItemRow[];
  /** META's count. The screen's empty-state and bulk rules read this, never `items.length`. */
  readonly itemCount: number;
  /** Every page has landed. */
  readonly complete: boolean;
  readonly isLoadingMore: boolean;
  readonly isOffline: boolean;
  readonly loadMore: () => void;
  readonly refetch: () => void;
  readonly message?: string;
  readonly requestId?: string;
}

interface Projection {
  readonly list: List | undefined;
  readonly items: readonly ListItemRow[];
  readonly nextCursor: string | undefined;
  readonly complete: boolean;
}

const EMPTY: Projection = {
  list: undefined,
  items: [],
  nextCursor: undefined,
  complete: false,
};

/** The fence's own default, for a `503` that arrives without a `Retry-After`. */
const DEFAULT_RETRY_AFTER_MS = 1_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isFence(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 503;
}

function describe(error: unknown): { message: string; requestId?: string } {
  if (error instanceof ApiError) {
    if (error.status >= 500) {
      return { message: 'Something went wrong.', requestId: error.requestId };
    }
    return { message: error.message, requestId: error.requestId };
  }
  return { message: "Couldn't load this." };
}

async function fetchFirstPage(listId: string): Promise<Projection> {
  const detail = await getList(apiClient, listId, { includeItems: true });
  return {
    list: detail.list as List,
    items: (detail.items ?? []).map((entry) => entry.item as ListItemRow),
    nextCursor: detail.nextCursor,
    complete: detail.nextCursor === undefined,
  };
}

export function useListDetail(listId: string): ListDetailView {
  const isOffline = useIsOffline();
  const [projection, setProjection] = useState<Projection>(EMPTY);
  const [status, setStatus] = useState<'pending' | 'success' | 'error'>('pending');
  const [failure, setFailure] = useState<{ message: string; requestId?: string }>();
  const [loadingMore, setLoadingMore] = useState(false);
  /** Drops a response whose request a newer restart has superseded. */
  const generation = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const restart = useCallback(
    async (afterMs = 0) => {
      const attempt = ++generation.current;
      if (afterMs > 0) await sleep(afterMs);
      try {
        const first = await fetchFirstPage(listId);
        if (!mounted.current || generation.current !== attempt) return;
        // Installed only now: nothing replaces the projection until page one succeeds.
        setProjection(first);
        setStatus('success');
        setFailure(undefined);
      } catch (error) {
        if (!mounted.current || generation.current !== attempt) return;
        if (isFence(error)) {
          void restart(
            error.retryAfterSeconds === undefined
              ? DEFAULT_RETRY_AFTER_MS
              : error.retryAfterSeconds * 1000,
          );
          return;
        }
        setFailure(describe(error));
        // Committed rows stay; only an empty projection becomes the error state (§5.3).
        setStatus((current) => (current === 'success' ? 'success' : 'error'));
      }
    },
    [listId],
  );

  useEffect(() => {
    setProjection(EMPTY);
    setStatus('pending');
    void restart();
  }, [restart]);

  const loadMore = useCallback(() => {
    const cursor = projection.nextCursor;
    if (cursor === undefined || loadingMore) return;
    const attempt = generation.current;
    setLoadingMore(true);
    void getListItems(apiClient, listId, cursor)
      .then((page) => {
        if (!mounted.current || generation.current !== attempt) return;
        setProjection((current) =>
          // The cursor may have been discarded by a fence while this page was in flight;
          // merging into a projection that no longer expects it is the forbidden splice.
          current.nextCursor !== cursor
            ? current
            : {
                ...current,
                items: mergeItemPages(current.items, page.data as ListItemRow[]),
                nextCursor: page.meta.nextCursor,
                complete: page.meta.nextCursor === undefined,
              },
        );
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        if (isFence(error)) {
          void restart(
            error.retryAfterSeconds === undefined
              ? DEFAULT_RETRY_AFTER_MS
              : error.retryAfterSeconds * 1000,
          );
          return;
        }
        setFailure(describe(error));
      })
      .finally(() => {
        if (mounted.current) setLoadingMore(false);
      });
  }, [listId, loadingMore, projection.nextCursor, restart]);

  return {
    status,
    list: projection.list,
    items: projection.items,
    itemCount: projection.list?.itemCount ?? 0,
    complete: projection.complete,
    isLoadingMore: loadingMore,
    isOffline,
    loadMore,
    refetch: () => void restart(),
    ...(failure === undefined
      ? {}
      : {
          message: failure.message,
          ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
        }),
  };
}
