import { QueryClient } from '@tanstack/react-query';

/**
 * The single `QueryClient`, with the defaults from `tech-stack.md` §3.4.
 *
 * Module scope, not `useState`: one client per app run. Creating it inside a component
 * makes a remount drop the whole cache, which on web means every navigation refetches.
 *
 * **Persistence is Phase 2 (P2-33).** These defaults describe a cache that survives a cold
 * start; nothing here makes it do so yet, so in Phase 0 the seven-day `gcTime` only spans
 * one session. The values are set now so the persister is added to a client that already
 * expects to outlive the process.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Matches the API's 60-second client-cache guidance, so a screen that remounts
      // during a normal interaction does not refetch.
      staleTime: 60_000,
      // A week of offline history, per §3.4. Only meaningful once P2-33 persists it.
      gcTime: 7 * 24 * 60 * 60 * 1000,
      /**
       * `offlineFirst`, not the `online` default: a query fires from cache and does not sit
       * in `paused` waiting for a connectivity signal. The app must be usable on a subway,
       * and the default turns "show me what you had" into a spinner.
       */
      networkMode: 'offlineFirst',
      // §3.4's retry predicate needs `isRetryable`, which arrives with the typed client in
      // P0-20. Until then the library default (3 attempts) applies, which is the same
      // count without the error-class check.
    },
    mutations: { networkMode: 'offlineFirst', retry: 3 },
  },
});
