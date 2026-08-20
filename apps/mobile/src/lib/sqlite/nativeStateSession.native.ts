import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { AppState } from 'react-native';
import { httpClientConfig } from '@/lib/apiClient';
import {
  inspectNativeLegacyStoredClient,
  type NativeLegacyPersistenceSnapshot,
} from '@/lib/legacyPersistence';
import type { RestoreOutcome } from '@/lib/persister';
import { AccountDatabaseManager } from '@/lib/sqlite/accountDatabase';
import { NativeActivityActionCoordinator } from '@/lib/sqlite/actionCoordinator';
import { ActivityAgendaLegacyImportTarget } from '@/lib/sqlite/activityAgendaLegacyTarget';
import { ActivityRepository } from '@/lib/sqlite/activityRepository';
import { ActivityTransactionService } from '@/lib/sqlite/activityTransactions';
import { AgendaRepository } from '@/lib/sqlite/agendaRepository';
import { AnytimeRepository } from '@/lib/sqlite/anytimeRepository';
import { LegacyImporter } from '@/lib/sqlite/legacyImporter';
import { migrateNativeLegacyState } from '@/lib/sqlite/legacyMigration';
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
  restoreOutcome?: RestoreOutcome,
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
  startup = startSession(queryClient, ownerUserId, restoreOutcome).finally(() => {
    startup = undefined;
    startupOwnerUserId = undefined;
  });
  return startup;
}

async function startSession(
  queryClient: QueryClient,
  ownerUserId: string,
  restoreOutcome?: RestoreOutcome,
): Promise<NativeStateSession | undefined> {
  const account = await databases.open(ownerUserId);
  const activities = new ActivityRepository(account.database, account.subscriptions);
  const agenda = new AgendaRepository(
    account.database,
    account.subscriptions,
    account.transactions,
  );
  const anytime = new AnytimeRepository(account.database, account.subscriptions);
  const outbox = new OutboxRepository(account.database);
  const importer = new LegacyImporter(
    account.transactions,
    new ActivityAgendaLegacyImportTarget(activities, agenda, outbox),
  );
  const legacyEvidence = restoreOutcome?.nativeLegacyPersistence;
  let legacySnapshot: NativeLegacyPersistenceSnapshot | undefined;
  let legacySnapshotError: Error | undefined;
  if (legacyEvidence?.kind === 'available') {
    try {
      legacySnapshot = inspectNativeLegacyStoredClient(
        legacyEvidence.storedClient,
        'ios',
      );
    } catch (error) {
      legacySnapshotError = error instanceof Error ? error : new Error(String(error));
    }
  }
  const migration =
    legacyEvidence?.kind === 'unavailable' || legacySnapshotError !== undefined
      ? {
          kind: 'deferred' as const,
          queryPersistenceSafe: false as const,
          error:
            legacyEvidence?.kind === 'unavailable'
              ? legacyEvidence.error
              : (legacySnapshotError ?? new Error('Legacy migration evidence failed.')),
        }
      : await migrateNativeLegacyState(
          ownerUserId,
          queryClient,
          importer,
          undefined,
          legacySnapshot,
        );
  if (migration.kind === 'deferred') {
    console.warn('native_legacy_migration_deferred', migration.error.message);
  }
  await recoverAbandonedOutbox(account.transactions, outbox);
  const service = new ActivityTransactionService(outbox, activities, agenda);
  const sync = new SerializedNativeSyncEngine(
    account.transactions,
    outbox,
    activities,
    agenda,
    undefined,
    undefined,
    undefined,
    anytime,
  );
  const coordinator = new NativeActivityActionCoordinator(
    ownerUserId,
    account.transactions,
    service,
    outbox,
    sync,
  );
  setActiveNativeState({
    account,
    activities,
    agenda,
    anytime,
    outbox,
    coordinator,
    sync,
  });
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
    queryPersistenceSafe: migration.queryPersistenceSafe,
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
