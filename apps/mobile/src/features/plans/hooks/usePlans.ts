import { ApiError, listActivities } from '@od/shared/client';
import type { ActivityFilter, ActivityListItem } from '@od/shared/types';
import { useInfiniteQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';

/**
 * The flat activity list behind the Plans tab (P1-23, reading P1-16).
 *
 * One filter, one GSI1 bucket, one cursor. The three-stage Plans tab with its
 * `SegmentedControl` — Needs a date · Upcoming · Past — is `GET /v1/plans` and Phase 3
 * (P3-14); this phase renders one stage flat, which is what P1-23 asks for.
 *
 * **Pages until the cursor is absent, not until a page is short.** `api-contract.md` §2.2a is
 * explicit: `type` narrows a page *after* the Query, so a full page can come back nearly empty
 * with `nextCursor` still set. `getNextPageParam` therefore reads the cursor and never the
 * length.
 */
export const plansKey = (filter: ActivityFilter) => ['activities', filter] as const;

/**
 * One page as the client returns it — the whole envelope.
 *
 * Derived from the function rather than imported: `listActivities` types its own return from
 * the response schema and exports no alias, and inferring it here keeps the two from drifting
 * if that schema gains a `meta` field.
 */
type ActivityListPage = Awaited<ReturnType<typeof listActivities>>;

export interface PlansView {
  status: 'pending' | 'success' | 'error';
  items: ActivityListItem[];
  /** `interaction-contract.md` §5.3 copy for the screen-level failure. */
  message?: string;
  requestId?: string;
  refetch: () => void;
  /** True while a further page is on the way — the list's foot skeleton (§5.1). */
  isLoadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
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

export function usePlans(filter: ActivityFilter): PlansView {
  const query = useInfiniteQuery({
    queryKey: plansKey(filter),
    queryFn: ({ pageParam, signal }) =>
      listActivities(
        apiClient,
        { filter, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    /**
     * The cursor lives in the **envelope's** `meta`, not beside the rows.
     *
     * `listActivities` (P1-20) returns `{ data, meta }` rather than unwrapping to `data` the
     * way the single-object reads do, precisely so a list caller can reach it — dropping
     * `meta` there would make paging impossible.
     */
    getNextPageParam: (page: ActivityListPage) => page.meta.nextCursor,
    /**
     * `always`, overriding the app-wide `offlineFirst`, for the reason written out in
     * `useHealth`: under `offlineFirst` a network-class failure pauses the query rather than
     * failing it, and `refetch()` is paused with it — so `Try again` would do nothing on
     * exactly the failure the user is looking at.
     */
    networkMode: 'always',
    // The transport already retries a 5xx three times with jittered backoff.
    retry: false,
  });

  const failure = query.error === null ? undefined : describe(query.error);

  return {
    status: query.status,
    /**
     * The rows, as the interface rather than as the schema's inference of it.
     *
     * The two describe the same shape — `packages/shared` pins them together — but differ by
     * `exactOptionalPropertyTypes`: the inferred optionals carry an explicit `| undefined`
     * that the hand-written interface does not. The single-object endpoints resolve this the
     * same way, with one assertion at the boundary (`response.data as Activity`), and doing
     * it here keeps every consumer speaking the interface.
     */
    items: (query.data?.pages ?? []).flatMap((page) => page.data) as ActivityListItem[],
    refetch: () => void query.refetch(),
    isLoadingMore: query.isFetchingNextPage,
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
