import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteDatabase } from '@/lib/sqlite/database';
import { textColumn } from '@/lib/sqlite/database';
import {
  LegacyImportError,
  LegacyImporter,
  type LegacyImportSource,
  type LegacyImportTarget,
} from '@/lib/sqlite/legacyImporter';
import { FOUNDATION_MIGRATIONS, runMigrations } from '@/lib/sqlite/migrations';
import { RepositorySubscriptions } from '@/lib/sqlite/subscriptions';
import { SerializedTransactionRunner } from '@/lib/sqlite/transaction';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';

const SOURCE_ID = 'async-storage-account-a';

function source(): LegacyImportSource {
  return {
    sourceId: SOURCE_ID,
    baseCandidates: [
      {
        provenance: 'verified_server_base',
        recordKey: 'agenda:2026-08-19',
        domain: 'agenda',
        serverVersion: 'etag-verified',
        value: { days: [] },
      },
      { provenance: 'ambiguous', recordKey: 'activity:ambiguous' },
      { provenance: 'p2_60_materialized_overlay', recordKey: 'agenda:overlay' },
    ],
    intents: [
      {
        recordKey: 'legacy-record-1',
        intentId: 'intent-1',
        mutationKey: ['activity', 'complete'],
        variables: { activityId: 'act_1' },
        entityId: 'act_1',
        orderingKey: 'activity:act_1',
        status: 'in_flight',
      },
      {
        recordKey: 'legacy-record-2',
        intentId: 'intent-2',
        mutationKey: ['activity', 'uncomplete'],
        variables: { activityId: 'act_1' },
        entityId: 'act_1',
        orderingKey: 'activity:act_1',
        status: 'queued',
        dependsOnIntentId: 'intent-1',
        compensationForIntentId: 'intent-1',
      },
      {
        recordKey: 'legacy-record-1',
        intentId: 'intent-1',
        mutationKey: ['activity', 'complete'],
        variables: { activityId: 'act_1' },
        entityId: 'act_1',
        orderingKey: 'activity:act_1',
        status: 'in_flight',
      },
    ],
  };
}

