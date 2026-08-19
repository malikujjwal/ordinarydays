import AsyncStorage from '@react-native-async-storage/async-storage';
import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { AppState } from 'react-native';
import { httpClientConfig } from '@/lib/apiClient';
import { IntentLog, intentLogKey } from '@/lib/intentLog';
import {
  importLegacyPausedMutations,
  inspectNativeLegacyPersistence,
  retireNativeActivityAgendaPersistence,
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
import { recoverAbandonedOutbox } from '@/lib/sqlite/sessionRecovery';
import { SerializedNativeSyncEngine } from '@/lib/sqlite/syncEngine';

const databases = new AccountDatabaseManager();
let activeSession: NativeStateSession | undefined;
let activeOwnerUserId: string | undefined;
let startup: Promise<NativeStateSession | undefined> | undefined;
let startupOwnerUserId: string | undefined;

export async function startNativeStateSession(
  queryClient: QueryClient,
): Promise<NativeStateSession | undefined> {
  const ownerUserId = await httpClientConfig.tokenProvider.getIdentity();
  if (ownerUserId === undefined) return undefined;
  if (activeSession !== undefined && activeOwnerUserId === ownerUserId) {
    return activeSession;
  }
  if (activeSession !== undefined) activeSession.stop();
  if (startup !== undefined && startupOwnerUserId === ownerUserId) return startup;
  if (startup !== undefined) await startup;
  startupOwnerUserId = ownerUserId;
  startup = startSession(queryClient, ownerUserId).finally(() => {
    startup = undefined;
    startupOwnerUserId = undefined;
  });
  return startup;
}

async function startSession(
  queryClient: QueryClient,
  ownerUserId: string,
): Promise<NativeStateSession | undefined> {
  const account = await databases.open(ownerUserId);
  const activities = new ActivityRepository(account.database, account.subscriptions);
  const agenda = new AgendaRepository(account.database, account.subscriptions);
  const outbox = new OutboxRepository(account.database);
  const legacyPersistence = await inspectNativeLegacyPersistence('ios');
  if (
    legacyPersistence.domainMutationCount > 0 &&
    legacyPersistence.ownerUserId !== ownerUserId
  ) {
    throw new Error(
      'Legacy native mutations do not have verified ownership for this account; migration stopped.',
    );
  }
  const hadIntentLog = (await AsyncStorage.getItem(intentLogKey(ownerUserId))) !== null;
  const legacyLog = new IntentLog(ownerUserId);
  await legacyLog.hydrate();
  await importLegacyPausedMutations(legacyLog, 'ios');
  const legacyIntents = legacyLog.snapshot().intents;
  const importer = new LegacyImporter(
    account.transactions,
    new ActivityAgendaLegacyImportTarget(activities, agenda, outbox),
  );
  if (legacyIntents.length > 0) {
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
  }
  if (
    legacyPersistence.domainRecordKeys.length > 0 ||
    legacyPersistence.domainMutationCount > 0
  ) {
    await importer.import({
      sourceId: `async-storage-query-domain:${ownerUserId}`,
      baseCandidates: [
        ...legacyPersistence.domainRecordKeys.map((recordKey) => ({
          provenance: 'p2_60_materialized_overlay' as const,
          recordKey,
        })),
        ...Array.from({ length: legacyPersistence.domainMutationCount }, (_, index) => ({
          provenance: 'ambiguous' as const,
          recordKey: `paused-mutation:${index + 1}`,
        })),
      ],
      intents: [],
    });
  }
  /* Both receipts are committed before either legacy durability source is removed. */
  await retireNativeActivityAgendaPersistence(queryClient, legacyLog, 'ios');
  if (hadIntentLog || legacyIntents.length > 0) await legacyLog.purge();
  await recoverAbandonedOutbox(account.transactions, outbox);
  const service = new ActivityTransactionService(outbox, activities, agenda);
  const sync = new SerializedNativeSyncEngine(
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
  activeOwnerUserId = ownerUserId;

  const stopOnline = onlineManager.subscribe((online) => {
    if (online) sync.request('connectivity');
  });
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') sync.request('foreground');
  });
  sync.request('foreground');

  let stopped = false;
  const session: NativeStateSession = {
    stop: () => {
      if (stopped) return;
      stopped = true;
      sync.stop();
      stopOnline();
      appState.remove();
      setActiveNativeState(undefined);
      if (activeSession === session) {
        activeSession = undefined;
        activeOwnerUserId = undefined;
      }
      void databases.signOut();
    },
  };
  activeSession = session;
  return session;
}
