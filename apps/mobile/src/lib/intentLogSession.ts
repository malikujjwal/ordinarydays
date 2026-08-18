import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { Platform } from 'react-native';
import {
  clearRecurrenceEditProtection,
  isRecurrenceEditMutation,
  reconcileRecurrenceEdit,
  restorePendingActivityCreates,
  restoreRecurrenceEditProtection,
} from '@/lib/agendaCache';
import { httpClientConfig } from '@/lib/apiClient';
import { IntentLog } from '@/lib/intentLog';
import { replayIntents, setActiveIntentLog } from '@/lib/intentReplay';
import {
  importLegacyPausedMutations,
  retireImportedLegacyPausedMutations,
} from '@/lib/persister';

/**
 * Binds one durable intent log to one signed-in account, for the life of that session.
 *
 * ## Where the account comes from
 *
 * `tokenProvider.getIdentity()` — the same seam every request already presents. In Phases 1–3
 * it resolves the fixed `usr_local_dev`; Phase 4 swaps in the Cognito provider and nothing
 * here changes, which is the point of it being a provider. It also answers **offline**, from
 * the token already on the device, so a cold start with no connectivity still knows whose log
 * to open — and an offline cold start is exactly when unsynced writes exist.
 *
 * ## iOS only
 *
 * ADR-024's rule, unchanged by ADR-055: a browser tab is closed rather than backgrounded, and
 * a queue that never flushes is worse than an error toast. On web no log is registered, so
 * `MutationCache.onMutate` finds none and every mutation behaves exactly as it did before.
 */
export interface IntentLogSession {
  log: IntentLog;
  stop: () => void;
}

export async function startIntentLogSession(
  client: QueryClient,
  platform = Platform.OS,
): Promise<IntentLogSession | undefined> {
  if (platform !== 'ios') return undefined;
  const userId = await httpClientConfig.tokenProvider.getIdentity();
  if (userId === undefined) return undefined;

  const log = new IntentLog(userId);
  await log.hydrate();
  /**
   * The one-time bridge, before anything else runs. A device upgrading into this build may
   * hold paused mutations in the old query-cache envelope; they become intents once, keyed on
   * the `Idempotency-Key` they already carry.
   */
  await importLegacyPausedMutations(log, platform);
  retireImportedLegacyPausedMutations(client, log);
  setActiveIntentLog(log);

  /**
   * Query-cache restoration happens before this session starts. Rebuild pending creates from
   * the durable source of truth now, including when the app launched offline and no replay
   * pass will run. This makes the optimistic series restart-safe instead of merely fast in
   * the process that accepted it.
   */
  restorePendingActivityCreates(
    client,
    log
      .snapshot()
      .intents.filter(
        (intent) => intent.status === 'queued' || intent.status === 'in_flight',
      ),
  );
  const restoredIntents = log.snapshot().intents;
  restoreRecurrenceEditProtection(client, restoredIntents);
  const protectedActivityIds = new Set(
    restoredIntents
      .filter(
        (intent) =>
          isRecurrenceEditMutation(intent.mutationKey, intent.variables) &&
          (intent.status === 'queued' ||
            intent.status === 'in_flight' ||
            intent.status === 'acknowledged'),
      )
      .map((intent) => intent.entityId),
  );
  const unsubscribeProtection = log.subscribe(() => {
    const active = new Set(
      log
        .snapshot()
        .intents.filter(
          (intent) =>
            isRecurrenceEditMutation(intent.mutationKey, intent.variables) &&
            (intent.status === 'queued' ||
              intent.status === 'in_flight' ||
              intent.status === 'acknowledged'),
        )
        .map((intent) => intent.entityId),
    );
    for (const activityId of protectedActivityIds) {
      if (!active.has(activityId)) {
        clearRecurrenceEditProtection(client, activityId);
        protectedActivityIds.delete(activityId);
      }
    }
    for (const activityId of active) protectedActivityIds.add(activityId);
  });
  for (const intent of restoredIntents) {
    if (intent.status !== 'acknowledged' || intent.reconciliationVersion === undefined) {
      continue;
    }
    if (intent.mutationKey[0] !== 'activity' || intent.mutationKey[1] !== 'patch') {
      continue;
    }
    void reconcileRecurrenceEdit(
      client,
      intent.entityId,
      intent.reconciliationVersion,
    ).then((proved) => {
      if (proved) void log.acknowledge(intent.intentId);
      else {
        void log.failReconciliation(intent.intentId, "Couldn't refresh schedule · Retry");
      }
    });
  }

  /**
   * Drain on reconnect, and once now if already online — a relaunch that comes up connected
   * has a log full of work and no connectivity transition coming to trigger it.
   */
  const unsubscribe = onlineManager.subscribe((online) => {
    if (online) void replayIntents(client, log);
  });
  if (onlineManager.isOnline()) void replayIntents(client, log);

  return {
    log,
    stop: () => {
      unsubscribe();
      unsubscribeProtection();
      /**
       * Sign-out **quarantines** (`auth.md` §3.4 step 6): the session forgets the log, every
       * byte stays on disk. Destroying unacknowledged writes here would lose work at the one
       * moment it is most likely to exist.
       */
      log.quarantine();
      setActiveIntentLog(undefined);
    },
  };
}
