import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateActivityInput } from '@od/shared/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planFromCommittedRows } from '@/features/reminders/localSchedule.native';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';
import { NativeActivityActionCoordinator } from './actionCoordinator';
import { ActivityRepository } from './activityRepository';
import { ActivityTransactionService } from './activityTransactions';
import { AgendaRepository } from './agendaRepository';
import type { SqliteDatabase } from './database';
import { FOUNDATION_MIGRATIONS, runMigrations } from './migrations';
import { setActiveNativeState } from './nativeState';
import { OutboxRepository } from './outbox';
import { RepositorySubscriptions } from './subscriptions';
import type { NativeSyncEngine } from './syncEngine';
import { SerializedTransactionRunner } from './transaction';

const OWNER = 'usr_01J0000000000000000000000A';
const ACTIVITY = 'act_01J0000000000000000000000A';
const OTHER = 'act_01J0000000000000000000000B';
const REMINDER = 'rem_01J0000000000000000000000A';
const clock = { today: '2026-08-19', currentMinute: '08:00' };

function createInput(activityId = ACTIVITY): CreateActivityInput {
  return {
    activityId,
    objectKind: 'task',
    type: 'task',
    title: 'Offline daily task',
    schedule: { date: '2026-08-19', time: '09:00', timezone: 'America/New_York' },
    recurrence: {
      mode: 'fixed',
      segments: [{ freq: 'daily', interval: 1, effectiveFrom: '2026-08-19' }],
    },
    reminders: [{ reminderId: REMINDER, offsetMinutes: -10 }],
  };
}

