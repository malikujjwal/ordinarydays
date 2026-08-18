import { MutationCache, QueryClient } from '@tanstack/react-query';
import {
  clearRecurrenceEditProtection,
  isRecurrenceEditMutation,
  projectActivityWrite,
  protectRecurrenceEdit,
  reconcileRecurrenceEdit,
} from '@/lib/agendaCache';
import { IntentLogFullError } from '@/lib/intentLog';
import { getActiveIntentLog, replayingIntent } from '@/lib/intentReplay';
import {
  changesActivityLists,
  refreshActivityDetails,
  refreshActivityLists,
  registerActivityMutationDefaults,
} from '@/lib/mutationDefaults';
import { useSyncStatus } from '@/stores/syncStatus';

/**
 * The intent id for a write, which is its `Idempotency-Key` wherever one exists.
 *
 * Reusing that value is what makes the log idempotent end to end: the same key identifies the
 * intent locally and deduplicates the request server side, so an intent replayed after a lost
 * response cannot become a second entity. The two mutations without one — delete and patch —
 * are naturally idempotent against a given target, so a per-target id is enough.
 */
export function intentIdFor(variables: unknown): string {
  const fields = variables as
    | {
        intentId?: unknown;
        idempotencyKey?: unknown;
        activityId?: unknown;
        reminderId?: unknown;
      }
    | undefined;
  if (typeof fields?.intentId === 'string') return fields.intentId;
  if (typeof fields?.idempotencyKey === 'string') return fields.idempotencyKey;
  throw new Error(
    'Offline-capable mutations require a stable intentId or idempotencyKey.',
  );
}

/** The entity FIFO is promised within. Falls back to the intent id for an entity-less write. */
function entityIdFor(variables: unknown): string {
  const fields = variables as
    | { activityId?: unknown; input?: { activityId?: unknown } }
    | undefined;
  if (typeof fields?.activityId === 'string') return fields.activityId;
  if (typeof fields?.input?.activityId === 'string') return fields.input.activityId;
  return intentIdFor(variables);
}

/**
 * Resolves an intent after its request settled.
 *
 * Only the intent this mutation created, and only when it is not a replay — `replayIntents`
 * owns the lifecycle of what it dispatches, and two writers moving one intent would race.
 */
function settleIntent(
  variables: unknown,
  outcome: 'ok' | Error,
  retainForReconciliation = false,
  reconciliationVersion?: string,
): void {
  const log = getActiveIntentLog();
  const intentId = intentIdFor(variables);
  if (log === undefined || replayingIntent() === intentId) return;
  if (outcome === 'ok') {
    void (retainForReconciliation
      ? log.acknowledgeForReconciliation(intentId, reconciliationVersion)
      : log.acknowledge(intentId));
    return;
  }
  /**
   * A failed live attempt returns to `queued` rather than `failed`: the app is usually offline
   * when this fires, and that is precisely the case the queue exists for. `replayIntents`
   * makes the permanent-versus-transient decision on the retry, where a real status code is
   * available to make it with.
   */
  void log.requeue(intentId, outcome.message);
}

/**
 * Builds the client with the offline defaults from `tech-stack.md` section 3.4.
 *
 * The transport is the only retry layer. Its initial attempt plus three retries already
 * permits four HTTP attempts. Wrapping that in TanStack's initial attempt plus three retries
 * multiplies the same logical operation to as many as 16 HTTP attempts, so both Query and
 * Mutation retries are disabled here.
 */
export function createOfflineQueryClient(): QueryClient {
  const client = new QueryClient({
    mutationCache: new MutationCache({
      /**
       * **The write-ahead point** (P2-48, `tech-stack.md` §3.4 mechanism 4).
       *
       * TanStack awaits this before `mutationFn` and before the mutation's own `onMutate`, so
       * one seam gives the exact ordering the durability contract requires — persist, then
       * project, then request — for all thirteen registered mutations at once, without a
       * single call site knowing the log exists. Throwing here aborts the mutation before any
       * request, which is how a full queue or a failed disk write refuses the action instead
       * of letting the user believe it happened.
       *
       * **The 200-intent cap moved into `IntentLog.append`**, which is the only place that can
       * count it correctly: the cap measures unacknowledged *user data*, so `failed` and
       * `needs_attention` intents count even though none is a pending TanStack mutation.
       * Counting live mutations undercounted by exactly the writes most likely to be stuck.
       */
      onMutate: async (variables, mutation) => {
        const log = getActiveIntentLog();
        if (log === undefined) return;
        const { mutationKey } = mutation.options;
        if (!Array.isArray(mutationKey)) return;
        /**
         * A replay runs through this same cache. Without this it would append a second copy
         * of the intent it is replaying, and the queue would grow every time it drained.
         */
        if (replayingIntent() === intentIdFor(variables)) return;

        try {
          await log.append({
            intentId: intentIdFor(variables),
            mutationKey: mutationKey.map(String),
            variables,
            entityId: entityIdFor(variables),
          });
          if (isRecurrenceEditMutation(mutationKey, variables)) {
            const activityId = entityIdFor(variables);
            protectRecurrenceEdit(client, activityId);
          }
        } catch (error) {
          if (error instanceof IntentLogFullError) {
            useSyncStatus.getState().showQueueFull();
          }
          throw error;
        }
      },
      onError: (error, variables, _context, mutation) => {
        if (!(error instanceof IntentLogFullError)) {
          const recurrenceEdit = isRecurrenceEditMutation(
            mutation.options.mutationKey,
            variables,
          );
          if (recurrenceEdit && isPermanentFailure(error)) {
            clearRecurrenceEditProtection(client, entityIdFor(variables));
            const log = getActiveIntentLog();
            if (log !== undefined && replayingIntent() !== intentIdFor(variables)) {
              void log.fail(intentIdFor(variables), String((error as Error).message));
            }
          } else {
            settleIntent(
              variables,
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
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
      onSuccess: (data, variables, _context, mutation) => {
        const { mutationKey } = mutation.options;
        const recurrenceEdit = isRecurrenceEditMutation(mutationKey, variables);
        const recurrenceVersion = recurrenceEdit ? activityVersionFrom(data) : undefined;
        settleIntent(variables, 'ok', recurrenceEdit, recurrenceVersion);
        refreshActivityDetails(client, mutationKey, variables);
        if (!changesActivityLists(mutationKey)) return;
        projectActivityWrite(client, mutationKey, data, variables);
        if (recurrenceEdit) {
          const activityId = entityIdFor(variables);
          const version = recurrenceVersion;
          const intentId = intentIdFor(variables);
          if (version !== undefined) {
            void reconcileRecurrenceEdit(client, activityId, version).then((proved) => {
              const log = getActiveIntentLog();
              if (proved) void log?.acknowledge(intentId);
              else {
                void log?.failReconciliation(
                  intentId,
                  "Couldn't refresh schedule · Retry",
                );
              }
            });
          }
        }
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

function activityVersionFrom(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const candidate = 'activity' in data ? (data as { activity: unknown }).activity : data;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const version = (candidate as { updatedAt?: unknown }).updatedAt;
  return typeof version === 'string' ? version : undefined;
}

function isPermanentFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status;
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}
