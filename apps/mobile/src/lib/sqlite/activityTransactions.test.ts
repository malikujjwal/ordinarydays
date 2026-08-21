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
import type { OutboxPresentationStore } from './outboxPresentationStore';
import { RepositorySubscriptions } from './subscriptions';
import type { NativeSyncEngine } from './syncEngine';
import { SerializedTransactionRunner } from './transaction';

const OWNER = 'usr_01J0000000000000000000000A';
const ACTIVITY = 'act_01J0000000000000000000000A';
const OTHER = 'act_01J0000000000000000000000B';
const THIRD = 'act_01J0000000000000000000000C';
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
  let sync: NativeSyncEngine;

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
    sync = {
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
      sessionId: 'activity-transactions-reminder-session',
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
      outboxPresentation: {} as OutboxPresentationStore,
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

  it('keeps canonical_version server-authored across local creation and mutations', async () => {
    await transactions.run((transaction) =>
      service.create(
        transaction,
        OWNER,
        { input: createInput(), idempotencyKey: 'canonical-version-create' },
        clock,
        '2026-08-19T23:00:00.000Z',
      ),
    );
    expect(
      await database?.first(
        'SELECT canonical_version FROM activities WHERE activity_id = ?;',
        [ACTIVITY],
      ),
    ).toEqual({ canonical_version: null });

    const local = await activities.read({ kind: 'activity', activityId: ACTIVITY });
    if (local === undefined) throw new Error('missing local canonical-version fixture');
    const canonicalVersion = '2026-08-19T02:00:00.000Z';
    const canonical = {
      ...local,
      activity: {
        ...local.activity,
        title: 'Server title',
        updatedAt: canonicalVersion,
      },
      capabilities: { complete: true, skip: true, snooze: true },
    };
    await transactions.run(async (transaction) => {
      await activities.installAcknowledgedActivity(
        transaction,
        canonical.activity,
        canonical,
      );
      await transaction.database.run('DELETE FROM outbox_intents;');
      transaction.changed('outbox');
    });

    const expectCanonicalVersion = async () =>
      expect(
        await database?.first(
          'SELECT canonical_version FROM activities WHERE activity_id = ?;',
          [ACTIVITY],
        ),
      ).toEqual({ canonical_version: canonicalVersion });
    await expectCanonicalVersion();

    await transactions.run((transaction) =>
      activities.patchLocal(
        transaction,
        ACTIVITY,
        { title: 'Local patch', recurrence: null },
        'queued',
      ),
    );
    await expectCanonicalVersion();
    await transactions.run((transaction) =>
      activities.scheduleLocal(transaction, ACTIVITY, {
        date: '2026-08-20',
        time: '10:00',
        timezone: 'America/New_York',
      }),
    );
    await expectCanonicalVersion();
    await transactions.run((transaction) =>
      activities.setStatusLocal(
        transaction,
        ACTIVITY,
        'completed',
        'done',
        '2026-08-20T14:00:00.000Z',
      ),
    );
    await expectCanonicalVersion();
    await transactions.run((transaction) =>
      activities.setLocalState(transaction, ACTIVITY, 'needs_attention'),
    );
    await expectCanonicalVersion();

    await transactions.run((transaction) =>
      transaction.database.run(
        "UPDATE activities SET local_state = 'canonical' WHERE activity_id = ?;",
        [ACTIVITY],
      ),
    );
    const older = {
      ...canonical,
      activity: {
        ...canonical.activity,
        title: 'Genuinely stale server title',
        updatedAt: '2026-08-19T01:00:00.000Z',
      },
    };
    await expect(
      transactions.run((transaction) => activities.putCanonical(transaction, older)),
    ).resolves.toBe(false);
    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity.title,
    ).toBe('Local patch');
    await expectCanonicalVersion();
  });

  it('reports a new local create as missing capabilities and defers hydration', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'missing-capabilities-create' },
      clock,
    );

    expect(await activities.hasInstalledCapabilities(ACTIVITY)).toBe(false);
    expect(await activities.capabilityHydrationState(ACTIVITY)).toBe('deferred');

    await transactions.run((transaction) =>
      activities.setLocalState(transaction, ACTIVITY, 'canonical'),
    );
    expect(await activities.capabilityHydrationState(ACTIVITY)).toBe('deferred');

    await transactions.run(async (transaction) => {
      await transaction.database.run('DELETE FROM outbox_intents;');
      transaction.changed('outbox');
    });
    expect(await activities.capabilityHydrationState(ACTIVITY)).toBe('missing');
  });

  it.each(['queued', 'updating'] as const)(
    'keeps installed server capabilities while local_state is %s',
    async (localState) => {
      await coordinator.create(
        {
          input: { ...createInput(), reminders: [] },
          idempotencyKey: `capabilities-${localState}`,
        },
        clock,
      );
      const local = await activities.read({
        kind: 'activity',
        activityId: ACTIVITY,
      });
      if (local === undefined) throw new Error('missing capability-state fixture');
      const canonical = {
        ...local,
        activity: {
          ...local.activity,
          updatedAt: '2026-08-19T02:00:00.000Z',
        },
        capabilities: { complete: true, skip: true, snooze: true },
      };
      await transactions.run(async (transaction) => {
        await activities.installAcknowledgedActivity(
          transaction,
          canonical.activity,
          canonical,
        );
        await transaction.database.run('DELETE FROM outbox_intents;');
        await activities.patchLocal(
          transaction,
          ACTIVITY,
          { title: `Locally edited while ${localState}` },
          localState,
        );
        transaction.changed('outbox');
      });

      expect(await activities.hasInstalledCapabilities(ACTIVITY)).toBe(true);
      expect(await activities.capabilityHydrationState(ACTIVITY)).toBe('installed');
      expect(
        (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.capabilities,
      ).toEqual({ complete: true, skip: true, snooze: true });
    },
  );

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
    const firstCreate = await coordinator.create(
      { input: createInput(), idempotencyKey: 'same-create' },
      clock,
    );
    const repeatedCreate = await coordinator.create(
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
    expect(firstCreate).toMatchObject({ kind: 'accepted', commitRevision: 1 });
    expect(repeatedCreate).toMatchObject({ kind: 'accepted', commitRevision: 1 });
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

  it('defensively refuses every follow-up write while create is unacknowledged', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'still-pending-create' },
      clock,
    );

    const result = await coordinator.patch(
      ACTIVITY,
      'impossible-pending-edit',
      { title: 'Must not apply' },
      'v1',
    );

    expect(result).toMatchObject({
      kind: 'refused',
      error: expect.objectContaining({
        message: 'This activity will unlock once it finishes syncing.',
      }),
    });
    expect((await outbox.all()).map((intent) => intent.intentId)).toEqual([
      'still-pending-create',
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

  it('shares one local transaction for identical completion taps on the same target', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'create-before-double-tap' },
      clock,
    );
    await transactions.run(async (transaction) => {
      await outbox.acknowledge(transaction.database, 'create-before-double-tap');
    });

    const first = coordinator.complete(
      ACTIVITY,
      'double-tap-first',
      { occurrenceDate: '2026-08-19' },
      true,
      'scheduled',
      clock,
    );
    const duplicate = coordinator.complete(
      ACTIVITY,
      'double-tap-duplicate',
      { occurrenceDate: '2026-08-19' },
      true,
      'scheduled',
      clock,
    );

    expect(duplicate).toBe(first);
    await expect(first).resolves.toMatchObject({
      kind: 'accepted',
      intent: { intentId: 'double-tap-first' },
    });
    expect((await outbox.all()).map(({ intentId }) => intentId)).not.toContain(
      'double-tap-duplicate',
    );
  });

  it('projects an explicit occurrence completion without scanning or rewriting its series', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'create-before-targeted-complete' },
      clock,
    );
    await transactions.run(async (transaction) => {
      await outbox.acknowledge(transaction.database, 'create-before-targeted-complete');
      await transaction.database.run("UPDATE activities SET local_state = 'canonical';");
      await transaction.database.run("UPDATE agenda_rows SET local_state = 'canonical';");
    });
    const readWindow = vi.spyOn(agenda, 'readMaterializedWindow');
    const replaceSeries = vi.spyOn(agenda, 'replaceLocalActivityRows');

    await coordinator.complete(
      ACTIVITY,
      'targeted-complete',
      { occurrenceDate: '2026-08-20' },
      true,
      'scheduled',
      clock,
    );

    expect(readWindow).not.toHaveBeenCalled();
    expect(replaceSeries).not.toHaveBeenCalled();
    expect(
      await database?.all(
        `SELECT occurrence_date, status, local_state FROM agenda_rows
         WHERE activity_id = ? ORDER BY occurrence_date;`,
        [ACTIVITY],
      ),
    ).toEqual([
      {
        occurrence_date: '2026-08-19',
        status: 'scheduled',
        local_state: 'canonical',
      },
      {
        occurrence_date: '2026-08-20',
        status: 'completed_occurrence',
        local_state: 'queued',
      },
      {
        occurrence_date: '2026-08-21',
        status: 'scheduled',
        local_state: 'canonical',
      },
    ]);
  });

  it("persists the affected day's Up Next promotion and ordering without taking ownership of peer rows", async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'create-before-day-derivation' },
      clock,
    );
    await transactions.run(async (transaction) => {
      await outbox.acknowledge(transaction.database, 'create-before-day-derivation');
      await transaction.database.run("UPDATE activities SET local_state = 'canonical';");
      await transaction.database.run("UPDATE agenda_rows SET local_state = 'canonical';");
    });
    const materialized = await agenda.read({
      from: '2026-08-19',
      to: '2026-08-21',
      timezone: 'America/New_York',
    });
    const target = materialized.days[0]?.schedule[0];
    if (target === undefined)
      throw new Error('Expected the recurring target projection.');
    const next = {
      ...target,
      activityId: OTHER,
      title: 'Next scheduled task',
      time: '10:00',
      isRecurring: false,
    };
    const earlier = {
      ...target,
      activityId: THIRD,
      title: 'Existing earlier task',
      time: '07:00',
      isRecurring: false,
    };
    await transactions.run((transaction) =>
      agenda.installCanonical(
        transaction,
        {
          from: '2026-08-19',
          to: '2026-08-21',
          tz: 'America/New_York',
        },
        {
          ...materialized,
          days: materialized.days.map((day) =>
            day.date === '2026-08-19'
              ? {
                  ...day,
                  schedule: [target, next],
                  earlier: [earlier],
                  upNext: target,
                }
              : day,
          ),
        },
      ),
    );

    await coordinator.complete(
      ACTIVITY,
      'complete-and-rederive-day',
      { occurrenceDate: '2026-08-19' },
      true,
      'scheduled',
      { ...clock, currentMinute: '09:30' },
    );

    const rows = await database.all(
      `SELECT activity_id, section, sort_order, is_up_next, local_state, status
       FROM agenda_rows WHERE viewer_date = ?;`,
      ['2026-08-19'],
    );
    expect(rows.find((row) => row.activity_id === ACTIVITY)).toEqual({
      activity_id: ACTIVITY,
      section: 'earlier',
      sort_order: 0,
      is_up_next: 0,
      local_state: 'queued',
      status: 'completed_occurrence',
    });
    expect(rows.find((row) => row.activity_id === THIRD)).toEqual({
      activity_id: THIRD,
      section: 'earlier',
      sort_order: 1,
      is_up_next: 0,
      local_state: 'canonical',
      status: 'scheduled',
    });
    expect(rows.find((row) => row.activity_id === OTHER)).toEqual({
      activity_id: OTHER,
      section: 'schedule',
      sort_order: 0,
      is_up_next: 1,
      local_state: 'canonical',
      status: 'scheduled',
    });
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
    await transactions.run(async (transaction) => {
      await outbox.acknowledge(transaction.database, 'create-for-edit');
      await transaction.database.run(
        "UPDATE activities SET local_state = 'canonical' WHERE activity_id = ?;",
        [ACTIVITY],
      );
      await transaction.database.run(
        "UPDATE agenda_rows SET local_state = 'canonical' WHERE activity_id = ?;",
        [ACTIVITY],
      );
    });
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

  it('projects an all-future recurrence time change while offline', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'series-time-create' },
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
      'recurrence-time-edit',
      {
        recurrence: {
          mode: 'fixed',
          segments: [
            { freq: 'daily', interval: 1, effectiveFrom: '2026-08-19' },
            {
              freq: 'daily',
              interval: 1,
              effectiveFrom: '2026-08-20',
              time: '11:00',
            },
          ],
        },
        editedFromDate: '2026-08-20',
      },
      '2026-08-19T00:00:00Z',
      clock,
    );

    expect(result.kind).toBe('accepted');
    expect(
      await database?.all(
        `SELECT row_id, occurrence_date, time, local_state FROM agenda_rows
         WHERE activity_id = ? ORDER BY occurrence_date;`,
        [ACTIVITY],
      ),
    ).toEqual([
      {
        row_id: before?.[0]?.row_id,
        occurrence_date: '2026-08-19',
        time: '09:00',
        local_state: 'updating',
      },
      {
        row_id: before?.[1]?.row_id,
        occurrence_date: '2026-08-20',
        time: '11:00',
        local_state: 'updating',
      },
      {
        row_id: before?.[2]?.row_id,
        occurrence_date: '2026-08-21',
        time: '11:00',
        local_state: 'updating',
      },
    ]);
  });

  it('projects a same-day recurrence time correction while offline', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'same-day-time-create' },
      clock,
    );
    await transactions.run(async (transaction) => {
      await transaction.database.run("UPDATE activities SET local_state = 'canonical';");
      await transaction.database.run("UPDATE agenda_rows SET local_state = 'canonical';");
      await transaction.database.run('DELETE FROM outbox_intents;');
    });

    const result = await coordinator.patch(
      ACTIVITY,
      'same-day-time-edit',
      {
        recurrence: {
          mode: 'fixed',
          segments: [
            {
              freq: 'daily',
              interval: 1,
              effectiveFrom: '2026-08-19',
              time: '13:30',
            },
          ],
        },
      },
      '2026-08-19T00:00:00Z',
      clock,
    );

    expect(result.kind).toBe('accepted');
    expect(
      await database?.all(
        'SELECT occurrence_date, time FROM agenda_rows WHERE activity_id = ? ORDER BY occurrence_date;',
        [ACTIVITY],
      ),
    ).toEqual([
      { occurrence_date: '2026-08-19', time: '13:30' },
      { occurrence_date: '2026-08-20', time: '13:30' },
      { occurrence_date: '2026-08-21', time: '13:30' },
    ]);
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
      clock,
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

  it('does not resurrect a pending activity delete from stale detail or agenda data', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'create-before-delete' },
      clock,
    );
    await coordinator.create(
      {
        input: {
          ...createInput(OTHER),
          title: 'Unrelated activity',
          reminders: [],
        },
        idempotencyKey: 'unrelated-create',
      },
      clock,
    );
    await transactions.run(async (transaction) => {
      await transaction.database.run("UPDATE activities SET local_state = 'canonical';");
      await transaction.database.run("UPDATE agenda_rows SET local_state = 'canonical';");
      await transaction.database.run('DELETE FROM outbox_intents;');
    });
    const staleDetail = await activities.read({
      kind: 'activity',
      activityId: ACTIVITY,
    });
    const staleAgenda = await agenda.read({
      from: '2026-08-19',
      to: '2026-08-21',
      timezone: 'America/New_York',
    });
    if (staleDetail === undefined) throw new Error('missing stale detail fixture');

    await coordinator.remove(ACTIVITY, 'pending-delete');
    await transactions.run(async (transaction) => {
      expect((await outbox.claimNext(transaction.database))?.intentId).toBe(
        'pending-delete',
      );
      await outbox.requeue(transaction.database, 'pending-delete', 'offline');
    });
    await transactions.run(async (transaction) => {
      await activities.putCanonical(transaction, staleDetail);
      await agenda.installCanonical(
        transaction,
        { from: '2026-08-19', to: '2026-08-21', tz: 'America/New_York' },
        staleAgenda,
      );
    });

    expect(
      await activities.read({ kind: 'activity', activityId: ACTIVITY }),
    ).toBeUndefined();
    const visible = (
      await agenda.read({
        from: '2026-08-19',
        to: '2026-08-21',
        timezone: 'America/New_York',
      })
    ).days.flatMap((day) => day.schedule);
    expect(visible).not.toContainEqual(expect.objectContaining({ activityId: ACTIVITY }));
    expect(visible).toContainEqual(expect.objectContaining({ activityId: OTHER }));
  });

  it('suppresses pending reminder deletes and prunes only covered canonical reminders', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'create-before-reminder-delete' },
      clock,
    );
    await transactions.run(async (transaction) => {
      await transaction.database.run("UPDATE activities SET local_state = 'canonical';");
      await transaction.database.run(
        "UPDATE activity_reminders SET local_state = 'canonical';",
      );
      await transaction.database.run("UPDATE agenda_rows SET local_state = 'canonical';");
      await transaction.database.run('DELETE FROM outbox_intents;');
    });
    const stale = await agenda.read({
      from: '2026-08-19',
      to: '2026-08-21',
      timezone: 'America/New_York',
    });
    const staleWithReminder = {
      ...stale,
      days: stale.days.map((day) => ({
        ...day,
        schedule: day.schedule.map((item) => ({
          ...item,
          reminders: [
            {
              reminderId: REMINDER,
              activityId: ACTIVITY,
              userId: OWNER,
              offsetMinutes: -10,
              channel: 'push' as const,
            },
          ],
        })),
      })),
    };

    await coordinator.removeReminder({
      activityId: ACTIVITY,
      reminderId: REMINDER,
      intentId: 'delete-reminder',
    });
    await transactions.run((transaction) =>
      agenda.installCanonical(
        transaction,
        {
          from: '2026-08-19',
          to: '2026-08-21',
          tz: 'America/New_York',
          include: 'reminders',
        },
        staleWithReminder,
      ),
    );
    expect(
      await database?.all(
        'SELECT reminder_id FROM activity_reminders WHERE reminder_id = ?;',
        [REMINDER],
      ),
    ).toEqual([]);
    if (database === undefined) throw new Error('Test database was not opened.');
    setActiveNativeState({
      sessionId: 'activity-transactions-refresh-session',
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
      outboxPresentation: {} as OutboxPresentationStore,
      coordinator,
      sync,
    });
    expect(
      (await planFromCommittedRows()).requests.some((notification) =>
        notification.identifier.includes(REMINDER),
      ),
    ).toBe(false);

    await transactions.run(async (transaction) => {
      await transaction.database.run('DELETE FROM outbox_intents;');
      await transaction.database.run(
        `INSERT INTO activity_reminders
          (reminder_id, activity_id, owner_user_id, offset_minutes, channel, local_state)
         VALUES ('rem_01J0000000000000000000000B', ?, ?, -30, 'push', 'canonical'),
                ('rem_01J0000000000000000000000D', ?, ?, -60, 'push', 'canonical');`,
        [ACTIVITY, OWNER, OTHER, OWNER],
      );
    });
    await coordinator.addReminder({
      activityId: ACTIVITY,
      idempotencyKey: 'queued-reminder-create',
      input: {
        reminderId: 'rem_01J0000000000000000000000C',
        offsetMinutes: -45,
      },
    });
    await coordinator.addReminder({
      activityId: ACTIVITY,
      idempotencyKey: 'attention-reminder-create',
      input: {
        reminderId: 'rem_01J0000000000000000000000E',
        offsetMinutes: -50,
      },
    });
    await transactions.run(async (transaction) => {
      await outbox.needsAttention(transaction.database, 'attention-reminder-create', {
        kind: 'parked',
        reason: 'legacy_unknown',
      });
      await transaction.database.run(
        "UPDATE activity_reminders SET local_state = 'needs_attention' WHERE reminder_id = ?;",
        ['rem_01J0000000000000000000000E'],
      );
    });
    await transactions.run((transaction) =>
      agenda.installCanonical(
        transaction,
        {
          from: '2026-08-19',
          to: '2026-08-21',
          tz: 'America/New_York',
          include: 'reminders',
        },
        stale,
      ),
    );

    expect(
      await database?.all(
        'SELECT reminder_id, local_state FROM activity_reminders ORDER BY reminder_id;',
      ),
    ).toEqual([
      {
        reminder_id: 'rem_01J0000000000000000000000C',
        local_state: 'queued',
      },
      {
        reminder_id: 'rem_01J0000000000000000000000D',
        local_state: 'canonical',
      },
      {
        reminder_id: 'rem_01J0000000000000000000000E',
        local_state: 'needs_attention',
      },
    ]);
  });

  it('duplicates through a client-minted local create and returns an openable copy', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'duplicate-source-create' },
      clock,
    );
    await transactions.run(async (transaction) => {
      await transaction.database.run('DELETE FROM outbox_intents;');
      await transaction.database.run("UPDATE activities SET local_state = 'canonical';");
      await transaction.database.run("UPDATE agenda_rows SET local_state = 'canonical';");
    });

    const result = await coordinator.duplicate(
      ACTIVITY,
      OTHER,
      'duplicate-as-create',
      clock,
    );

    expect(result.kind).toBe('accepted');
    expect(await activities.read({ kind: 'activity', activityId: OTHER })).toMatchObject({
      activity: {
        activityId: OTHER,
        title: 'Offline daily task (copy)',
        status: 'saved',
      },
    });
    expect((await outbox.all())[0]).toMatchObject({
      entityId: OTHER,
      mutationKey: ['activity', 'create'],
      status: 'queued',
    });
  });

  it('retries attention with a fresh identity and re-applies the local projection', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'retry-source-create' },
      clock,
    );
    await transactions.run(async (transaction) => {
      await transaction.database.run('DELETE FROM outbox_intents;');
      await transaction.database.run("UPDATE activities SET local_state = 'canonical';");
      await transaction.database.run("UPDATE agenda_rows SET local_state = 'canonical';");
    });
    await coordinator.patch(
      ACTIVITY,
      'rejected-patch',
      { title: 'Retry this title' },
      '2026-08-19T00:00:00Z',
    );
    await transactions.run(async (transaction) => {
      await outbox.needsAttention(
        transaction.database,
        'rejected-patch',
        { kind: 'rejected', status: 422 },
        'Rejected title',
      );
      await transaction.database.run(
        "UPDATE activities SET title = 'Offline daily task', local_state = 'canonical' WHERE activity_id = ?;",
        [ACTIVITY],
      );
      await transaction.database.run(
        "UPDATE agenda_rows SET title = 'Offline daily task', local_state = 'canonical' WHERE activity_id = ?;",
        [ACTIVITY],
      );
    });

    const retried = await coordinator.retryBlocked(
      'rejected-patch',
      'fresh-patch',
      clock,
    );

    expect(retried.kind).toBe('accepted');
    expect((await outbox.all())[0]).toMatchObject({
      intentId: 'fresh-patch',
      status: 'queued',
      attempts: 0,
      variables: expect.objectContaining({ intentId: 'fresh-patch' }),
    });
    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity.title,
    ).toBe('Retry this title');
  });

  it('retries or discards a failed queued recurrence edit without trapping its rows', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'recover-recurrence-create' },
      clock,
    );
    await transactions.run(async (transaction) => {
      await transaction.database.run('DELETE FROM outbox_intents;');
      await transaction.database.run("UPDATE activities SET local_state = 'canonical';");
      await transaction.database.run("UPDATE agenda_rows SET local_state = 'canonical';");
    });
    await coordinator.patch(
      ACTIVITY,
      'failed-recurrence-patch',
      {
        recurrence: {
          mode: 'fixed',
          segments: [
            { freq: 'daily', interval: 1, effectiveFrom: '2026-08-19' },
            {
              freq: 'daily',
              interval: 1,
              effectiveFrom: '2026-08-20',
              time: '11:00',
            },
          ],
        },
      },
      '2026-08-19T00:00:00Z',
      clock,
    );
    const failNextAttempt = async () => {
      await transactions.run(async (transaction) => {
        const claimed = await outbox.claimNext(transaction.database);
        if (claimed === undefined) throw new Error('Expected a queued recurrence edit.');
        await outbox.requeue(
          transaction.database,
          claimed.intentId,
          'Schedule service unavailable.',
        );
        transaction.changed('outbox');
      });
    };
    await failNextAttempt();
    expect(
      await database.all(
        'SELECT occurrence_date, time FROM agenda_rows WHERE activity_id = ? ORDER BY occurrence_date;',
        [ACTIVITY],
      ),
    ).toEqual([
      { occurrence_date: '2026-08-19', time: '09:00' },
      { occurrence_date: '2026-08-20', time: '11:00' },
      { occurrence_date: '2026-08-21', time: '11:00' },
    ]);
    /* Simulates a queued intent persisted by the prior build, which did not project timing. */
    await transactions.run(async (transaction) => {
      await transaction.database.run(
        "UPDATE agenda_rows SET time = '09:00' WHERE activity_id = ?;",
        [ACTIVITY],
      );
    });
    request.mockClear();

    const retried = await coordinator.retryBlocked(
      'failed-recurrence-patch',
      'unused-fresh-id',
      clock,
    );

    expect(retried.kind).toBe('accepted');
    expect((await outbox.all())[0]).toMatchObject({
      intentId: 'failed-recurrence-patch',
      status: 'queued',
      lastError: 'Schedule service unavailable.',
    });
    expect(
      await database.all(
        'SELECT occurrence_date, time FROM agenda_rows WHERE activity_id = ? ORDER BY occurrence_date;',
        [ACTIVITY],
      ),
    ).toEqual([
      { occurrence_date: '2026-08-19', time: '09:00' },
      { occurrence_date: '2026-08-20', time: '11:00' },
      { occurrence_date: '2026-08-21', time: '11:00' },
    ]);
    expect(request).toHaveBeenCalledWith('accepted-action');

    await failNextAttempt();
    request.mockClear();
    await expect(
      coordinator.discardBlocked('failed-recurrence-patch', clock),
    ).resolves.toBe(true);

    expect(await outbox.all()).toEqual([]);
    expect(
      await database.first('SELECT local_state FROM activities WHERE activity_id = ?;', [
        ACTIVITY,
      ]),
    ).toEqual({ local_state: 'canonical' });
    expect(
      await database.all(
        'SELECT occurrence_date, time, local_state FROM agenda_rows WHERE activity_id = ? ORDER BY occurrence_date;',
        [ACTIVITY],
      ),
    ).toEqual([
      { occurrence_date: '2026-08-19', time: '09:00', local_state: 'canonical' },
      { occurrence_date: '2026-08-20', time: '09:00', local_state: 'canonical' },
      { occurrence_date: '2026-08-21', time: '09:00', local_state: 'canonical' },
    ]);
    expect(request).toHaveBeenCalledWith('manual');
  });

  it('discards an untrusted parked projection instead of leaving it visible as truth', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'discard-source-create' },
      clock,
    );
    await transactions.run(async (transaction) => {
      await transaction.database.run('DELETE FROM outbox_intents;');
      await transaction.database.run("UPDATE activities SET local_state = 'canonical';");
      await transaction.database.run("UPDATE agenda_rows SET local_state = 'canonical';");
    });
    await coordinator.patch(
      ACTIVITY,
      'expired-patch',
      { title: 'Untrusted old edit' },
      '2026-08-19T00:00:00Z',
    );
    await transactions.run((transaction) =>
      outbox.needsAttention(
        transaction.database,
        'expired-patch',
        { kind: 'parked', reason: 'replay_age_expired' },
        'Too old to replay automatically.',
      ),
    );

    await expect(coordinator.discardBlocked('expired-patch', clock)).resolves.toBe(true);

    expect(await outbox.all()).toEqual([]);
    expect(
      await activities.read({ kind: 'activity', activityId: ACTIVITY }),
    ).toBeUndefined();
  });

  it('keeps a stale detail pull from overwriting an unresolved occurrence move', async () => {
    await coordinator.create(
      { input: createInput(), idempotencyKey: 'occurrence-guard-create' },
      clock,
    );
    await transactions.run(async (transaction) => {
      await transaction.database.run('DELETE FROM outbox_intents;');
      await transaction.database.run("UPDATE activities SET local_state = 'canonical';");
      await transaction.database.run("UPDATE agenda_rows SET local_state = 'canonical';");
    });
    const stale = await activities.read({
      kind: 'occurrence',
      activityId: ACTIVITY,
      date: '2026-08-20',
    });
    if (stale === undefined) throw new Error('missing stale occurrence fixture');

    await coordinator.schedule(
      ACTIVITY,
      'guarded-occurrence-move',
      {
        occurrenceDate: '2026-08-20',
        date: '2026-08-21',
        time: '10:30',
        timezone: 'America/New_York',
      },
      clock,
    );
    await transactions.run((transaction) => activities.putCanonical(transaction, stale));

    expect(
      (
        await activities.read({
          kind: 'occurrence',
          activityId: ACTIVITY,
          date: '2026-08-20',
        })
      )?.occurrence,
    ).toMatchObject({ nominalDate: '2026-08-20', date: '2026-08-21', time: '10:30' });
  });
});
