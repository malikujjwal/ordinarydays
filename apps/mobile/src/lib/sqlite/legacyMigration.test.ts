import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { IntentLog, type IntentLogStorage, intentLogKey } from '@/lib/intentLog';
import {
  type LegacyMigrationImporter,
  migrateNativeLegacyState,
  type NativeLegacyMigrationDependencies,
} from '@/lib/sqlite/legacyMigration';

const OWNER = 'usr_01J0000000000000000000000A';
const OTHER_OWNER = 'usr_01J0000000000000000000000B';
const ACTIVITY = 'act_01J0000000000000000000000A';

function memoryStorage(initial: Readonly<Record<string, string>> = {}): {
  readonly storage: IntentLogStorage;
  readonly values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    storage: {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => {
        values.set(key, value);
      },
      removeItem: async (key) => {
        values.delete(key);
      },
    },
  };
}

function importedOutcome(sourceId: string) {
  return {
    kind: 'imported' as const,
    canRetireLegacy: true as const,
    receipt: {
      sourceId,
      sourceFingerprint: 'fingerprint',
      importedBaseCount: 0,
      importedIntentCount: 0,
      importedDependencyCount: 0,
      requiresSync: true,
      importedAt: '2026-08-19T00:00:00.000Z',
    },
  };
}

function dependencies(
  log: IntentLog,
  overrides: Partial<NativeLegacyMigrationDependencies> = {},
): NativeLegacyMigrationDependencies {
  return {
    hasIntentLog: async () => false,
    createIntentLog: () => log,
    inspectPersistence: async () => ({
      domainRecordKeys: [],
      domainMutationCount: 0,
    }),
    importPausedMutations: async () => 0,
    retirePersistence: async () => undefined,
    ...overrides,
  };
}

describe('native legacy migration startup boundary', () => {
  it('defers an unowned mutation without opening or retiring its source', async () => {
    const { storage } = memoryStorage();
    const log = new IntentLog(OWNER, storage);
    const createIntentLog = vi.fn(() => log);
    const retirePersistence = vi.fn(async () => undefined);
    const importer: LegacyMigrationImporter = { import: vi.fn() };

    const result = await migrateNativeLegacyState(
      OWNER,
      new QueryClient(),
      importer,
      dependencies(log, {
        createIntentLog,
        inspectPersistence: async () => ({
          domainRecordKeys: ['query:agenda'],
          domainMutationCount: 1,
          ownerUserId: OTHER_OWNER,
        }),
        retirePersistence,
      }),
    );

    expect(result).toMatchObject({ kind: 'deferred', queryPersistenceSafe: false });
    expect(createIntentLog).not.toHaveBeenCalled();
    expect(importer.import).not.toHaveBeenCalled();
    expect(retirePersistence).not.toHaveBeenCalled();
  });

  it('keeps the account log when SQLite import verification fails', async () => {
    const { storage, values } = memoryStorage();
    const log = new IntentLog(OWNER, storage);
    await log.hydrate();
    await log.append({
      intentId: 'legacy-complete',
      mutationKey: ['activity', 'complete'],
      variables: { activityId: ACTIVITY, idempotencyKey: 'legacy-complete' },
      entityId: ACTIVITY,
    });
    const retirePersistence = vi.fn(async () => undefined);
    const importer: LegacyMigrationImporter = {
      import: vi.fn(async () => {
        throw new Error('read-back verification failed');
      }),
    };

    const result = await migrateNativeLegacyState(
      OWNER,
      new QueryClient(),
      importer,
      dependencies(log, {
        hasIntentLog: async () => true,
        retirePersistence,
      }),
    );

    expect(result).toMatchObject({
      kind: 'deferred',
      queryPersistenceSafe: false,
      error: expect.objectContaining({ message: 'read-back verification failed' }),
    });
    expect(values.has(intentLogKey(OWNER))).toBe(true);
    expect(retirePersistence).not.toHaveBeenCalled();
  });

  it('records unproven query records as ambiguous before retirement', async () => {
    const { storage } = memoryStorage();
    const log = new IntentLog(OWNER, storage);
    const imported = vi.fn(
      async (source: Parameters<LegacyMigrationImporter['import']>[0]) =>
        importedOutcome(source.sourceId),
    );
    const retirePersistence = vi.fn(async () => undefined);

    const result = await migrateNativeLegacyState(
      OWNER,
      new QueryClient(),
      { import: imported },
      dependencies(log, {
        inspectPersistence: async () => ({
          domainRecordKeys: ['query:agenda-cache'],
          domainMutationCount: 0,
          ownerUserId: OWNER,
        }),
        retirePersistence,
      }),
    );

    expect(result).toEqual({ kind: 'completed', queryPersistenceSafe: true });
    expect(imported).toHaveBeenCalledWith({
      sourceId: `async-storage-query-domain-v2:${OWNER}`,
      baseCandidates: [{ provenance: 'ambiguous', recordKey: 'query:agenda-cache' }],
      intents: [],
    });
    expect(retirePersistence).toHaveBeenCalledOnce();
  });
});