function target(failAfterFirstIntent = false): LegacyImportTarget {
  let intentCount = 0;
  return {
    importVerifiedBase: async (transaction, sourceId, record) => {
      await transaction.database.run(
        `INSERT INTO importer_test_bases
          (source_id, record_key, server_version, payload) VALUES (?, ?, ?, ?);`,
        [sourceId, record.recordKey, record.serverVersion, JSON.stringify(record.value)],
      );
    },
    importIntent: async (transaction, sourceId, intent) => {
      intentCount += 1;
      await transaction.database.run(
        `INSERT INTO importer_test_intents
          (source_id, record_key, intent_id, ordering_key, status, depends_on,
           compensation_for, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          sourceId,
          intent.recordKey,
          intent.intentId,
          intent.orderingKey,
          intent.status,
          intent.dependsOnIntentId ?? null,
          intent.compensationForIntentId ?? null,
          JSON.stringify(intent.variables),
        ],
      );
      if (failAfterFirstIntent && intentCount === 1)
        throw new Error('interrupted import');
    },
    verify: async (transaction, sourceId) => {
      const bases = await transaction.database.all(
        'SELECT record_key, server_version FROM importer_test_bases WHERE source_id = ?;',
        [sourceId],
      );
      const intents = await transaction.database.all(
        `SELECT record_key, intent_id, ordering_key, status, depends_on, compensation_for
           FROM importer_test_intents WHERE source_id = ?;`,
        [sourceId],
      );
      return {
        bases: bases.map((row) => {
          const recordKey = textColumn(row, 'record_key');
          const serverVersion = textColumn(row, 'server_version');
          if (recordKey === undefined || serverVersion === undefined)
            throw new Error('Imported base verification row is malformed.');
          return { recordKey, serverVersion };
        }),
        intents: intents.map((row) => {
          const recordKey = textColumn(row, 'record_key');
          const intentId = textColumn(row, 'intent_id');
          const orderingKey = textColumn(row, 'ordering_key');
          const status = textColumn(row, 'status');
          if (
            recordKey === undefined ||
            intentId === undefined ||
            orderingKey === undefined ||
            status === undefined
          ) {
            throw new Error('Imported intent verification row is malformed.');
          }
          const dependsOnIntentId = textColumn(row, 'depends_on');
          const compensationForIntentId = textColumn(row, 'compensation_for');
          return {
            recordKey,
            intentId,
            orderingKey,
            status,
            ...(dependsOnIntentId === undefined ? {} : { dependsOnIntentId }),
            ...(compensationForIntentId === undefined ? {} : { compensationForIntentId }),
          };
        }),
        dependencyEdges: intents.flatMap((row) => {
          const key = textColumn(row, 'record_key');
          const dependency = textColumn(row, 'depends_on');
          return key === undefined || dependency === undefined
            ? []
            : [`${key}->${dependency}`];
        }),
      };
    },
    scopesAfterCommit: () => new Set(['legacy-import']),
  };
}

describe('transactional legacy importer', () => {
  let directory = '';
  let database: SqliteDatabase | undefined;
  let subscriptions: RepositorySubscriptions;
  let transactions: SerializedTransactionRunner;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ordinarydays-importer-'));
    database = await createNodeSqliteFactory(directory).open('importer.sqlite');
    await runMigrations(database, FOUNDATION_MIGRATIONS);
    await database.exec(`
      CREATE TABLE importer_test_bases (
        source_id TEXT NOT NULL,
        record_key TEXT NOT NULL,
        server_version TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (source_id, record_key)
      );
      CREATE TABLE importer_test_intents (
        source_id TEXT NOT NULL,
        record_key TEXT NOT NULL,
        intent_id TEXT NOT NULL,
        ordering_key TEXT NOT NULL,
        status TEXT NOT NULL,
        depends_on TEXT,
        compensation_for TEXT,
        payload TEXT NOT NULL,
        PRIMARY KEY (source_id, record_key)
      );
    `);
    subscriptions = new RepositorySubscriptions();
    transactions = new SerializedTransactionRunner(database, subscriptions);
  });

  afterEach(async () => {
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('imports verified bases and every distinct intent once, then returns its receipt', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    const listener = vi.fn();
    subscriptions.subscribe('legacy-import', listener);
    const importer = new LegacyImporter(
      transactions,
      target(),
      async () => 'fingerprint-one',
      () => '2026-08-19T00:00:00.000Z',
    );

    const first = await importer.import(source());
    const second = await importer.import(source());

    expect(first).toMatchObject({
      kind: 'imported',
      canRetireLegacy: true,
      receipt: {
        importedBaseCount: 1,
        importedIntentCount: 2,
        importedDependencyCount: 1,
        requiresSync: true,
      },
    });
    expect(second.kind).toBe('already_imported');
    expect(await database.all('SELECT record_key FROM importer_test_bases;')).toEqual([
      { record_key: 'agenda:2026-08-19' },
    ]);
    expect(
      await database.all(
        'SELECT record_key, status FROM importer_test_intents ORDER BY record_key;',
      ),
    ).toEqual([
      { record_key: 'legacy-record-1', status: 'in_flight' },
      { record_key: 'legacy-record-2', status: 'queued' },
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('never imports ambiguous or P2-60 overlay materialization as canonical base', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    const importer = new LegacyImporter(
      transactions,
      target(),
      async () => 'fingerprint-two',
    );

    const outcome = await importer.import(source());

    expect(outcome.receipt.requiresSync).toBe(true);
    expect(await database.all('SELECT record_key FROM importer_test_bases;')).toEqual([
      { record_key: 'agenda:2026-08-19' },
    ]);
    expect(
      await database.all(
        'SELECT intent_id, depends_on FROM importer_test_intents ORDER BY record_key;',
      ),
    ).toEqual([
      { intent_id: 'intent-1', depends_on: null },
      { intent_id: 'intent-2', depends_on: 'intent-1' },
    ]);
  });

  it('rolls every imported row back when read-back/import is interrupted', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    const importer = new LegacyImporter(
      transactions,
      target(true),
      async () => 'fingerprint-three',
    );

    await expect(importer.import(source())).rejects.toThrow('interrupted import');

    expect(await database.all('SELECT * FROM importer_test_bases;')).toEqual([]);
    expect(await database.all('SELECT * FROM importer_test_intents;')).toEqual([]);
    expect(await database.all('SELECT * FROM legacy_import_receipts;')).toEqual([]);
  });

  it('rejects conflicting source records and a changed source after receipt', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    const importer = new LegacyImporter(transactions, target(), async (value) => value);
    const conflicting = source();
    const firstIntent = conflicting.intents[0];
    if (firstIntent === undefined) throw new Error('Fixture intent is missing.');
    await expect(
      importer.import({
        ...conflicting,
        intents: [firstIntent, { ...firstIntent, status: 'queued' }],
      }),
    ).rejects.toBeInstanceOf(LegacyImportError);

    const stableImporter = new LegacyImporter(
      transactions,
      target(),
      async () => 'stable',
    );
    await stableImporter.import(source());
    const changedImporter = new LegacyImporter(
      transactions,
      target(),
      async () => 'changed',
    );
    await expect(changedImporter.import(source())).rejects.toBeInstanceOf(
      LegacyImportError,
    );
    expect(
      await database.all('SELECT COUNT(*) AS count FROM legacy_import_receipts;'),
    ).toEqual([{ count: 1 }]);
  });
});
