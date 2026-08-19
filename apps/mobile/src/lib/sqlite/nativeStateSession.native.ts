import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { AppState } from 'react-native';
import { httpClientConfig } from '@/lib/apiClient';
import { IntentLog } from '@/lib/intentLog';
import {
  importLegacyPausedMutations,
  retireImportedLegacyPausedMutations,
} from '@/lib/persister';
import { AccountDatabaseManager } from '@/lib/sqlite/accountDatabase';
import { NativeActivityActionCoordinator } from '@/lib/sqlite/actionCoordinator';
import { ActivityAgendaLegacyImportTarget } from '@/lib/sqlite/activityAgendaLegacyTarget';
import { ActivityRepository } from '@/lib/sqlite/activityRepository';
import { ActivityTransactionService } from '@/lib/sqlite/activityTransactions';
import { AgendaRepository } from '@/lib/sqlite/agendaRepository';
import { LegacyImporter } from '@/lib/sqlite/legacyImporter';
import { type NativeStateSession, setActiveNativeState } from '@/lib/sqlite/nativeState';
import { OutboxRepository } from '@/lib/sqlite/outbox';
import { SerializedNativeSyncEngine } from '@/lib/sqlite/syncEngine';

const databases = new AccountDatabaseManager();

export async function startNativeStateSession(
  queryClient: QueryClient,
): Promise<NativeStateSession | undefined> {
  const ownerUserId = await httpClientConfig.tokenProvider.getIdentity();
  if (ownerUserId === undefined) return undefined;
  const account = await databases.open(ownerUserId);
  const activities = new ActivityRepository(account.database, account.subscriptions);
  const agenda = new AgendaRepository(account.database, account.subscriptions);
  const outbox = new OutboxRepository(account.database);
  const legacyLog = new IntentLog(ownerUserId);
  await legacyLog.hydrate();
  await importLegacyPausedMutations(legacyLog, 'ios');
  const legacyIntents = legacyLog.snapshot().intents;
  if (legacyIntents.length > 0) {
    const importer = new LegacyImporter(
      account.transactions,
      new ActivityAgendaLegacyImportTarget(activities, agenda, outbox),
    );
    await importer.import({
      sourceId: `async-storage-intent-log:${ownerUserId}`,
      baseCandidates: [],
      intents: legacyIntents.map((intent) => ({
        recordKey: `intent:${intent.seq}:${intent.intentId}`,
        intentId: intent.intentId,
        mutationKey: intent.mutationKey,
        variables: intent.variables,
        entityId: intent.entityId,
        orderingKey: `activity:${intent.entityId}`,
        status: intent.status,
        ...(intent.dependsOnIntentId === undefined
          ? {}
          : { dependsOnIntentId: intent.dependsOnIntentId }),
        ...(intent.compensationForIntentId === undefined
          ? {}
          : { compensationForIntentId: intent.compensationForIntentId }),
      })),
    });
    // Removes only the hydrated in-memory duplicate after SQLite read-back verification.
    // The account-scoped AsyncStorage source remains available for P2-63 retirement.
    retireImportedLegacyPausedMutations(queryClient, legacyLog);
  }
  const service = new ActivityTransactionService(outbox, activities, agenda);
  const sync = new SerializedNativeSyncEngine(
    ownerUserId,
    queryClient,
    account.transactions,
    outbox,
    activities,
    agenda,
  );
  const coordinator = new NativeActivityActionCoordinator(
    ownerUserId,
    account.transactions,
    service,
    outbox,
    sync,
  );
  setActiveNativeState({ account, activities, agenda, outbox, coordinator, sync });

  const stopOnline = onlineManager.subscribe((online) => {
    if (online) sync.request('connectivity');
  });
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') sync.request('foreground');
  });
  sync.request('foreground');

  return {
    stop: () => {
      sync.stop();
      stopOnline();
      appState.remove();
      setActiveNativeState(undefined);
      void databases.signOut();
    },
  };
}
