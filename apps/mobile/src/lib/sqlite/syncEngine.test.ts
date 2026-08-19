import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Activity } from '@od/shared/types';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';
import { ActivityRepository } from './activityRepository';
import { ActivityTransactionService } from './activityTransactions';
import { AgendaRepository } from './agendaRepository';
import type { SqliteDatabase } from './database';
import { FOUNDATION_MIGRATIONS, runMigrations } from './migrations';
import { OutboxRepository } from './outbox';
import { RepositorySubscriptions } from './subscriptions';
import { SerializedNativeSyncEngine } from './syncEngine';
import { SerializedTransactionRunner } from './transaction';

const OWNER = 'usr_01J0000000000000000000000A';
const ACTIVITY = 'act_01J0000000000000000000000A';
const clock = { today: '2026-08-19', currentMinute: '08:00' };

describe('serialized native convergence guard', () => {
  let directory = '';
  let database: SqliteDatabase | undefined;
  let transactions: SerializedTransactionRunner;
  let activities: ActivityRepository;
  let agenda: AgendaRepository;
  let outbox: OutboxRepository;
  let service: ActivityTransactionService;
  let client: QueryClient;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ordinarydays-p2-62-sync-'));
    database = await createNodeSqliteFactory(directory).open('sync.sqlite');
    await runMigrations(database, FOUNDATION_MIGRATIONS);
    await database.run(
      `INSERT INTO agenda_coverage
        (from_date, to_date, timezone, include_key, refreshed_at, warnings_json)
       VALUES ('2026-08-19', '2026-08-19', 'UTC', '', 'now', '[]');`,
    );
    const subscriptions = new RepositorySubscriptions();
    transactions = new SerializedTransactionRunner(database, subscriptions);
    activities = new ActivityRepository(database, subscriptions);
    agenda = new AgendaRepository(database, subscriptions);
    outbox = new OutboxRepository(database);
    service = new ActivityTransactionService(outbox, activities, agenda);
    client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    await transactions.run(async (transaction) => {
      await service.create(
        transaction,
        OWNER,
        {
          input: {
            activityId: ACTIVITY,
            objectKind: 'task',
            type: 'task',
            title: 'Canonical seed',
          },
          idempotencyKey: 'seed-create',
        },
        clock,
        '2026-08-19T00:00:00.000Z',
      );
      await transaction.database.run('DELETE FROM outbox_intents;');
      await transaction.database.run("UPDATE activities SET local_state = 'canonical';");
      await transaction.database.run("UPDATE agenda_rows SET local_state = 'canonical';");
    });
  });

  afterEach(async () => {
    client.clear();
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('does not let an older response arriving after a newer local commit regress SQLite', async () => {
    let releaseFirst: ((activity: Activity) => void) | undefined;
    const firstResponse = new Promise<Activity>((resolve) => {
      releaseFirst = resolve;
    });
    const mutation = vi.fn(async (variables: unknown) => {
      const title = (variables as { input: { title: string } }).input.title;
      if (title === 'First local edit') return firstResponse;
      const current = await activities.read({ kind: 'activity', activityId: ACTIVITY });
      if (current === undefined) throw new Error('missing test activity');
      return { ...current.activity, title, updatedAt: '2026-08-19T03:00:00.000Z' };
    });
    client.setMutationDefaults(['activity', 'patch'], { mutationFn: mutation });
    const sync = new SerializedNativeSyncEngine(
      OWNER,
      client,
      transactions,
      outbox,
      activities,
      agenda,
    );
    await transactions.run((transaction) =>
      service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'first-edit',
        input: { title: 'First local edit' },
        ifMatch: 'v1',
      }),
    );
    const running = sync.syncNow();
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));

    await transactions.run((transaction) =>
      service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'newer-edit',
        input: { title: 'Newer local edit' },
        ifMatch: 'v2',
      }),
    );
    const stale = await activities.read({ kind: 'activity', activityId: ACTIVITY });
    if (stale === undefined) throw new Error('missing stale response fixture');
    releaseFirst?.({
      ...stale.activity,
      title: 'Stale server response',
      updatedAt: '2026-08-19T02:00:00.000Z',
    });
    await running;
    sync.stop();

    expect(mutation).toHaveBeenCalledTimes(2);
    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity.title,
    ).toBe('Newer local edit');
    expect(await outbox.all()).toEqual([]);
  });

  it('retains committed rows and requeues the same intent after a transient HTTP failure', async () => {
    client.setMutationDefaults(['activity', 'patch'], {
      mutationFn: async () => {
        throw new Error('offline');
      },
    });
    const sync = new SerializedNativeSyncEngine(
      OWNER,
      client,
      transactions,
      outbox,
      activities,
      agenda,
    );
    await transactions.run((transaction) =>
      service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'offline-edit',
        input: { title: 'Kept while offline' },
        ifMatch: 'v1',
      }),
    );

    await sync.syncNow();
    sync.stop();

    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity.title,
    ).toBe('Kept while offline');
    expect(
      (await outbox.all()).map((intent) => ({
        id: intent.intentId,
        status: intent.status,
        attempts: intent.attempts,
      })),
    ).toEqual([{ id: 'offline-edit', status: 'queued', attempts: 1 }]);
  });
});
