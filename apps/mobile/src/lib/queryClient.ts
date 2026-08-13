import { MAX_OFFLINE_MUTATIONS } from '@od/shared';
import { MutationCache, QueryClient } from '@tanstack/react-query';
import { Platform } from 'react-native';
import { projectActivityWrite } from '@/lib/agendaCache';
import {
  changesActivityLists,
  refreshActivityLists,
  registerActivityMutationDefaults,
} from '@/lib/mutationDefaults';
import { OFFLINE_QUEUE_FULL_MESSAGE, useSyncStatus } from '@/stores/syncStatus';

/**
 * Builds the client with the offline defaults from `tech-stack.md` section 3.4.
 *
 * The transport is the only retry layer. Its initial attempt plus three retries already
 * permits four HTTP attempts. Wrapping that in TanStack's initial attempt plus three retries
 * multiplies the same logical operation to as many as 16 HTTP attempts, so both Query and
 * Mutation retries are disabled here.
 */
export function createOfflineQueryClient(platform = Platform.OS): QueryClient {
  const client = new QueryClient({
    mutationCache: new MutationCache({
      onMutate: () => {
        if (platform !== 'ios') return;
        const pending = client
          .getMutationCache()
          .getAll()
          .filter((candidate) => candidate.state.status === 'pending').length;
        if (pending <= MAX_OFFLINE_MUTATIONS) return;

        useSyncStatus.getState().showQueueFull();
        throw new Error(OFFLINE_QUEUE_FULL_MESSAGE);
      },
      onError: (error, variables, _context, mutation) => {
        useSyncStatus
          .getState()
          .captureMutationError(error, mutation.options.mutationKey, variables);
      },
      /**
       * The single place a successful activity write reaches the lists and agenda windows it
       * changed (P2-46).
       *
       * It has to be here rather than on the mutations because a component's `onSuccess` dies
       * with its component, and the two writes that most need this close their own surface on
       * success — compose unmounts on save, the reschedule sheet unmounts when it closes. The
       * cache outlives both, and also covers mutations replayed from the offline queue after a
       * restart, which never had a component to begin with.
       *
       * **Project first, then invalidate, and in that order.** The agenda is read from an
       * eventually-consistent index, so the refetch an invalidation triggers can legitimately
       * return pre-write data and cache it. Writing the server's own response into the cache
       * is what makes the change visible; the invalidation behind it is reconciliation.
       */
      onSuccess: (data, _variables, _context, mutation) => {
        const { mutationKey } = mutation.options;
        if (!changesActivityLists(mutationKey)) return;
        projectActivityWrite(client, mutationKey, data);
        refreshActivityLists(client);
      },
    }),
    defaultOptions: {
      queries: {
        // A normal remount stays fresh for a minute; offline history remains for one week.
        staleTime: 60_000,
        gcTime: 7 * 24 * 60 * 60 * 1000,
        // Cached data renders while a refresh waits for connectivity.
        networkMode: 'offlineFirst',
        retry: false,
      },
      mutations: { networkMode: 'offlineFirst', retry: false },
    },
  });

  // A restored mutation has no component closure. Defaults must exist before hydration.
  registerActivityMutationDefaults(client);
  return client;
}

/** One client for one app process; tests create isolated clients through the factory above. */
export const queryClient = createOfflineQueryClient();
