import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activity as activitySchema } from '@od/shared/schemas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pendingActivityFromInput } from '@/lib/pendingActivity';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';
import { ActivityAgendaLegacyImportTarget } from './activityAgendaLegacyTarget';
import { ActivityRepository } from './activityRepository';
import { AgendaRepository } from './agendaRepository';
import type { SqliteDatabase } from './database';
import { LegacyImporter, type LegacyImportSource } from './legacyImporter';
import { FOUNDATION_MIGRATIONS, runMigrations } from './migrations';
import { OutboxRepository } from './outbox';
import { RepositorySubscriptions } from './subscriptions';
import { SerializedTransactionRunner } from './transaction';

const OWNER = 'usr_01J0000000000000000000000A';
const ACTIVITY = 'act_01J0000000000000000000000A';

function source(): LegacyImportSource {
  const pending = pendingActivityFromInput(
    {
      activityId: ACTIVITY,
      objectKind: 'task',
      type: 'task',
      title: 'Verified legacy activity',
      schedule: { date: '2026-08-19', timezone: 'America/New_York' },
    },
    ACTIVITY,
    '2026-08-19T00:00:00.000Z',
  );
  const { pending: _pending, ...fields } = pending;
  return {
    sourceId: 'async-storage-owner-a',
    baseCandidates: [
      {
        provenance: 'verified_server_base',
        recordKey: 'activity-base',
        domain: 'activity',
        serverVersion: '2026-08-19T00:00:00.000Z',
        value: {
          detail: {
            activity: activitySchema.parse({ ...fields, ownerId: OWNER }),
            reminders: [],
          },
        },
      },
      {
        provenance: 'verified_server_base',
        recordKey: 'agenda-base',
        domain: 'agenda',
        serverVersion: 'agenda-v1',
        value: {
          request: {
            from: '2026-08-19',
            to: '2026-08-20',
            tz: 'America/New_York',
          },
          data: {
            days: [
              { date: '2026-08-19', schedule: [], anytime: [], earlier: [] },
              { date: '2026-08-20', schedule: [], anytime: [], earlier: [] },
            ],
            warnings: [],
          },
        },
      },
      { provenance: 'p2_60_materialized_overlay', recordKey: 'overlay-never-imported' },
    ],
    intents: [
      {
        recordKey: 'legacy-complete',
        intentId: 'legacy-complete-id',
        mutationKey: ['activity', 'complete'],
        variables: {
          activityId: ACTIVITY,
          idempotencyKey: 'legacy-complete-id',
          input: {},
        },
        entityId: ACTIVITY,
        orderingKey: `activity:${ACTIVITY}`,
        status: 'in_flight',
      },
    ],
  };
}

describe('P2-62 Activity/Agenda legacy target', () => {
  let directory = '';
  let database: SqliteDatabase | undefined;
  let transactions: SerializedTransactionRunner;
  let activities: ActivityRepository;
  let agenda: AgendaRepository;
  let outbox: OutboxRepository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ordinarydays-p2-62-import-'));
    database = await createNodeSqliteFactory(directory).open('import.sqlite');
    await runMigrations(database, FOUNDATION_MIGRATIONS);
    const subscriptions = new RepositorySubscriptions();
    transactions = new SerializedTransactionRunner(database, subscriptions);
    activities = new ActivityRepository(database, subscriptions);
    agenda = new AgendaRepository(database, subscriptions);
    outbox = new OutboxRepository(database);
  });

  afterEach(async () => {
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('imports verified domain bases and intents idempotently without installing overlays', async () => {
    const importer = new LegacyImporter(
      transactions,
      new ActivityAgendaLegacyImportTarget(activities, agenda, outbox),
      async () => 'stable-source',
      () => '2026-08-19T01:00:00.000Z',
    );

    const first = await importer.import(source());
    const second = await importer.import(source());

    expect(first.kind).toBe('imported');
    expect(first.receipt).toMatchObject({
      importedBaseCount: 2,
      importedIntentCount: 1,
      requiresSync: true,
    });
    expect(second.kind).toBe('already_imported');
    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity.title,
    ).toBe('Verified legacy activity');
    expect(
      await agenda.hasCoverage({
        from: '2026-08-19',
        to: '2026-08-20',
        timezone: 'America/New_York',
      }),
    ).toBe(true);
    expect(
      (await outbox.all()).map((intent) => ({
        id: intent.intentId,
        status: intent.status,
      })),
    ).toEqual([{ id: 'legacy-complete-id', status: 'queued' }]);
    expect(
      await database?.all(
        'SELECT record_key FROM legacy_domain_imports ORDER BY record_key;',
      ),
    ).toEqual([{ record_key: 'activity-base' }, { record_key: 'agenda-base' }]);
  });

  it('rolls the real domain rows and imported outbox back when the import is interrupted', async () => {
    const target = new ActivityAgendaLegacyImportTarget(activities, agenda, outbox);
    const interrupted = {
      ...target,
      importVerifiedBase: target.importVerifiedBase.bind(target),
      verify: target.verify.bind(target),
      scopesAfterCommit: target.scopesAfterCommit.bind(target),
      importIntent: async (...args: Parameters<typeof target.importIntent>) => {
        await target.importIntent(...args);
        throw new Error('simulated importer process death');
      },
    };
    const importer = new LegacyImporter(
      transactions,
      interrupted,
      async () => 'interrupted',
    );

    await expect(importer.import(source())).rejects.toThrow(
      'simulated importer process death',
    );
    expect(await database?.all('SELECT * FROM activities;')).toEqual([]);
    expect(await database?.all('SELECT * FROM agenda_coverage;')).toEqual([]);
    expect(await database?.all('SELECT * FROM outbox_intents;')).toEqual([]);
    expect(await database?.all('SELECT * FROM legacy_import_receipts;')).toEqual([]);
  });

  it('preserves legacy replay age, attempts, attention and clock evidence', async () => {
    const importer = new LegacyImporter(
      transactions,
      new ActivityAgendaLegacyImportTarget(activities, agenda, outbox),
      async () => 'metadata-source',
    );
    await importer.import({
      sourceId: 'legacy-metadata',
      baseCandidates: [],
      intents: [
        {
          recordKey: 'old-rejection',
          intentId: 'old-rejection-id',
          mutationKey: ['activity', 'patch'],
          variables: {
            activityId: ACTIVITY,
            intentId: 'old-rejection-id',
            input: { title: 'Old title' },
            ifMatch: 'v1',
          },
          entityId: ACTIVITY,
          orderingKey: `activity:${ACTIVITY}`,
          status: 'needs_attention',
          createdAt: 1_700_000_000_000,
          attempts: 4,
          attention: { kind: 'rejected', status: 422, code: 'validation_failed' },
          clockWitness: 1_800_000_000_000,
        },
      ],
    });

    expect((await outbox.all())[0]).toMatchObject({
      createdAt: 1_700_000_000_000,
      attempts: 4,
      status: 'needs_attention',
      attention: { kind: 'rejected', status: 422, code: 'validation_failed' },
    });
    expect(
      await database?.first('SELECT clock_witness FROM outbox_meta WHERE singleton = 1;'),
    ).toEqual({ clock_witness: 1_800_000_000_000 });
  });
});
