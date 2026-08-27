import { ApiError, getLists, getMe } from '@od/shared/client';
import type { TimeZone } from '@od/shared/time';
import type { List } from '@od/shared/types';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { LISTS_KEY } from './keys';

/**
 * The Lists index on **web**: online-first TanStack over `GET /v1/lists` pages.
 *
 * The native file beside this one materializes the same pages into SQLite and reads them back
 * through repository subscriptions (ADR-057). Metro resolves `.native.ts` first, so the two are
 * one import at every call site and neither knows the other exists — the `useAnytime` pattern,
 * unchanged.
 *
 * ## What this hook does not decide
 *
 * It returns **every** materialized pointer, active and archived together, and says whether a
 * cursor remains. Filtering, the archived group and the drain decision belong to the screen and
 * to `model/indexDrain.ts`, because they are the same rules on both platforms and a hook that
 * pre-filtered would have to be written twice and agree with itself.
 */

const ME_QUERY_KEY = ['me'] as const;
type ListPage = Awaited<ReturnType<typeof getLists>>;

/** The shape both platforms return. Stated once so the two files cannot drift apart. */
export interface ListsView {
  readonly status: 'pending' | 'success' | 'error';
  /** Every pointer loaded so far, in server order, unfiltered. */
  readonly lists: readonly List[];
  readonly timezone: TimeZone;
  readonly refetch: () => void;
  /** True while another page is in flight — a drain must not stack requests. */
  readonly isLoadingMore: boolean;
  readonly isOffline: boolean;
  /** A cursor remains. `No lists yet` is illegal while this is true. */
  readonly hasMore: boolean;
  readonly loadMore: () => void;
  readonly message?: string;
  readonly requestId?: string;
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

export function useLists(): ListsView {
  const me = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: ({ signal }) => getMe(apiClient, signal),
    enabled: false,
  });

  const query = useInfiniteQuery({
    queryKey: LISTS_KEY,
    queryFn: ({ pageParam, signal }) => getLists(apiClient, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: ListPage) => page.meta.nextCursor,
    networkMode: 'always',
    retry: false,
  });

  const failure = query.error === null ? undefined : describe(query.error);

  return {
    status: query.status,
    // Pages concatenated in arrival order, which is the server's pointer order. No sort:
    // `ListIndex` stores no rank (ADR-042), so there is nothing a client order could be
    // faithful to, and §3.2 makes the index explicitly non-reorderable.
    lists: (query.data?.pages ?? []).flatMap((page) => page.data) as List[],
    timezone: (me.data?.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone) as TimeZone,
    refetch: () => void query.refetch(),
    isLoadingMore: query.isFetchingNextPage,
    isOffline: query.fetchStatus === 'paused',
    hasMore: query.hasNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    ...(failure === undefined
      ? {}
      : {
          message: failure.message,
          ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
        }),
  };
}
