import AsyncStorage from '@react-native-async-storage/async-storage';
import type { QueryClient } from '@tanstack/react-query';
import { IntentLog, intentLogKey } from '@/lib/intentLog';
import {
  importLegacyPausedMutations,
  inspectNativeLegacyPersistence,
  type NativeLegacyPersistenceSnapshot,
  retireNativeActivityAgendaPersistence,
} from '@/lib/legacyPersistence';
import type {
  LegacyImportOutcome,
  LegacyImportSource,
} from '@/lib/sqlite/legacyImporter';

export interface LegacyMigrationImporter {
  import(source: LegacyImportSource): Promise<LegacyImportOutcome>;
}

export interface NativeLegacyMigrationDependencies {
  readonly hasIntentLog: (ownerUserId: string) => Promise<boolean>;
  readonly createIntentLog: (ownerUserId: string) => IntentLog;
  readonly inspectPersistence: () => Promise<NativeLegacyPersistenceSnapshot>;
  readonly importPausedMutations: (
    log: IntentLog,
    snapshot: NativeLegacyPersistenceSnapshot,
  ) => Promise<number>;
  readonly retirePersistence: (
    client: QueryClient,
    log: IntentLog,
    snapshot: NativeLegacyPersistenceSnapshot,
  ) => Promise<void>;
}

const nativeDependencies: NativeLegacyMigrationDependencies = {
  hasIntentLog: async (ownerUserId) =>
    (await AsyncStorage.getItem(intentLogKey(ownerUserId))) !== null,
  createIntentLog: (ownerUserId) => new IntentLog(ownerUserId),
  inspectPersistence: () => inspectNativeLegacyPersistence('ios'),
  importPausedMutations: (log, snapshot) =>
    importLegacyPausedMutations(log, 'ios', snapshot),
  retirePersistence: (client, log, snapshot) =>
    retireNativeActivityAgendaPersistence(client, log, 'ios', snapshot),
};

export type NativeLegacyMigrationResult =
  | { readonly kind: 'completed'; readonly queryPersistenceSafe: true }
  | {
      readonly kind: 'deferred';
      readonly queryPersistenceSafe: false;
      readonly error: Error;
    };

function failure(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Imports and retires the two legacy sources as one restart-safe startup step. A failure
 * deliberately returns a deferred result: SQLite can still open and sync, while query-cache
 * persistence stays disabled so it cannot overwrite the unretired legacy envelope.
 */
export async function migrateNativeLegacyState(
  ownerUserId: string,
  queryClient: QueryClient,
  importer: LegacyMigrationImporter,
  dependencies: NativeLegacyMigrationDependencies = nativeDependencies,
  persistenceSnapshot?: NativeLegacyPersistenceSnapshot,
): Promise<NativeLegacyMigrationResult> {
  try {
    const legacyPersistence =
      persistenceSnapshot ?? (await dependencies.inspectPersistence());
    if (
      legacyPersistence.domainMutationCount > 0 &&
      legacyPersistence.ownerUserId !== ownerUserId
    ) {
      throw new Error(
        'Legacy native mutations do not have verified ownership for this account; migration stopped.',
      );
    }
    const hadIntentLog = await dependencies.hasIntentLog(ownerUserId);
    const legacyLog = dependencies.createIntentLog(ownerUserId);
    await legacyLog.hydrate();
    await dependencies.importPausedMutations(legacyLog, legacyPersistence);
    const legacyEnvelope = legacyLog.snapshot();
    const legacyIntents = legacyEnvelope.intents;
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
          createdAt: intent.createdAt,
          attempts: intent.attempts,
          ...(intent.attention === undefined ? {} : { attention: intent.attention }),
          clockWitness: legacyEnvelope.clockWitness,
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
        /* v2 corrects P2-63's first-pass assumption that every query was an overlay. */
        sourceId: `async-storage-query-domain-v2:${ownerUserId}`,
        baseCandidates: [
          ...legacyPersistence.domainRecordKeys.map((recordKey) => ({
            provenance: 'ambiguous' as const,
            recordKey,
          })),
          ...Array.from(
            { length: legacyPersistence.domainMutationCount },
            (_, index) => ({
              provenance: 'ambiguous' as const,
              recordKey: `paused-mutation:${index + 1}`,
            }),
          ),
        ],
        intents: [],
      });
    }
    /* Both receipts are committed before either legacy durability source is removed. */
    await dependencies.retirePersistence(queryClient, legacyLog, legacyPersistence);
    if (hadIntentLog || legacyIntents.length > 0) await legacyLog.purge();
    return { kind: 'completed', queryPersistenceSafe: true };
  } catch (error) {
    return { kind: 'deferred', queryPersistenceSafe: false, error: failure(error) };
  }
}
