import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '@od/shared/client';
import type { Activity } from '@od/shared/types';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';
import type { ActivityPullAdapter } from '../sync/pullAdapter';
import type { ActivityPushTransport } from '../sync/pushAdapter';
import type { TargetedAgendaTransport } from '../sync/reconciliation';
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

  function executeDefault(name: string, variables: unknown): Promise<unknown> {
    const key = ['activity', name] as const;
    const defaults = client.getMutationDefaults(key);
    if (typeof defaults.mutationFn !== 'function') {
      throw new Error(`missing test mutation ${name}`);
    }
    return client
      .getMutationCache()
      .build(client, { ...defaults, mutationKey: key })
      .execute(variables);
  }

  function pushTransport(): ActivityPushTransport {
    const post = (name: string, activityId: string, input: unknown, key: string) =>
      executeDefault(name, { activityId, input, idempotencyKey: key });
    return {
      create: (input, idempotencyKey) =>
        executeDefault('create', { input, idempotencyKey }),
      duplicate: (activityId, idempotencyKey) =>
        executeDefault('duplicate', { activityId, idempotencyKey }),
      remove: (activityId) =>
        executeDefault('delete', { activityId, intentId: 'test-delete' }),
      patch: (activityId, input, ifMatch) =>
        executeDefault('patch', {
          activityId,
          input,
          ifMatch,
          intentId: 'test-patch',
          changeNames: [],
        }),
      convertRecurrence: (activityId, selectedDate, idempotencyKey) =>
        executeDefault('convert-recurrence', {
          activityId,
          input: { selectedDate },
          idempotencyKey,
        }),
      schedule: (activityId, input, idempotencyKey) =>
        post('schedule', activityId, input, idempotencyKey),
      complete: (activityId, input, idempotencyKey) =>
        post('complete', activityId, input, idempotencyKey),
      uncomplete: (activityId, input, idempotencyKey) =>
        post('uncomplete', activityId, input, idempotencyKey),
      skip: (activityId, input, idempotencyKey) =>
        post('skip', activityId, input, idempotencyKey),
      snooze: (activityId, input, idempotencyKey) =>
        post('snooze', activityId, input, idempotencyKey),
      unsnooze: (activityId, input, idempotencyKey) =>
        post('unsnooze', activityId, input, idempotencyKey),
      createReminder: (activityId, input, idempotencyKey) =>
        post('reminder-create', activityId, input, idempotencyKey),
      deleteReminder: (activityId, reminderId) =>
        executeDefault('reminder-delete', {
          activityId,
          reminderId,
          intentId: 'test-reminder-delete',
        }),
    };
  }

  function pullAdapter(): ActivityPullAdapter {
    return {
      agenda: (request) =>
        agenda.read({
          from: request.from,
          to: request.to,
          timezone: request.tz,
          ...(request.include === undefined ? {} : { include: request.include }),
        }),
      activity: async (target) => {
        const detail = await activities.read(target);
        if (detail === undefined) throw new Error('missing test activity');
        return detail;
      },
      profile: async () => ({
        userId: OWNER,
        displayName: 'Owner',
        timezone: 'UTC',
        currency: 'USD',
        weekStartsOn: 0,
        createdAt: '2026-08-19T00:00:00.000Z',
        updatedAt: '2026-08-19T00:00:00.000Z',
        schemaVersion: 1,
      }),
    };
  }

  function targetedTransport(): TargetedAgendaTransport {
    return {
      load: async (activityId, request) => {
        const [data, detail] = await Promise.all([
          pullAdapter().agenda(request),
          activities.read({ kind: 'activity', activityId }),
        ]);
        if (detail === undefined) throw new Error('missing targeted test activity');
        return {
          activityId,
          activityVersion: detail.activity.updatedAt,
          rows: data.days.flatMap((day) =>
            [...day.schedule, ...day.anytime, ...day.earlier]
              .filter((item) => item.activityId === activityId)
              .map((item) => ({ date: day.date, item })),
          ),
        };
      },
    };
  }

  function syncEngine(
    overrides: {
      readonly push?: ActivityPushTransport;
      readonly pull?: ActivityPullAdapter;
      readonly targeted?: TargetedAgendaTransport;
    } = {},
  ): SerializedNativeSyncEngine {
    return new SerializedNativeSyncEngine(
      transactions,
      outbox,
      activities,
      agenda,
      overrides.push ?? pushTransport(),
      overrides.pull ?? pullAdapter(),
      overrides.targeted ?? targetedTransport(),
    );
  }

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

    const sync = syncEngine();
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
      const sync = syncEngine();

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

  it('acknowledges a contract-breaking occurrence response once and still installs the activity result', async () => {
    const activity = await seedRecurring();
    await transactions.run((transaction) =>
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
    );
    const projectedRow = await database?.first(
      'SELECT status FROM agenda_rows WHERE activity_id = ? AND occurrence_date = ?;',
      [ACTIVITY, '2026-08-19'],
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let dispatched = 0;
    client.setMutationDefaults(['activity', 'complete'], {
      mutationFn: async () => {
        dispatched += 1;
        return {
          activity: { ...activity, title: 'Server title' },
          occurrenceDate: '2026-08-19',
          occurrence: { malformed: true },
        };
      },
    });
    const sync = syncEngine();

    await sync.syncNow();
    sync.stop();

    expect(dispatched).toBe(1);
    expect(await outbox.all()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'outbox_response_contract_mismatch',
      'activity.complete',
      expect.any(String),
    );
    expect(
      await database?.first(
        'SELECT title, local_state FROM activities WHERE activity_id = ?;',
        [ACTIVITY],
      ),
    ).toMatchObject({ title: 'Server title', local_state: 'canonical' });
    expect(
      await database?.first(
        `SELECT status, local_state FROM agenda_rows
         WHERE activity_id = ? AND occurrence_date = ?;`,
        [ACTIVITY, '2026-08-19'],
      ),
    ).toMatchObject({ status: projectedRow?.status, local_state: 'canonical' });
    warn.mockRestore();
  });

  it('acknowledges without installing when the contract-breaking response names another entity', async () => {
    const activity = await seedRecurring();
    await transactions.run((transaction) =>
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
    );
    const projectedRow = await database?.first(
      'SELECT status FROM agenda_rows WHERE activity_id = ? AND occurrence_date = ?;',
      [ACTIVITY, '2026-08-19'],
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let dispatched = 0;
    client.setMutationDefaults(['activity', 'complete'], {
      mutationFn: async () => {
        dispatched += 1;
        return {
          activity: { ...activity, activityId: OTHER, title: 'Foreign activity' },
          occurrenceDate: '2026-08-19',
          occurrence: { malformed: true },
        };
      },
    });
    const sync = syncEngine();

    await sync.syncNow();
    sync.stop();

    expect(dispatched).toBe(1);
    expect(await outbox.all()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'outbox_response_contract_mismatch',
      'activity.complete',
      expect.any(String),
    );
    expect(
      await database?.first(
        'SELECT COUNT(*) AS count FROM activities WHERE activity_id = ?;',
        [OTHER],
      ),
    ).toMatchObject({ count: 0 });
    expect(
      await database?.first('SELECT title FROM activities WHERE activity_id = ?;', [
        ACTIVITY,
      ]),
    ).toMatchObject({ title: 'Recurring task' });
    expect(
      await database?.first(
        `SELECT status, local_state FROM agenda_rows
         WHERE activity_id = ? AND occurrence_date = ?;`,
        [ACTIVITY, '2026-08-19'],
      ),
    ).toMatchObject({ status: projectedRow?.status, local_state: 'queued' });
    warn.mockRestore();
  });

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
    const sync = syncEngine();
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
    const sync = syncEngine();

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
    const sync = syncEngine();
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
    const sync = syncEngine();
    await transactions.run((transaction) =>
      service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'offline-edit',
        input: { title: 'Kept while offline' },
        ifMatch: 'v1',
      }),
    );

    await expect(sync.syncNow()).rejects.toThrow('offline');
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

  it('lets an unrelated ordering key converge behind a transiently blocked key', async () => {
    const calls: string[] = [];
    const base = pushTransport();
    const push: ActivityPushTransport = {
      ...base,
      patch: async (activityId) => {
        calls.push(activityId);
        if (activityId === ACTIVITY) throw new Error('first key offline');
        return undefined;
      },
    };
    await transactions.run(async (transaction) => {
      await service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'blocked-first',
        input: { title: 'Still local' },
        ifMatch: 'v1',
      });
      await outbox.append(transaction.database, {
        intentId: 'unrelated-second',
        mutationKey: ['activity', 'patch'],
        variables: {
          activityId: OTHER,
          input: { title: 'Independent' },
          ifMatch: 'v1',
        },
        entityId: OTHER,
      });
    });
    const sync = syncEngine({ push });

    await expect(sync.syncNow()).rejects.toThrow('first key offline');
    sync.stop();

    expect(calls).toEqual([ACTIVITY, OTHER]);
    expect((await outbox.all()).map((intent) => intent.intentId)).toEqual([
      'blocked-first',
    ]);
  });

  it('parks a permanent rejection structurally without rolling back its projection', async () => {
    await transactions.run((transaction) =>
      service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'rejected-edit',
        input: { title: 'Kept but blocked' },
        ifMatch: 'v1',
      }),
    );
    const push = {
      ...pushTransport(),
      patch: async () => {
        throw new ApiError('validation_failed', 'Rejected title', 422, 'req_1', [
          { path: 'title', message: 'Rejected title' },
        ]);
      },
    };
    const sync = syncEngine({ push });

    await expect(sync.syncNow()).rejects.toThrow('Rejected title');
    sync.stop();

    expect((await outbox.all())[0]).toMatchObject({
      intentId: 'rejected-edit',
      status: 'needs_attention',
      attention: {
        kind: 'rejected',
        status: 422,
        code: 'validation_failed',
        details: [{ path: 'title', message: 'Rejected title' }],
      },
    });
    expect(
      await database?.first(
        'SELECT title, local_state FROM activities WHERE activity_id = ?;',
        [ACTIVITY],
      ),
    ).toMatchObject({ title: 'Kept but blocked', local_state: 'needs_attention' });
  });

  it('recovers a lost create response by stable identity without redispatching', async () => {
    await transactions.run((transaction) =>
      service.create(
        transaction,
        OWNER,
        {
          input: {
            activityId: OTHER,
            objectKind: 'task',
            type: 'task',
            title: 'Created once',
          },
          idempotencyKey: 'lost-create',
        },
        clock,
        '2026-08-19T01:00:00.000Z',
      ),
    );
    const local = await activities.read({ kind: 'activity', activityId: OTHER });
    if (local === undefined) throw new Error('missing local create fixture');
    const create = vi.fn(async () => {
      throw new ApiError('conflict', 'Already exists', 409, 'req_create');
    });
    const detail = vi.fn(async () => ({
      ...local,
      activity: {
        ...local.activity,
        updatedAt: '2026-08-19T02:00:00.000Z',
      },
    }));
    const sync = syncEngine({
      push: { ...pushTransport(), create },
      pull: { ...pullAdapter(), activity: detail },
    });

    await sync.syncNow();
    sync.stop();

    expect(create).toHaveBeenCalledTimes(1);
    expect(detail).toHaveBeenCalledWith({ kind: 'activity', activityId: OTHER });
    expect(
      (await outbox.all()).find((intent) => intent.intentId === 'lost-create'),
    ).toBeUndefined();
    expect(
      (await activities.read({ kind: 'activity', activityId: OTHER }))?.activity
        .updatedAt,
    ).toBe('2026-08-19T02:00:00.000Z');
  });

  it('coalesces foreground, reconnect and manual requests into one in-flight pull', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agendaPull = vi.fn(
      async (request: Parameters<ActivityPullAdapter['agenda']>[0]) => {
        await pending;
        return pullAdapter().agenda(request);
      },
    );
    const pull = { ...pullAdapter(), agenda: agendaPull };
    const sync = syncEngine({ pull });

    sync.request('foreground');
    await vi.waitFor(() => expect(agendaPull).toHaveBeenCalledTimes(1));
    sync.request('connectivity');
    const manual = sync.syncNow();
    release?.();
    await manual;
    sync.stop();

    expect(agendaPull).toHaveBeenCalledTimes(1);
  });

  it('runs a second bounded pull for coverage registered after the active snapshot', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const agendaPull = vi.fn(
      async (request: Parameters<ActivityPullAdapter['agenda']>[0]) => {
        calls += 1;
        if (calls === 1) await pending;
        return pullAdapter().agenda(request);
      },
    );
    const sync = syncEngine({ pull: { ...pullAdapter(), agenda: agendaPull } });

    sync.request('foreground');
    await vi.waitFor(() => expect(agendaPull).toHaveBeenCalledTimes(1));
    const laterCoverage = sync.pullAgenda({
      from: '2026-08-20',
      to: '2026-08-20',
      tz: 'UTC',
    });
    release?.();

    await laterCoverage;
    sync.stop();
    /* The follow-up pass refreshes the known window and includes the newly queued one. */
    expect(agendaPull).toHaveBeenCalledTimes(3);
    expect(agendaPull).toHaveBeenLastCalledWith({
      from: '2026-08-20',
      to: '2026-08-20',
      tz: 'UTC',
    });
  });

  it('reports one in-flight pull failure to every concurrent manual caller', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agendaPull = vi.fn(async () => {
      await pending;
      throw new Error('offline together');
    });
    const sync = syncEngine({ pull: { ...pullAdapter(), agenda: agendaPull } });

    const first = sync.syncNow();
    await vi.waitFor(() => expect(agendaPull).toHaveBeenCalledTimes(1));
    const second = sync.syncNow();
    release?.();

    await expect(first).rejects.toThrow('offline together');
    await expect(second).rejects.toThrow('offline together');
    sync.stop();
  });

  it('rejects stale projection versions and applies only covered authoritative absence', async () => {
    const coverage = { from: '2026-08-19', to: '2026-08-19', timezone: 'UTC' };
    const current = await agenda.read(coverage);
    const item = current.days[0]?.anytime[0];
    if (item === undefined) throw new Error('missing agenda projection fixture');
    await database?.run(
      `UPDATE agenda_rows SET title = 'Newer title', canonical_version = ?
       WHERE activity_id = ?;`,
      ['2026-08-19T12:00:00.000Z', ACTIVITY],
    );
    await transactions.run((transaction) =>
      agenda.installCanonical(
        transaction,
        { from: coverage.from, to: coverage.to, tz: coverage.timezone },
        {
          days: [
            {
              date: coverage.from,
              schedule: [],
              anytime: [{ ...item, title: 'Stale title' }],
              earlier: [],
            },
          ],
          warnings: [],
          projectionVersions: [
            { activityId: ACTIVITY, version: '2026-08-19T11:00:00.000Z' },
          ],
        },
      ),
    );
    expect(
      await database?.first('SELECT title FROM agenda_rows WHERE activity_id = ?;', [
        ACTIVITY,
      ]),
    ).toMatchObject({ title: 'Newer title' });

    await transactions.run((transaction) =>
      agenda.installCanonical(
        transaction,
        { from: coverage.from, to: coverage.to, tz: coverage.timezone },
        {
          days: [{ date: coverage.from, schedule: [], anytime: [], earlier: [] }],
          warnings: [],
        },
      ),
    );
    expect(
      await database?.all('SELECT * FROM agenda_rows WHERE activity_id = ?;', [ACTIVITY]),
    ).toEqual([]);

    await database?.run(
      'INSERT INTO activity_tombstones (activity_id, acknowledged_at) VALUES (?, ?);',
      [ACTIVITY, '2026-08-19T13:00:00.000Z'],
    );
    await transactions.run((transaction) =>
      agenda.installCanonical(
        transaction,
        { from: coverage.from, to: coverage.to, tz: coverage.timezone },
        current,
      ),
    );
    expect(
      await database?.all('SELECT * FROM agenda_rows WHERE activity_id = ?;', [ACTIVITY]),
    ).toEqual([]);
  });

  it('applies an authoritative detail tombstone without returning an uninstalled body', async () => {
    const activity = vi.fn(async () => {
      throw new ApiError('not_found', 'Gone', 404, 'req_gone');
    });
    const sync = syncEngine({ pull: { ...pullAdapter(), activity } });

    await expect(
      sync.pullActivity({ kind: 'activity', activityId: ACTIVITY }),
    ).rejects.toThrow('Gone');
    sync.stop();

    expect(activity).toHaveBeenCalledTimes(1);
    expect(
      await activities.read({ kind: 'activity', activityId: ACTIVITY }),
    ).toBeUndefined();
    expect(
      await database?.first(
        'SELECT activity_id FROM activity_tombstones WHERE activity_id = ?;',
        [ACTIVITY],
      ),
    ).toMatchObject({ activity_id: ACTIVITY });
  });

  it('retains recurrence rows and receipt on targeted failure, then accepts zero rows on Retry', async () => {
    const activity = await seedRecurring();
    await transactions.run((transaction) =>
      service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'recurrence-change',
        input: {
          recurrence: {
            mode: 'fixed',
            segments: [
              {
                freq: 'weekly',
                interval: 1,
                byWeekday: [3],
                effectiveFrom: '2026-08-19',
              },
            ],
          },
        },
        ifMatch: activity.updatedAt,
      }),
    );
    const acknowledged = {
      ...activity,
      updatedAt: '2026-08-19T12:00:00.000Z',
    };
    const push = {
      ...pushTransport(),
      patch: async () => acknowledged,
    };
    const failedTarget = vi.fn(async () => {
      throw new Error('targeted read offline');
    });
    const first = syncEngine({ push, targeted: { load: failedTarget } });

    await expect(first.syncNow()).rejects.toThrow("Couldn't refresh schedule");
    first.stop();
    expect(
      await database?.first(
        'SELECT local_state FROM agenda_rows WHERE activity_id = ? LIMIT 1;',
        [ACTIVITY],
      ),
    ).toMatchObject({ local_state: 'updating' });
    expect((await outbox.all())[0]).toMatchObject({
      intentId: 'recurrence-change',
      status: 'acknowledged',
      reconciliationVersion: acknowledged.updatedAt,
      lastError: 'targeted read offline',
    });
    expect(
      await agenda.syncError({
        from: '2026-08-19',
        to: '2026-08-19',
        timezone: 'UTC',
      }),
    ).toBe('targeted read offline');

    const zeroTarget = vi.fn(async () => ({
      activityId: ACTIVITY,
      activityVersion: acknowledged.updatedAt,
      rows: [],
    }));
    const retry = syncEngine({ push, targeted: { load: zeroTarget } });
    await retry.syncNow();
    retry.stop();

    expect(zeroTarget).toHaveBeenCalledTimes(1);
    expect(
      await database?.all('SELECT * FROM agenda_rows WHERE activity_id = ?;', [ACTIVITY]),
    ).toEqual([]);
    expect(
      (await outbox.all()).find((intent) => intent.intentId === 'recurrence-change'),
    ).toBeUndefined();
    expect(
      await agenda.syncError({
        from: '2026-08-19',
        to: '2026-08-19',
        timezone: 'UTC',
      }),
    ).toBeUndefined();
  });
});
