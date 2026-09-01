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
import { ListItemsRepository } from '@/lib/sqlite/listItemsRepository';
import { ListsRepository } from '@/lib/sqlite/listsRepository';
import { ListTransactionService } from '@/lib/sqlite/listTransactions';
import {
  getActiveNativeState,
  type NativeStateSession,
  setActiveNativeState,
} from '@/lib/sqlite/nativeState';
import { OutboxRepository } from '@/lib/sqlite/outbox';
import { OutboxPresentationStore } from '@/lib/sqlite/outboxPresentationStore';
import { PlansRepository } from '@/lib/sqlite/plansRepository';
import { recoverAbandonedOutbox } from '@/lib/sqlite/sessionRecovery';
import { SerializedNativeSyncEngine } from '@/lib/sqlite/syncEngine';

const databases = new AccountDatabaseManager();
let activeSession: NativeStateSession | undefined;
let activeOwnerUserId: string | undefined;
let transition: Promise<void> = Promise.resolve();
let nextSessionId = 1;

function serialTransition<T>(task: () => Promise<T>): Promise<T> {
  const pending = transition.then(task, task);
  transition = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

export async function startNativeStateSession(
  queryClient: QueryClient,
  restoreOutcome?: RestoreOutcome,
): Promise<NativeStateSession | undefined> {
  const ownerUserId = await httpClientConfig.tokenProvider.getIdentity();
  if (ownerUserId === undefined) return undefined;
  return serialTransition(async () => {
    if (activeSession !== undefined && activeOwnerUserId === ownerUserId) {
      return activeSession;
    }
    if (activeSession !== undefined) {
      const previous = activeSession;
      previous.stop();
      await previous.closed;
    }
    return startSession(queryClient, ownerUserId, restoreOutcome);
  });
}

async function startSession(
  queryClient: QueryClient,
  ownerUserId: string,
  restoreOutcome?: RestoreOutcome,
): Promise<NativeStateSession | undefined> {
  const account = await databases.open(ownerUserId);
  const sessionId = `native-session-${nextSessionId}`;
  nextSessionId += 1;
  const activities = new ActivityRepository(account.database, account.subscriptions);
  const agenda = new AgendaRepository(
    account.database,
    account.subscriptions,
    account.transactions,
    account.projections,
  );
  const anytime = new AnytimeRepository(
    account.database,
    account.subscriptions,
    account.projections,
  );
  /* Canonical drains and transactional List intents share this one repository. */
  const lists = new ListsRepository(
    account.database,
    account.subscriptions,
    account.projections,
  );
  const listItems = new ListItemsRepository(
    account.database,
    account.subscriptions,
    account.projections,
  );
  const plans = new PlansRepository(
    account.database,
    account.subscriptions,
    account.projections,
  );
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
  const listService = new ListTransactionService(outbox, lists, listItems);
  const sync = new SerializedNativeSyncEngine(
    account.transactions,
    outbox,
    activities,
    agenda,
    undefined,
    undefined,
    undefined,
    anytime,
    lists,
    undefined,
    listItems,
    plans,
  );
  const coordinator = new NativeActivityActionCoordinator(
    ownerUserId,
    account.transactions,
    service,
    outbox,
    sync,
    undefined,
    listService,
  );
  const outboxPresentation = new OutboxPresentationStore(
    ownerUserId,
    account.subscriptions,
    account.projections,
  );
  outboxPresentation.start();
  const stopOnline = onlineManager.subscribe((online) => {
    if (online) sync.request('connectivity');
  });
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') sync.request('foreground');
  });
  sync.request('foreground');

  let stopped = false;
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const session: NativeStateSession = {
    sessionId,
    queryPersistenceSafe: migration.queryPersistenceSafe,
    closed,
    stop: () => {
      if (stopped) return;
      stopped = true;
      outboxPresentation.stop();
      sync.stop();
      stopOnline();
      appState.remove();
      if (getActiveNativeState()?.sessionId === sessionId) {
        setActiveNativeState(undefined);
      }
      if (activeSession === session) {
        activeSession = undefined;
        activeOwnerUserId = undefined;
      }
      void databases.release(account).then(
        () => resolveClosed?.(),
        () => resolveClosed?.(),
      );
    },
  };
  setActiveNativeState({
    sessionId,
    ownerUserId,
    account,
    activities,
    agenda,
    anytime,
    lists,
    listItems,
    plans,
    outbox,
    outboxPresentation,
    coordinator,
    sync,
  });
  activeOwnerUserId = ownerUserId;
  activeSession = session;
  return session;
}
