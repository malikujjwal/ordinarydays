import { ApiError, getLists, getMe } from '@od/shared/client';
import type { Instant, TimeZone } from '@od/shared/time';
import type { ItemStateMode } from '@od/shared/types';
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

/** The list-index and Plan-picker projection shared by web responses and native SQLite. */
export interface ListIndexEntry {
  readonly listId: string;
  readonly ownerId: string;
  readonly title: string;
  readonly icon: string;
  readonly itemStateMode: ItemStateMode;
  readonly sourceActivityId?: string | undefined;
  readonly itemCount: number;
  readonly doneCount: number;
  readonly memberCount: number;
  readonly archived: boolean;
  readonly updatedAt: Instant;
  readonly lastItemActivityAt: Instant;
}

/** The shape both platforms return. Stated once so the two files cannot drift apart. */
export interface ListsView {
  readonly status: 'pending' | 'success' | 'error';
  /** Every pointer loaded so far, in server order, unfiltered. */
  readonly lists: readonly ListIndexEntry[];
  readonly timezone: TimeZone;
  readonly viewerUserId?: string;
  readonly refetch: () => void;
  /** True while another page is in flight — a drain must not stack requests. */
  readonly isLoadingMore: boolean;
  readonly isOffline: boolean;
  /** A cursor remains. `No lists yet` is illegal while this is true. */
  readonly hasMore: boolean;
  readonly loadMore: () => void;
  /** A later page failed while already-loaded rows remain usable. */
  readonly loadMoreFailure?: {
    readonly message: string;
    readonly requestId?: string;
    readonly retry: () => void;
  };
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
    enabled: true,
  });

  const query = useInfiniteQuery({
    queryKey: LISTS_KEY,
    queryFn: ({ pageParam, signal }) => getLists(apiClient, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: ListPage) => page.meta.nextCursor,
    networkMode: 'always',
    retry: false,
  });

  const pageFailure =
    query.isFetchNextPageError && query.error !== null
      ? describe(query.error)
      : undefined;
  const listFailure =
    query.error === null || query.isFetchNextPageError
      ? undefined
      : describe(query.error);
  const identityFailure = me.error === null ? undefined : describe(me.error);
  const failure = listFailure ?? identityFailure;
  const status =
    query.status === 'error' || me.status === 'error'
      ? 'error'
      : query.status === 'pending' || me.status === 'pending'
        ? 'pending'
        : 'success';

  return {
    status,
    // Pages concatenated in arrival order, which is the server's pointer order. No sort:
    // `ListIndex` stores no rank (ADR-042), so there is nothing a client order could be
    // faithful to, and §3.2 makes the index explicitly non-reorderable.
    lists: (query.data?.pages ?? []).flatMap((page) => page.data),
    timezone: (me.data?.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone) as TimeZone,
    ...(me.data?.userId === undefined ? {} : { viewerUserId: me.data.userId }),
    refetch: () => {
      void query.refetch();
      void me.refetch();
    },
    isLoadingMore: query.isFetchingNextPage,
    isOffline: query.fetchStatus === 'paused',
    hasMore: query.hasNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    ...(pageFailure === undefined
      ? {}
      : {
          loadMoreFailure: {
            message: pageFailure.message,
            ...(pageFailure.requestId === undefined
              ? {}
              : { requestId: pageFailure.requestId }),
            retry: () => void query.fetchNextPage(),
          },
        }),
    ...(failure === undefined
      ? {}
      : {
          message: failure.message,
          ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
        }),
  };
}
