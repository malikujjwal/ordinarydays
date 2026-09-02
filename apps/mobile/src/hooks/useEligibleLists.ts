import { getLists } from '@od/shared/client';
import type { List } from '@od/shared/types';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { apiClient } from '@/lib/apiClient';
import { LISTS_KEY } from '@/lib/queryKeys';

type ListPage = Awaited<ReturnType<typeof getLists>>;

/**
 * Every list the viewer holds, for slot resolution (P3-12 on the client, P3-43).
 *
 * The same cache entry as the Lists tab (`LISTS_KEY`), so a list made moments ago in the
 * catalogue is already here. Unlike the tab, this drains every page: a destination question
 * has to see the whole shelf, and `MAX_OWNED_LISTS` bounds it to a few requests. With no
 * network the last persisted pages answer (§5.8: "the resolution runs against the cached
 * list index").
 */
export function useEligibleLists(enabled = true): {
  readonly lists: readonly List[];
  readonly status: 'pending' | 'success' | 'error';
  readonly complete: boolean;
} {
  const query = useInfiniteQuery({
    queryKey: LISTS_KEY,
    queryFn: ({ pageParam, signal }) => getLists(apiClient, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: ListPage) => page.meta.nextCursor ?? undefined,
    networkMode: 'offlineFirst',
    retry: false,
    enabled,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;

  useEffect(() => {
    if (enabled && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [enabled, hasNextPage, isFetchingNextPage, fetchNextPage]);

  return {
    lists: (query.data?.pages ?? []).flatMap((page) => page.data) as List[],
    status: query.status,
    complete: query.status === 'success' && !hasNextPage,
  };
}
