import { ApiError, getMe, listActivities } from '@od/shared/client';
import type { TimeZone } from '@od/shared/time';
import type { ActivityListItem } from '@od/shared/types';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { ANYTIME_KEY } from './keys';

const ME_QUERY_KEY = ['me'] as const;
type ActivityListPage = Awaited<ReturnType<typeof listActivities>>;

function describe(error: unknown): { message: string; requestId?: string } {
  if (error instanceof ApiError) {
    if (error.status >= 500) {
      return { message: 'Something went wrong.', requestId: error.requestId };
    }
    return { message: error.message, requestId: error.requestId };
  }
  return { message: "Couldn't load this." };
}

/** The cursor-owned saved-task stage behind the pushed Anytime screen. */
export function useAnytime() {
  const me = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: ({ signal }) => getMe(apiClient, signal),
    enabled: false,
  });
  const query = useInfiniteQuery({
    queryKey: ANYTIME_KEY,
    queryFn: ({ pageParam, signal }) =>
      listActivities(
        apiClient,
        {
          filter: 'saved',
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: ActivityListPage) => page.meta.nextCursor,
    networkMode: 'always',
    retry: false,
  });
  const failure = query.error === null ? undefined : describe(query.error);

  return {
    status: query.status,
    items: (query.data?.pages ?? []).flatMap((page) => page.data) as ActivityListItem[],
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
