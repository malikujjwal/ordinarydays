import { getMe } from '@od/shared/client';
import type { User } from '@od/shared/types';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';

/** The one cache entry every screen shares for the signed-in user (`GET /v1/me`). */
export const ME_QUERY_KEY = ['me'] as const;

/**
 * Who is looking (P3-42). The tabs already fill `['me']` as a side effect of their own
 * reads; a route reached directly — a plan opened from a link, or a cold start on detail —
 * has nothing there, so this makes the read explicit where a screen needs to tell the owner
 * from anyone else. Held indefinitely: the user does not change under the app.
 */
export function useViewer(enabled = true): User | undefined {
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: ({ signal }) => getMe(apiClient, signal),
    staleTime: Number.POSITIVE_INFINITY,
    enabled,
  }).data;
}