describe('Activity/Agenda transactional SQLite slice', () => {
  let directory = '';
  let database: SqliteDatabase | undefined;
  let subscriptions: RepositorySubscriptions;
  let transactions: SerializedTransactionRunner;
  let activities: ActivityRepository;
  let agenda: AgendaRepository;
  let outbox: OutboxRepository;
  let service: ActivityTransactionService;
  let request: ReturnType<typeof vi.fn>;
  let coordinator: NativeActivityActionCoordinator;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ordinarydays-p2-62-'));
    database = await createNodeSqliteFactory(directory).open('slice.sqlite');
    await runMigrations(database, FOUNDATION_MIGRATIONS);
    await database.run(
      `INSERT INTO agenda_coverage
        (from_date, to_date, timezone, include_key, refreshed_at, warnings_json)
       VALUES (?, ?, ?, '', ?, '[]');`,
      ['2026-08-19', '2026-08-21', 'America/New_York', '2026-08-19T00:00:00Z'],
    );
    subscriptions = new RepositorySubscriptions();
    transactions = new SerializedTransactionRunner(database, subscriptions);
    activities = new ActivityRepository(database, subscriptions);
    agenda = new AgendaRepository(database, subscriptions);
    outbox = new OutboxRepository(database);
    service = new ActivityTransactionService(outbox, activities, agenda);
    request = vi.fn();
    const sync: NativeSyncEngine = {
      request,
      syncNow: async () => undefined,
      pullActivity: async () => {
        throw new Error('not used');
      },
      pullAgenda: async () => ({ days: [], warnings: [] }),
      pullReminderCoverage: async () => undefined,
      stop: () => undefined,
    };
    coordinator = new NativeActivityActionCoordinator(
      OWNER,
      transactions,
      service,
      outbox,
      sync,
    );
  });

  afterEach(async () => {
    setActiveNativeState(undefined);
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('arms an offline-created reminder exclusively from committed SQLite state', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    const sync: NativeSyncEngine = {
      request,
      syncNow: async () => undefined,
      pullActivity: async () => {
        throw new Error('not used');
      },
      pullAgenda: async () => ({ days: [], warnings: [] }),
      pullReminderCoverage: async () => undefined,
      stop: () => undefined,
    };
    setActiveNativeState({
      account: {
        accountNamespace: OWNER,
        filename: 'slice.sqlite',
        database,
        subscriptions,
        transactions,
      },
      activities,
      agenda,
      outbox,
      coordinator,
      sync,
    });
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'offline-reminder-create' },
      clock,
    );

    const plan = await planFromCommittedRows();

    expect(plan.requests.length).toBeGreaterThan(0);
    expect(
      plan.requests.every((notification) => notification.identifier.includes(REMINDER)),
    ).toBe(true);
  });

  it('commits the outbox, visible rows and reminder notification together, then reopens identically', async () => {
    const activityListener = vi.fn();
    const agendaListener = vi.fn();
    const reminderListener = vi.fn();
    subscriptions.subscribe(`activity:${ACTIVITY}`, activityListener);
    subscriptions.subscribe('agenda', agendaListener);
    subscriptions.subscribe('reminders', reminderListener);

    const accepted = await coordinator.create(
      { input: createInput(), idempotencyKey: 'create-one' },
      clock,
    );

    expect(accepted.kind).toBe('accepted');
    expect(await outbox.all()).toHaveLength(1);
    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity.title,
    ).toBe('Offline daily task');
    const materialized = await agenda.read({
      from: '2026-08-19',
      to: '2026-08-21',
      timezone: 'America/New_York',
    });
    expect(
      materialized.days.flatMap((day) => day.schedule).map((row) => row.occurrenceDate),
    ).toEqual(['2026-08-19', '2026-08-20', '2026-08-21']);
    expect(activityListener).toHaveBeenCalledTimes(1);
    expect(agendaListener).toHaveBeenCalledTimes(1);
    expect(reminderListener).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);

    await database?.close();
    database = await createNodeSqliteFactory(directory).open('slice.sqlite');
    activities = new ActivityRepository(database, subscriptions);
    outbox = new OutboxRepository(database);
    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity
        .status,
    ).toBe('scheduled');
    expect((await outbox.all()).map((intent) => intent.intentId)).toEqual(['create-one']);
  });

  it('rolls back both halves and publishes nothing when acceptance is interrupted', async () => {
    const listener = vi.fn();
    subscriptions.subscribe('agenda', listener);
    await expect(
      transactions.run(async (transaction) => {
        await service.create(
          transaction,
          OWNER,
          { input: createInput(), idempotencyKey: 'interrupted' },
          clock,
        );
        throw new Error('simulated append/projection failure');
      }),
    ).rejects.toThrow('simulated append/projection failure');

    expect(await database?.all('SELECT * FROM activities;')).toEqual([]);
    expect(await database?.all('SELECT * FROM agenda_rows;')).toEqual([]);
    expect(await database?.all('SELECT * FROM outbox_intents;')).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('refuses a conflicting idempotent append without changing rows or sending a request', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'reused-id' },
      clock,
    );
    const before = await agenda.read({
      from: '2026-08-19',
      to: '2026-08-21',
      timezone: 'America/New_York',
    });
    const refused = await coordinator.create(
      {
        input: { ...createInput(), title: 'Conflicting reuse' },
        idempotencyKey: 'reused-id',
      },
      clock,
    );

    expect(refused.kind).toBe('refused');
    expect(
      await agenda.read({
        from: '2026-08-19',
        to: '2026-08-21',
        timezone: 'America/New_York',
      }),
    ).toEqual(before);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('makes repeated triggers idempotent and preserves per-entity barriers without globally blocking', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'same-create' },
      clock,
    );
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'same-create' },
      clock,
    );
    await transactions.run(async (transaction) => {
      await outbox.append(transaction.database, {
        intentId: 'same-entity-later',
        mutationKey: ['activity', 'complete'],
        variables: { activityId: ACTIVITY },
        entityId: ACTIVITY,
      });
      await outbox.append(transaction.database, {
        intentId: 'other-entity',
        mutationKey: ['activity', 'complete'],
        variables: { activityId: OTHER },
        entityId: OTHER,
      });
    });

    expect(await database?.all('SELECT activity_id FROM activities;')).toEqual([
      { activity_id: ACTIVITY },
    ]);
    const first = await transactions.run(({ database: transaction }) =>
      outbox.claimNext(transaction),
    );
    const second = await transactions.run(({ database: transaction }) =>
      outbox.claimNext(transaction),
    );
    expect(first?.intentId).toBe('same-create');
    expect(second?.intentId).toBe('other-entity');
    expect((await outbox.all()).map((intent) => intent.intentId)).toEqual([
      'same-create',
      'same-entity-later',
      'other-entity',
    ]);
  });

  it('cancels a queued completion and its projection atomically during Undo', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'create-before-complete' },
      clock,
    );
    await transactions.run(async (transaction) => {
      await outbox.acknowledge(transaction.database, 'create-before-complete');
    });
    await coordinator.complete(ACTIVITY, 'complete-one', {}, true, 'scheduled', clock);
    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity
        .status,
    ).toBe('completed');

    const undone = await coordinator.undoCompletion(
      'complete-one',
      { activityId: ACTIVITY, idempotencyKey: 'undo-one', input: {} },
      false,
      'scheduled',
      clock,
    );
    expect(undone.kind).toBe('cancelled');
    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity
        .status,
    ).toBe('scheduled');
    expect(
      (await outbox.all()).some((intent) => intent.intentId === 'complete-one'),
    ).toBe(false);
  });

  it('stores a dependent inverse when Complete is already in flight and preserves wire order', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'create-for-racing-undo' },
      clock,
    );
    await transactions.run(async (transaction) => {
      await outbox.acknowledge(transaction.database, 'create-for-racing-undo');
    });
    await coordinator.complete(ACTIVITY, 'racing-complete', {}, true, 'scheduled', clock);
    const claimed = await transactions.run(({ database: transaction }) =>
      outbox.claimNext(transaction),
    );
    expect(claimed?.intentId).toBe('racing-complete');

    const undo = await coordinator.undoCompletion(
      'racing-complete',
      { activityId: ACTIVITY, idempotencyKey: 'racing-undo', input: {} },
      false,
      'scheduled',
      clock,
    );
    expect(undo.kind).toBe('accepted');
    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity
        .status,
    ).toBe('scheduled');
    expect(
      await transactions.run(({ database: transaction }) =>
        outbox.claimNext(transaction),
      ),
    ).toBeUndefined();

    await transactions.run(async (transaction) => {
      await outbox.acknowledge(transaction.database, 'racing-complete');
    });
    expect(
      (
        await transactions.run(({ database: transaction }) =>
          outbox.claimNext(transaction),
        )
      )?.intentId,
    ).toBe('racing-undo');
  });

  it('projects edit and one-occurrence reschedule into Activity detail and Agenda consistently', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'create-for-edit' },
      clock,
    );
    await coordinator.patch(
      ACTIVITY,
      'title-edit',
      { title: 'Edited offline' },
      '2026-08-19T00:00:00Z',
    );
    await coordinator.schedule(
      ACTIVITY,
      'occurrence-move',
      {
        occurrenceDate: '2026-08-20',
        date: '2026-08-21',
        time: '10:30',
        timezone: 'America/New_York',
      },
      clock,
    );

    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity.title,
    ).toBe('Edited offline');
    expect(
      (
        await activities.read({
          kind: 'occurrence',
          activityId: ACTIVITY,
          date: '2026-08-20',
        })
      )?.occurrence,
    ).toMatchObject({ date: '2026-08-21', time: '10:30' });
    const rows = (
      await agenda.read({
        from: '2026-08-19',
        to: '2026-08-21',
        timezone: 'America/New_York',
      })
    ).days.flatMap((day) => day.schedule.map((item) => ({ date: day.date, item })));
    expect(rows.every(({ item }) => item.title === 'Edited offline')).toBe(true);
    expect(rows.find(({ item }) => item.occurrenceDate === '2026-08-20')).toMatchObject({
      date: '2026-08-21',
      item: { time: '10:30' },
    });
  });

  it('records an offline manual-refresh error without clearing Today', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'create-before-refresh' },
      clock,
    );
    const coverage = {
      from: '2026-08-19',
      to: '2026-08-21',
      timezone: 'America/New_York',
    };
    const before = await agenda.read(coverage);
    await transactions.run((transaction) =>
      agenda.recordSyncError(transaction, coverage, 'offline'),
    );

    expect(await agenda.read(coverage)).toEqual(before);
    expect(await agenda.syncError(coverage)).toBe('offline');
  });

  it('retains canonical recurrence rows and marks them updating for an existing-series edit', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'series-create' },
      clock,
    );
    await transactions.run(async (transaction) => {
      await transaction.database.run("UPDATE activities SET local_state = 'canonical';");
      await transaction.database.run("UPDATE agenda_rows SET local_state = 'canonical';");
      await transaction.database.run('DELETE FROM outbox_intents;');
    });
    const before = await database?.all(
      'SELECT row_id FROM agenda_rows WHERE activity_id = ? ORDER BY row_id;',
      [ACTIVITY],
    );

    const result = await coordinator.patch(
      ACTIVITY,
      'recurrence-edit',
      {
        recurrence: {
          mode: 'fixed',
          segments: [{ freq: 'weekly', interval: 1, effectiveFrom: '2026-08-19' }],
        },
        editedFromDate: '2026-08-19',
      },
      '2026-08-19T00:00:00Z',
    );

    expect(result.kind).toBe('accepted');
    expect(
      await database?.all(
        'SELECT row_id FROM agenda_rows WHERE activity_id = ? ORDER BY row_id;',
        [ACTIVITY],
      ),
    ).toEqual(before);
    expect(
      await database?.all(
        'SELECT DISTINCT local_state FROM agenda_rows WHERE activity_id = ?;',
        [ACTIVITY],
      ),
    ).toEqual([{ local_state: 'updating' }]);
  });
});
