import { QueryClient } from '@tanstack/react-query';

/**
 * Native TanStack client for non-domain queries only.
 *
 * Activity/Agenda reads, writes, durability, pending state, and reconciliation are owned by
 * the account SQLite session. Keeping this factory separate prevents web MutationCache
 * defaults and projection callbacks from entering the native runtime bundle.
 */
export function createOfflineQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 7 * 24 * 60 * 60 * 1000,
        networkMode: 'offlineFirst',
        retry: false,
      },
      mutations: { networkMode: 'offlineFirst', retry: false },
    },
  });
}

export const queryClient = createOfflineQueryClient();
