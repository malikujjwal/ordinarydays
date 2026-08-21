import { MutationCache, QueryClient } from '@tanstack/react-query';
import {
  isRecurrenceEditMutation,
  projectActivityWrite,
  reconcileRecurrenceEdit,
} from '@/lib/agendaCache';
import {
  changesActivityLists,
  refreshActivityDetails,
  refreshActivityLists,
  registerActivityMutationDefaults,
} from '@/lib/mutationDefaults';
import { useSyncStatus } from '@/stores/syncStatus';

/**
 * Builds the online-first web QueryClient.
 *
 * Web keeps TanStack as its Activity/Agenda adapter and has no durable mutation queue. The
 * HTTP transport owns retry; this cache owns only request state, optimistic projection, and
 * reconciliation. Native resolves `queryClient.native.ts`, whose client is limited to
 * non-domain queries such as the signed-in profile.
 */
export function createOfflineQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, variables, _context, mutation) => {
        useSyncStatus
          .getState()
          .captureMutationError(error, mutation.options.mutationKey, variables);
      },
      /**
       * Process-wide web projection/reconciliation outlives a component that closes after a
       * successful save. Native commits these same decisions inside SQLite transactions.
       */
      onSuccess: (data, variables, _context, mutation): Promise<void> | undefined => {
        const { mutationKey } = mutation.options;
        refreshActivityDetails(client, mutationKey, variables);
        if (!changesActivityLists(mutationKey)) return;
        projectActivityWrite(client, mutationKey, data, variables);
        let recurrenceReconciliation: Promise<void> | undefined;
        if (isRecurrenceEditMutation(mutationKey, variables)) {
          const activityId = entityIdFrom(variables);
          const version = activityVersionFrom(data);
          if (activityId !== undefined && version !== undefined) {
            recurrenceReconciliation = reconcileRecurrenceEdit(
              client,
              activityId,
              version,
            ).then(() => undefined);
          }
        }
        refreshActivityLists(client);
        return recurrenceReconciliation;
      },
    }),
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

  registerActivityMutationDefaults(client);
  return client;
}

/** One web client for one app process; tests use the factory for isolated clients. */
export const queryClient = createOfflineQueryClient();

function entityIdFrom(variables: unknown): string | undefined {
  const fields = variables as
    | {
        readonly activityId?: unknown;
        readonly input?: { readonly activityId?: unknown };
      }
    | undefined;
  if (typeof fields?.activityId === 'string') return fields.activityId;
  return typeof fields?.input?.activityId === 'string'
    ? fields.input.activityId
    : undefined;
}

function activityVersionFrom(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const candidate = 'activity' in data ? (data as { activity: unknown }).activity : data;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const version = (candidate as { updatedAt?: unknown }).updatedAt;
  return typeof version === 'string' ? version : undefined;
}
