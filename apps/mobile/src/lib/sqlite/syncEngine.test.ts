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
import { recoverAbandonedOutbox } from './sessionRecovery';
import { RepositorySubscriptions } from './subscriptions';
import { SerializedNativeSyncEngine } from './syncEngine';
import { SerializedTransactionRunner } from './transaction';

const OWNER = 'usr_01J0000000000000000000000A';
const ACTIVITY = 'act_01J0000000000000000000000A';
const OTHER = 'act_01J0000000000000000000000B';
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

  async function seedRecurring(): Promise<Activity> {
    return transactions.run(async (transaction) => {
      await transaction.database.run('DELETE FROM activity_occurrences;');
      await transaction.database.run('DELETE FROM activity_reminders;');
      await transaction.database.run('DELETE FROM agenda_rows;');
      await transaction.database.run('DELETE FROM activities;');
      await transaction.database.run('DELETE FROM outbox_intents;');
      await service.create(
        transaction,
        OWNER,
        {
          input: {
            activityId: ACTIVITY,
            objectKind: 'task',
            type: 'task',
            title: 'Recurring task',
            schedule: { date: '2026-08-19', time: '09:00', timezone: 'UTC' },
            recurrence: {
              mode: 'fixed',
              segments: [{ freq: 'daily', interval: 1, effectiveFrom: '2026-08-19' }],
            },
          },
          idempotencyKey: 'recurring-seed',
        },
        clock,
        '2026-08-19T00:00:00.000Z',
      );
      await transaction.database.run('DELETE FROM outbox_intents;');
      await transaction.database.run("UPDATE activities SET local_state = 'canonical';");
      await transaction.database.run("UPDATE agenda_rows SET local_state = 'canonical';");
      const detail = await activities.read({ kind: 'activity', activityId: ACTIVITY });
      if (detail === undefined) throw new Error('missing recurring fixture');
      return detail.activity;
    });
  }

  it('recovers an abandoned claim on restart without changing identity or attempts', async () => {
    let originalSequence = 0;
    let abandonedBeforeRestart: Awaited<ReturnType<OutboxRepository['get']>>;
    await transactions.run(async (transaction) => {
      await outbox.append(transaction.database, {
        intentId: 'abandoned',
        mutationKey: ['activity', 'complete'],
        variables: { activityId: ACTIVITY, input: {}, idempotencyKey: 'abandoned' },
        entityId: ACTIVITY,
      });
      await outbox.append(transaction.database, {
        intentId: 'same-key-later',
        mutationKey: ['activity', 'complete'],
        variables: {
          activityId: ACTIVITY,
          input: {},
          idempotencyKey: 'same-key-later',
        },
        entityId: ACTIVITY,
      });
      await outbox.append(transaction.database, {
        intentId: 'unrelated',
        mutationKey: ['activity', 'complete'],
        variables: { activityId: OTHER, input: {}, idempotencyKey: 'unrelated' },
        entityId: OTHER,
      });
      const claimed = await outbox.claimNext(transaction.database);
      expect(claimed?.intentId).toBe('abandoned');
      originalSequence = claimed?.seq ?? 0;
      abandonedBeforeRestart = claimed;
    });
    await database?.close();
    database = await createNodeSqliteFactory(directory).open('sync.sqlite');
    const reopenedSubscriptions = new RepositorySubscriptions();
    const recoveredListener = vi.fn();
    reopenedSubscriptions.subscribe('outbox', recoveredListener);
    transactions = new SerializedTransactionRunner(database, reopenedSubscriptions);
    activities = new ActivityRepository(database, reopenedSubscriptions);
    agenda = new AgendaRepository(database, reopenedSubscriptions);
    outbox = new OutboxRepository(database);
    const dispatched: string[] = [];
    client.setMutationDefaults(['activity', 'complete'], {
      mutationFn: async (variables: unknown) => {
        dispatched.push((variables as { idempotencyKey: string }).idempotencyKey);
        return { activityId: ACTIVITY };
      },
    });

    await recoverAbandonedOutbox(transactions, outbox);
    const recovered = (await outbox.all()).find(
      (intent) => intent.intentId === 'abandoned',
    );
    if (abandonedBeforeRestart === undefined) {
      throw new Error('missing pre-restart abandoned intent fixture');
    }
    expect(recovered).toMatchObject({
      status: 'queued',
      attempts: 1,
      seq: originalSequence,
    });
    expect(recovered).toEqual({
      ...abandonedBeforeRestart,
      status: 'queued',
    });
    expect(recoveredListener).toHaveBeenCalledTimes(1);

    const sync = new SerializedNativeSyncEngine(
      OWNER,
      client,
      transactions,
      outbox,
      activities,
      agenda,
    );
    await sync.syncNow();
    sync.stop();

    expect(dispatched).toEqual(['abandoned', 'same-key-later', 'unrelated']);
    expect(await outbox.all()).toEqual([]);
  });

  it.each([
    {
      name: 'complete',
      expectedStatus: 'completed_occurrence',
      expectedSnoozed: 0,
      expectedTime: '09:00',
      project: async () =>
        transactions.run((transaction) =>
          service.complete(
            transaction,
            {
              activityId: ACTIVITY,
              idempotencyKey: 'occurrence-complete',
              input: { occurrenceDate: '2026-08-19' },
            },
            true,
            'scheduled',
            clock,
          ),
        ),
      response: (activity: Activity) => ({
        activity,
        occurrenceDate: '2026-08-19',
        occurrence: {
          activityId: ACTIVITY,
          date: '2026-08-19',
          status: 'completed' as const,
          completedAt: '2026-08-19T13:00:00.000Z',
        },
      }),
    },
    {
      name: 'skip',
      expectedStatus: 'skipped_occurrence',
      expectedSnoozed: 0,
      expectedTime: '09:00',
      project: async () =>
        transactions.run((transaction) =>
          service.skip(
            transaction,
            {
              activityId: ACTIVITY,
              idempotencyKey: 'occurrence-skip',
              input: { occurrenceDate: '2026-08-19' },
            },
            true,
            clock,
          ),
        ),
      response: (activity: Activity) => ({
        activity,
        occurrenceDate: '2026-08-19',
        occurrence: {
          activityId: ACTIVITY,
          date: '2026-08-19',
          status: 'skipped' as const,
        },
      }),
    },
    {
      name: 'snooze',
      expectedStatus: 'scheduled',
      expectedSnoozed: 1,
      expectedTime: '10:30',
      project: async () =>
        transactions.run((transaction) =>
          service.snooze(
            transaction,
            {
              activityId: ACTIVITY,
              idempotencyKey: 'occurrence-snooze',
              input: { occurrenceDate: '2026-08-19', until: '10:30' },
            },
            true,
            '2026-08-19',
            clock,
          ),
        ),
      response: (activity: Activity) => ({
        activity,
        occurrenceDate: '2026-08-19',
        occurrence: {
          activityId: ACTIVITY,
          date: '2026-08-19',
          status: 'snoozed' as const,
          snoozedUntil: '10:30',
        },
      }),
    },
    {
      name: 'unsnooze',
      expectedStatus: 'scheduled',
      expectedSnoozed: 0,
      expectedTime: '09:30',
      project: async () =>
        transactions.run((transaction) =>
          service.snooze(
            transaction,
            {
              activityId: ACTIVITY,
              idempotencyKey: 'occurrence-unsnooze',
              input: { occurrenceDate: '2026-08-19', until: '09:30' },
            },
            false,
            '2026-08-19',
            clock,
          ),
        ),
      response: (activity: Activity) => ({
        activity,
        occurrenceDate: '2026-08-19',
        occurrence: {
          activityId: ACTIVITY,
          date: '2026-08-19',
          status: 'rescheduled' as const,
          overrideTime: '09:30',
        },
      }),
    },
    {
      name: 'schedule',
      expectedStatus: 'scheduled',
      expectedSnoozed: 0,
      expectedTime: '11:00',
      project: async () =>
        transactions.run((transaction) =>
          service.schedule(
            transaction,
            {
              activityId: ACTIVITY,
              idempotencyKey: 'occurrence-schedule',
              input: {
                occurrenceDate: '2026-08-19',
                date: '2026-08-19',
                time: '11:00',
                timezone: 'UTC',
              },
            },
            clock,
          ),
        ),
      response: (activity: Activity) => ({
        activity,
        occurrence: {
          nominalDate: '2026-08-19',
          date: '2026-08-19',
          time: '11:00',
          status: 'scheduled' as const,
          isSnoozed: false,
        },
      }),
    },
  ])(
    'installs the canonical $name occurrence without changing the recurring series',
    async ({
      name,
      expectedStatus,
      expectedSnoozed,
      expectedTime,
      project,
      response,
    }) => {
      const activity = await seedRecurring();
      await project();
      client.setMutationDefaults(['activity', name], {
        mutationFn: async () => response(activity),
      });
      const sync = new SerializedNativeSyncEngine(
        OWNER,
        client,
        transactions,
        outbox,
        activities,
        agenda,
      );

      await sync.syncNow();
      sync.stop();

      expect(
        (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity
          .status,
      ).toBe('scheduled');
      expect(
        await database?.first(
          `SELECT status, is_snoozed, time, local_state
           FROM activity_occurrences WHERE activity_id = ? AND nominal_date = ?;`,
          [ACTIVITY, '2026-08-19'],
        ),
      ).toMatchObject({
        status: expectedStatus,
        is_snoozed: expectedSnoozed,
        time: expectedTime,
        local_state: 'canonical',
      });
      const day = (
        await agenda.read({ from: '2026-08-19', to: '2026-08-19', timezone: 'UTC' })
      ).days[0];
      const row = [
        ...(day?.schedule ?? []),
        ...(day?.anytime ?? []),
        ...(day?.earlier ?? []),
      ].find(
        (item) => item.activityId === ACTIVITY && item.occurrenceDate === '2026-08-19',
      );
      expect(row).toMatchObject({
        activityId: ACTIVITY,
        occurrenceDate: '2026-08-19',
        status: expectedStatus,
        isSnoozed: expectedSnoozed === 1,
      });
      expect(
        (
          await activities.read({
            kind: 'occurrence',
            activityId: ACTIVITY,
            date: '2026-08-19',
          })
        )?.occurrence,
      ).toMatchObject({
        status: expectedStatus,
        isSnoozed: expectedSnoozed === 1,
        time: expectedTime,
      });
      expect(await outbox.all()).toEqual([]);
    },
  );

  it('does not let an older occurrence response regress a newer dependent Undo', async () => {
    const activity = await seedRecurring();
    let releaseComplete: ((value: unknown) => void) | undefined;
    const completeResponse = new Promise<unknown>((resolve) => {
      releaseComplete = resolve;
    });
    client.setMutationDefaults(['activity', 'complete'], {
      mutationFn: async () => completeResponse,
    });
    client.setMutationDefaults(['activity', 'uncomplete'], {
      mutationFn: async () => ({ activity, occurrenceDate: '2026-08-19' }),
    });
    await transactions.run((transaction) =>
      service.complete(
        transaction,
        {
          activityId: ACTIVITY,
          idempotencyKey: 'older-complete',
          input: { occurrenceDate: '2026-08-19' },
        },
        true,
        'scheduled',
        clock,
      ),
    );
    const sync = new SerializedNativeSyncEngine(
      OWNER,
      client,
      transactions,
      outbox,
      activities,
      agenda,
    );
    const running = sync.syncNow();
    await vi.waitFor(async () =>
      expect(
        (await outbox.all()).find((intent) => intent.intentId === 'older-complete')
          ?.status,
      ).toBe('in_flight'),
    );
    await transactions.run((transaction) =>
      service.complete(
        transaction,
        {
          activityId: ACTIVITY,
          idempotencyKey: 'newer-undo',
          input: { occurrenceDate: '2026-08-19' },
        },
        false,
        'scheduled',
        clock,
        { originalIntentId: 'older-complete' },
      ),
    );
    releaseComplete?.({
      activity,
      occurrenceDate: '2026-08-19',
      occurrence: {
        activityId: ACTIVITY,
        date: '2026-08-19',
        status: 'completed',
        completedAt: '2026-08-19T13:00:00.000Z',
      },
    });
    await running;
    sync.stop();

    expect(
      await database?.first(
        `SELECT status, local_state FROM activity_occurrences
         WHERE activity_id = ? AND nominal_date = ?;`,
        [ACTIVITY, '2026-08-19'],
      ),
    ).toMatchObject({ status: 'scheduled', local_state: 'canonical' });
    expect(await outbox.all()).toEqual([]);
  });

  it('does not let a later series-field acknowledgement overwrite canonical occurrence status', async () => {
    const activity = await seedRecurring();
    await transactions.run(async (transaction) => {
      await service.complete(
        transaction,
        {
          activityId: ACTIVITY,
          idempotencyKey: 'already-canonical-complete',
          input: { occurrenceDate: '2026-08-19' },
        },
        true,
        'scheduled',
        clock,
      );
      await transaction.database.run('DELETE FROM outbox_intents;');
      await transaction.database.run(
        "UPDATE activity_occurrences SET local_state = 'canonical';",
      );
      await transaction.database.run("UPDATE agenda_rows SET local_state = 'canonical';");
      await service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'series-title-edit',
        input: { title: 'Renamed series' },
        ifMatch: activity.updatedAt,
      });
    });
    client.setMutationDefaults(['activity', 'patch'], {
      mutationFn: async () => ({
        ...activity,
        title: 'Renamed series',
        updatedAt: '2026-08-19T14:00:00.000Z',
      }),
    });
    const sync = new SerializedNativeSyncEngine(
      OWNER,
      client,
      transactions,
      outbox,
      activities,
      agenda,
    );

    await sync.syncNow();
    sync.stop();

    const day = (
      await agenda.read({ from: '2026-08-19', to: '2026-08-19', timezone: 'UTC' })
    ).days[0];
    expect([...(day?.schedule ?? []), ...(day?.earlier ?? [])]).toContainEqual(
      expect.objectContaining({
        activityId: ACTIVITY,
        occurrenceDate: '2026-08-19',
        title: 'Renamed series',
        status: 'completed_occurrence',
      }),
    );
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
