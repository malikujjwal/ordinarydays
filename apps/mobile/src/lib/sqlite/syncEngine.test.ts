import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, NetworkError } from '@od/shared/client';
import { type CreateActivityInput, instant } from '@od/shared/schemas';
import type { Activity, List } from '@od/shared/types';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';
import type { ActivityPullAdapter } from '../sync/pullAdapter';
import type { ActivityPushTransport, ListPushTransport } from '../sync/pushAdapter';
import type { TargetedAgendaTransport } from '../sync/reconciliation';
import { NativeActivityActionCoordinator } from './actionCoordinator';
import { ActivityRepository } from './activityRepository';
import { ActivityTransactionService } from './activityTransactions';
import { AgendaRepository } from './agendaRepository';
import { AnytimeRepository } from './anytimeRepository';
import type { SqliteDatabase } from './database';
import { ListItemsRepository } from './listItemsRepository';
import { ListsRepository } from './listsRepository';
import { ListTransactionService } from './listTransactions';
import { FOUNDATION_MIGRATIONS, runMigrations } from './migrations';
import { OutboxRepository } from './outbox';
import { recoverAbandonedOutbox } from './sessionRecovery';
import { RepositorySubscriptions } from './subscriptions';
import {
  CanonicalActivityInstallDeferredError,
  SerializedNativeSyncEngine,
} from './syncEngine';
import { SerializedTransactionRunner } from './transaction';

const OWNER = 'usr_01J0000000000000000000000A';
const ACTIVITY = 'act_01J0000000000000000000000A';
const OTHER = 'act_01J0000000000000000000000B';
const THIRD = 'act_01J0000000000000000000000C';
const REMINDER = 'rem_01J0000000000000000000000A';
const clock = { today: '2026-08-19', currentMinute: '08:00' };

/**
 * The engine as the coordinator may hold it: authoritative recovery is real, but the `request`
 * that follows an accepted Retry or Discard is a spy.
 *
 * Without this the drain that wake starts outlives the test and reaches a database the next
 * `afterEach` has already closed — an unhandled rejection attributed to whichever test happens
 * to be running by then. The same shape the rejected-rollback test uses.
 */
function recoveryOnly(engine: SerializedNativeSyncEngine): SerializedNativeSyncEngine {
  return {
    request: vi.fn(),
    recoverRejectedIntent: (intentId: string) => engine.recoverRejectedIntent(intentId),
  } as unknown as SerializedNativeSyncEngine;
}

describe('serialized native convergence guard', () => {
  let directory = '';
  let database: SqliteDatabase | undefined;
  let transactions: SerializedTransactionRunner;
  let activities: ActivityRepository;
  let agenda: AgendaRepository;
  let anytime: AnytimeRepository;
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
      anytime,
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
    anytime = new AnytimeRepository(database, subscriptions);
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

  it('reads occurrence date and capabilities from committed Agenda rows', async () => {
    const activity = await seedRecurring();
    const target = {
      kind: 'occurrence' as const,
      activityId: ACTIVITY,
      date: '2026-08-19',
    };

    const fromAgenda = await activities.read(target);
    expect(fromAgenda).toMatchObject({
      activity: { schedule: { date: '2026-08-19' } },
      occurrence: { nominalDate: '2026-08-19', date: '2026-08-19' },
      capabilities: { complete: true, skip: true, snooze: true },
    });

    await transactions.run((transaction) =>
      activities.putCanonical(transaction, {
        activity,
        reminders: [],
        capabilities: { complete: true, skip: true, snooze: true },
        occurrence: {
          nominalDate: '2026-08-20',
          date: '2026-08-20',
          time: '09:00',
          status: 'scheduled',
          isSnoozed: false,
        },
      }),
    );
    await database?.run('DELETE FROM agenda_rows WHERE activity_id = ?;', [ACTIVITY]);

    expect(await activities.read({ ...target, date: '2026-08-20' })).toMatchObject({
      occurrence: { nominalDate: '2026-08-20', date: '2026-08-20' },
      capabilities: { complete: true, skip: true, snooze: true },
    });
  });

  it('reports a targeted detail pull as refused when its server version is stale', async () => {
    const current = await activities.read({ kind: 'activity', activityId: ACTIVITY });
    if (current === undefined) throw new Error('missing targeted stale-version fixture');
    const newer = {
      ...current,
      activity: {
        ...current.activity,
        title: 'Newer installed server truth',
        updatedAt: '2026-08-19T05:00:00.000Z',
      },
      capabilities: { complete: true, skip: true, snooze: true },
    };
    await transactions.run((transaction) =>
      activities.installAcknowledgedActivity(transaction, newer.activity, newer),
    );
    const stale = {
      ...newer,
      activity: {
        ...newer.activity,
        title: 'Older targeted response',
        updatedAt: '2026-08-19T04:00:00.000Z',
      },
    };
    const sync = syncEngine({
      pull: { ...pullAdapter(), activity: async () => stale },
    });

    await expect(
      sync.pullActivity({ kind: 'activity', activityId: ACTIVITY }),
    ).rejects.toBeInstanceOf(CanonicalActivityInstallDeferredError);
    sync.stop();
    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity.title,
    ).toBe('Newer installed server truth');
  });

  it('coalesces a complete paged Anytime refresh into one SQLite replacement', async () => {
    const anytimePage = vi
      .fn<NonNullable<ActivityPullAdapter['anytimePage']>>()
      .mockResolvedValueOnce({
        data: [
          {
            activityId: ACTIVITY,
            type: 'task',
            title: 'First page',
            status: 'saved',
            isRecurring: false,
            participantCount: 0,
          },
        ],
        nextCursor: 'page-two',
      })
      .mockResolvedValueOnce({
        data: [
          {
            activityId: OTHER,
            type: 'task',
            title: 'Second page',
            status: 'saved',
            isRecurring: false,
            participantCount: 0,
          },
        ],
      });
    const sync = syncEngine({ pull: { ...pullAdapter(), anytimePage } });

    const [first, second] = await Promise.all([sync.pullAnytime(), sync.pullAnytime()]);
    sync.stop();

    expect(anytimePage).toHaveBeenCalledTimes(2);
    expect(first).toEqual(second);
    expect(first.map((item) => item.title)).toEqual(['First page', 'Second page']);
  });

  it('keeps a task scheduled from Anytime visible when the first Plans GSI read is stale', async () => {
    if (database === undefined) throw new Error('missing stale Plans pull database');
    const before = await activities.read({ kind: 'activity', activityId: ACTIVITY });
    if (before === undefined) throw new Error('missing stale Plans pull Activity');
    const tomorrow = '2026-08-20';
    await transactions.run((transaction) =>
      service.schedule(
        transaction,
        {
          activityId: ACTIVITY,
          idempotencyKey: 'schedule-anytime-tomorrow',
          input: { date: tomorrow, timezone: 'UTC' },
        },
        clock,
      ),
    );
    const projected = await agenda.read({
      from: tomorrow,
      to: tomorrow,
      timezone: 'UTC',
    });
    const projectedItem = projected.days[0]?.anytime[0];
    if (projectedItem === undefined) throw new Error('missing local tomorrow projection');
    const canonicalActivity: Activity = {
      ...before.activity,
      status: 'scheduled',
      schedule: { date: tomorrow, timezone: 'UTC' },
      updatedAt: '2026-08-20T00:00:00.000Z',
      lastActivityAt: '2026-08-20T00:00:00.000Z',
    };
    let gsiCaughtUp = false;
    const agendaRead = vi.fn<ActivityPullAdapter['agenda']>(async (request) => {
      const containsTomorrow = request.from <= tomorrow && request.to >= tomorrow;
      return {
        days: [request.from, request.to]
          .filter((date, index, dates) => dates.indexOf(date) === index)
          .map((date) => ({
            date,
            schedule: [],
            anytime:
              gsiCaughtUp && containsTomorrow && date === tomorrow ? [projectedItem] : [],
            earlier: [],
          })),
        warnings: [],
        projectionVersions:
          gsiCaughtUp && containsTomorrow
            ? [{ activityId: ACTIVITY, version: canonicalActivity.updatedAt }]
            : [],
      };
    });
    const sync = syncEngine({
      push: {
        ...pushTransport(),
        schedule: async () => ({ activity: canonicalActivity }),
      },
      pull: {
        ...pullAdapter(),
        agenda: agendaRead,
      },
    });

    await sync.pullAgenda({ from: '2026-08-19', to: tomorrow, tz: 'UTC' });

    expect(
      await database.all(
        `SELECT viewer_date, section, status, local_state, canonical_version
         FROM agenda_rows WHERE activity_id = ?;`,
        [ACTIVITY],
      ),
    ).toEqual([
      {
        viewer_date: tomorrow,
        section: 'anytime',
        status: 'scheduled',
        local_state: 'canonical',
        canonical_version: canonicalActivity.updatedAt,
      },
    ]);
    expect(
      await database.first(
        `SELECT expected_version FROM agenda_projection_fences WHERE activity_id = ?;`,
        [ACTIVITY],
      ),
    ).toEqual({ expected_version: canonicalActivity.updatedAt });

    gsiCaughtUp = true;
    await sync.pullAgenda({ from: '2026-08-19', to: tomorrow, tz: 'UTC' });
    sync.stop();

    expect(agendaRead).toHaveBeenCalled();
    expect(
      await database.first(
        `SELECT expected_version FROM agenda_projection_fences WHERE activity_id = ?;`,
        [ACTIVITY],
      ),
    ).toBeUndefined();
  });

  it('keeps a zero-row projection fence across targeted replacement and repository restart', async () => {
    if (database === undefined) throw new Error('missing zero-row fence database');
    const request = { from: '2026-08-19', to: '2026-08-19', tz: 'UTC' } as const;
    const before = await agenda.read({
      from: request.from,
      to: request.to,
      timezone: request.tz,
    });
    const staleItem = before.days[0]?.anytime.find(
      (item) => item.activityId === ACTIVITY,
    );
    if (staleItem === undefined) throw new Error('missing zero-row stale fixture');
    const expectedVersion = '2026-08-19T12:00:00.000Z';

    await transactions.run(async (transaction) => {
      await agenda.recordProjectionFence(transaction, ACTIVITY, expectedVersion);
      await agenda.replaceCanonicalActivityRows(
        transaction,
        request,
        { activityId: ACTIVITY, activityVersion: expectedVersion, rows: [] },
        clock,
      );
    });

    expect(
      await database.first('SELECT row_id FROM agenda_rows WHERE activity_id = ?;', [
        ACTIVITY,
      ]),
    ).toBeUndefined();
    expect(
      await database.first(
        'SELECT expected_version FROM agenda_projection_fences WHERE activity_id = ?;',
        [ACTIVITY],
      ),
    ).toEqual({ expected_version: expectedVersion });

    const restartedAgenda = new AgendaRepository(database, new RepositorySubscriptions());
    await transactions.run((transaction) =>
      restartedAgenda.installCanonical(transaction, request, {
        days: [
          {
            date: request.from,
            schedule: [],
            anytime: [staleItem],
            earlier: [],
          },
        ],
        warnings: [],
        projectionVersions: [],
      }),
    );

    expect(
      await database.first('SELECT row_id FROM agenda_rows WHERE activity_id = ?;', [
        ACTIVITY,
      ]),
    ).toBeUndefined();

    await transactions.run((transaction) =>
      restartedAgenda.installCanonical(transaction, request, {
        days: [
          {
            date: request.from,
            schedule: [],
            anytime: [staleItem],
            earlier: [],
          },
        ],
        warnings: [],
        projectionVersions: [{ activityId: ACTIVITY, version: expectedVersion }],
      }),
    );

    expect(
      await database.first('SELECT row_id FROM agenda_rows WHERE activity_id = ?;', [
        ACTIVITY,
      ]),
    ).toBeDefined();
    expect(
      await database.first(
        'SELECT expected_version FROM agenda_projection_fences WHERE activity_id = ?;',
        [ACTIVITY],
      ),
    ).toBeUndefined();
  });

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

  it('continues bounded passes after the cap until every claimable intent settles', async () => {
    const deleteReminder = vi.fn(async () => ({ reminderId: 'removed' }));
    await transactions.run(async (transaction) => {
      for (let index = 0; index < 25; index += 1) {
        const intentId = `delete-reminder-${index}`;
        await outbox.append(transaction.database, {
          intentId,
          mutationKey: ['activity', 'reminder-delete'],
          variables: {
            activityId: ACTIVITY,
            reminderId: `rem_01J00000000000000000000${String(index).padStart(2, '0')}`,
            intentId,
          },
          entityId: ACTIVITY,
        });
      }
      transaction.changed('outbox');
    });
    const sync = syncEngine({ push: { ...pushTransport(), deleteReminder } });

    await sync.syncNow();
    sync.stop();

    expect(deleteReminder).toHaveBeenCalledTimes(25);
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

  it('does not install an older recurrence acknowledgement over later same-key work', async () => {
    const activity = await seedRecurring();
    await transactions.run((transaction) =>
      service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'first-recurrence-edit',
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
    let releaseFirst: ((value: Activity) => void) | undefined;
    let releaseSecond: ((value: Activity) => void) | undefined;
    const first = new Promise<Activity>((resolve) => {
      releaseFirst = resolve;
    });
    const second = new Promise<Activity>((resolve) => {
      releaseSecond = resolve;
    });
    const patch = vi
      .fn<() => Promise<Activity>>()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);
    const sync = syncEngine({ push: { ...pushTransport(), patch } });
    const running = sync.syncNow();
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(1));

    await transactions.run((transaction) =>
      service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'second-recurrence-edit',
        input: {
          recurrence: {
            mode: 'fixed',
            segments: [
              {
                freq: 'weekly',
                interval: 2,
                byWeekday: [4],
                effectiveFrom: '2026-08-19',
              },
            ],
          },
        },
        ifMatch: activity.updatedAt,
      }),
    );
    releaseFirst?.({
      ...activity,
      updatedAt: '2026-08-19T12:00:00.000Z',
    });
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(2));

    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity
        .updatedAt,
    ).toBe(activity.updatedAt);
    expect(await outbox.all()).toEqual([
      expect.objectContaining({
        intentId: 'first-recurrence-edit',
        status: 'acknowledged',
        reconciliationVersion: '2026-08-19T12:00:00.000Z',
      }),
      expect.objectContaining({
        intentId: 'second-recurrence-edit',
        status: 'in_flight',
      }),
    ]);

    releaseSecond?.({
      ...activity,
      updatedAt: '2026-08-19T13:00:00.000Z',
    });
    await running;
    sync.stop();
  });

  it.each(['create', 'delete'] as const)(
    'reconciles a recurrence acknowledgement after a later reminder %s',
    async (reminderMutation) => {
      const activity = await seedRecurring();
      const before = await agenda.read({
        from: '2026-08-19',
        to: '2026-08-19',
        timezone: 'UTC',
      });
      const rows = before.days.flatMap((day) =>
        [...day.schedule, ...day.anytime, ...day.earlier]
          .filter((item) => item.activityId === ACTIVITY)
          .map((item) => ({ date: day.date, item })),
      );
      const recurrence = {
        mode: 'fixed' as const,
        segments: [
          {
            freq: 'weekly' as const,
            interval: 1,
            byWeekday: [3 as const],
            effectiveFrom: '2026-08-19',
            time: '09:00',
          },
        ],
      };
      await transactions.run(async (transaction) => {
        if (reminderMutation === 'delete') {
          await transaction.database.run(
            `INSERT INTO activity_reminders
              (reminder_id, activity_id, owner_user_id, offset_minutes, channel, local_state)
             VALUES (?, ?, ?, 15, 'push', 'canonical');`,
            [REMINDER, ACTIVITY, OWNER],
          );
        }
        await service.patch(transaction, {
          activityId: ACTIVITY,
          intentId: `recurrence-before-reminder-${reminderMutation}`,
          input: { recurrence },
          ifMatch: activity.updatedAt,
        });
        if (reminderMutation === 'create') {
          await service.addReminder(transaction, OWNER, {
            activityId: ACTIVITY,
            idempotencyKey: 'later-reminder-create',
            input: { reminderId: REMINDER, offsetMinutes: -15 },
          });
        } else {
          await service.removeReminder(transaction, {
            activityId: ACTIVITY,
            reminderId: REMINDER,
            intentId: 'later-reminder-delete',
          });
        }
      });
      const acknowledged: Activity = {
        ...activity,
        recurrence,
        updatedAt: '2026-08-19T12:00:00.000Z',
      };
      const targeted = vi.fn(async () => ({
        activityId: ACTIVITY,
        activityVersion: acknowledged.updatedAt,
        rows,
      }));
      const sync = syncEngine({
        push: {
          ...pushTransport(),
          patch: async () => acknowledged,
          createReminder: async () => ({ reminderId: REMINDER }),
          deleteReminder: async () => ({ reminderId: REMINDER }),
        },
        targeted: { load: targeted },
      });

      await sync.syncNow();
      sync.stop();

      expect(targeted).toHaveBeenCalledTimes(1);
      expect(await outbox.all()).toEqual([]);
      expect(
        await database?.first(
          'SELECT recurrence_json, local_state, canonical_version FROM activities WHERE activity_id = ?;',
          [ACTIVITY],
        ),
      ).toMatchObject({
        recurrence_json: JSON.stringify(recurrence),
        local_state: 'canonical',
        canonical_version: acknowledged.updatedAt,
      });
      expect(
        await database?.first(
          'SELECT local_state FROM agenda_rows WHERE activity_id = ? LIMIT 1;',
          [ACTIVITY],
        ),
      ).toMatchObject({ local_state: 'canonical' });
      if (reminderMutation === 'create') {
        expect(
          await database?.first(
            'SELECT local_state FROM activity_reminders WHERE reminder_id = ?;',
            [REMINDER],
          ),
        ).toMatchObject({ local_state: 'canonical' });
      } else {
        expect(
          await database?.first(
            'SELECT reminder_id FROM reminder_tombstones WHERE reminder_id = ?;',
            [REMINDER],
          ),
        ).toMatchObject({ reminder_id: REMINDER });
      }
    },
  );

  it('installs an ordinary PATCH version through a reminder-only queue tail', async () => {
    const current = await seedRecurring();
    await transactions.run(async (transaction) => {
      await service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'patch-before-reminder-tail',
        input: { title: 'Acknowledged before reminder' },
        ifMatch: current.updatedAt,
      });
      await service.addReminder(transaction, OWNER, {
        activityId: ACTIVITY,
        idempotencyKey: 'tail-reminder-create',
        input: { reminderId: REMINDER, offsetMinutes: -15 },
      });
    });
    let server = current;
    const observedIfMatch: string[] = [];
    const versions = ['2026-08-19T12:00:00.000Z', '2026-08-19T13:00:00.000Z'] as const;
    const patch = vi.fn<ActivityPushTransport['patch']>(
      async (_activityId, input, ifMatch) => {
        observedIfMatch.push(ifMatch);
        if (ifMatch !== server.updatedAt) {
          throw new ApiError('conflict', 'stale PATCH precondition', 409, 'req_tail_cas');
        }
        const updatedAt = versions[observedIfMatch.length - 1];
        if (updatedAt === undefined) throw new Error('missing reminder-tail version');
        server = { ...server, ...input, updatedAt } as Activity;
        return server;
      },
    );
    const sync = syncEngine({
      push: {
        ...pushTransport(),
        patch,
        createReminder: async () => ({ reminderId: REMINDER }),
      },
    });

    await sync.syncNow();

    const installed = await activities.read({ kind: 'activity', activityId: ACTIVITY });
    if (installed === undefined) throw new Error('missing reminder-tail installation');
    expect(installed.activity).toMatchObject({
      title: 'Acknowledged before reminder',
      updatedAt: versions[0],
    });
    expect(
      await database?.first(
        `SELECT local_state, canonical_version FROM activities WHERE activity_id = ?;`,
        [ACTIVITY],
      ),
    ).toEqual({ local_state: 'canonical', canonical_version: versions[0] });
    expect(
      await database?.first(
        `SELECT local_state FROM activity_reminders WHERE reminder_id = ?;`,
        [REMINDER],
      ),
    ).toEqual({ local_state: 'canonical' });

    await transactions.run((transaction) =>
      service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'patch-after-reminder-tail',
        input: { notes: 'Uses the acknowledged version' },
        ifMatch: installed.activity.updatedAt,
      }),
    );
    await sync.syncNow();
    sync.stop();

    expect(observedIfMatch).toEqual([current.updatedAt, versions[0]]);
    expect(await outbox.all()).toEqual([]);
    expect(
      await database?.first(
        `SELECT notes, local_state, canonical_version
         FROM activities WHERE activity_id = ?;`,
        [ACTIVITY],
      ),
    ).toEqual({
      notes: 'Uses the acknowledged version',
      local_state: 'canonical',
      canonical_version: versions[1],
    });
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

  it('rebases consecutive offline PATCH preconditions through the authoritative server chain', async () => {
    const current = await activities.read({ kind: 'activity', activityId: ACTIVITY });
    if (current === undefined) throw new Error('missing PATCH chain fixture');
    const initialVersion = current.activity.updatedAt;
    const inputs = [
      { title: 'First server edit' },
      { notes: 'Second server edit' },
      { title: 'Final server edit' },
    ] as const;
    await transactions.run(async (transaction) => {
      for (const [index, input] of inputs.entries()) {
        await service.patch(transaction, {
          activityId: ACTIVITY,
          intentId: `offline-patch-${index + 1}`,
          input,
          ifMatch: initialVersion,
        });
      }
    });
    let server = current.activity;
    const observed: Array<{ readonly input: unknown; readonly ifMatch: string }> = [];
    const versions = [
      '2026-08-19T01:00:00.000Z',
      '2026-08-19T02:00:00.000Z',
      '2026-08-19T03:00:00.000Z',
    ];
    const patch = vi.fn(
      async (_activityId: string, input: (typeof inputs)[number], ifMatch: string) => {
        observed.push({ input, ifMatch });
        if (ifMatch !== server.updatedAt) {
          throw new ApiError(
            'conflict',
            'stale PATCH precondition',
            409,
            'req_patch_cas',
          );
        }
        const updatedAt = versions[observed.length - 1];
        if (updatedAt === undefined) throw new Error('missing PATCH chain version');
        server = { ...server, ...input, updatedAt } as Activity;
        return server;
      },
    );
    const sync = syncEngine({ push: { ...pushTransport(), patch } });

    await sync.syncNow();
    sync.stop();

    expect(observed).toEqual([
      { input: inputs[0], ifMatch: initialVersion },
      { input: inputs[1], ifMatch: versions[0] },
      { input: inputs[2], ifMatch: versions[1] },
    ]);
    expect(await outbox.all()).toEqual([]);
    expect(
      await database?.first(
        'SELECT title, notes, local_state, canonical_version FROM activities WHERE activity_id = ?;',
        [ACTIVITY],
      ),
    ).toMatchObject({
      title: 'Final server edit',
      notes: 'Second server edit',
      local_state: 'canonical',
      canonical_version: versions[2],
    });
  });

  it('carries an authoritative PATCH version across an intervening reminder write', async () => {
    const current = await activities.read({ kind: 'activity', activityId: ACTIVITY });
    if (current === undefined) throw new Error('missing reminder CAS fixture');
    const initialVersion = current.activity.updatedAt;
    await transactions.run(async (transaction) => {
      await service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'patch-before-reminder',
        input: { title: 'First CAS edit' },
        ifMatch: initialVersion,
      });
      await service.addReminder(transaction, OWNER, {
        activityId: ACTIVITY,
        idempotencyKey: 'cas-reminder',
        input: { reminderId: REMINDER, offsetMinutes: -30 },
      });
      await service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'patch-after-reminder',
        input: { notes: 'Second CAS edit' },
        ifMatch: initialVersion,
      });
    });
    let server = current.activity;
    const observed: string[] = [];
    const versions = ['2026-08-19T01:00:00.000Z', '2026-08-19T02:00:00.000Z'];
    const patch = vi.fn<ActivityPushTransport['patch']>(
      async (_activityId, input, ifMatch) => {
        observed.push(ifMatch);
        if (ifMatch !== server.updatedAt) {
          throw new ApiError('conflict', 'stale PATCH precondition', 409, 'req_gap_cas');
        }
        const updatedAt = versions[observed.length - 1];
        if (updatedAt === undefined) throw new Error('missing reminder CAS version');
        server = { ...server, ...input, updatedAt } as Activity;
        return server;
      },
    );
    const sync = syncEngine({
      push: {
        ...pushTransport(),
        patch,
        createReminder: async () => ({ reminderId: REMINDER }),
      },
    });

    await sync.syncNow();
    sync.stop();

    expect(observed).toEqual([initialVersion, versions[0]]);
    expect(await outbox.all()).toEqual([]);
    expect(
      await database?.first(
        'SELECT title, notes, canonical_version, local_state FROM activities WHERE activity_id = ?;',
        [ACTIVITY],
      ),
    ).toMatchObject({
      title: 'First CAS edit',
      notes: 'Second CAS edit',
      canonical_version: versions[1],
      local_state: 'canonical',
    });
  });

  it('rebases a dependent PATCH from the authoritative retried-create version', async () => {
    await transactions.run(async (transaction) => {
      await service.create(
        transaction,
        OWNER,
        {
          input: {
            activityId: OTHER,
            objectKind: 'plan',
            type: 'custom',
            title: 'Collided create',
            schedule: { date: '2026-08-19', time: '10:00', timezone: 'UTC' },
          },
          idempotencyKey: 'collision-create',
        },
        clock,
        '2026-08-19T00:30:00.000Z',
      );
      await service.patch(transaction, {
        activityId: OTHER,
        intentId: 'collision-dependent-patch',
        input: { title: 'Dependent edit reached server' },
        ifMatch: 'obsolete-before-create-ack',
      });
      await outbox.needsAttention(
        transaction.database,
        'collision-create',
        { kind: 'parked', reason: 'ambiguous_collision' },
        'The create identity collided.',
      );
      await activities.setLocalState(transaction, OTHER, 'needs_attention');
      await agenda.markActivityRows(transaction, OTHER, 'needs_attention');
    });
    let server: Activity | undefined;
    const createVersion = '2026-08-19T01:00:00.000Z';
    const patchVersion = '2026-08-19T02:00:00.000Z';
    const observed: Array<{ readonly activityId: string; readonly ifMatch: string }> = [];
    const create = vi.fn<ActivityPushTransport['create']>(async (input) => {
      const activityId = input.activityId;
      if (activityId === undefined)
        throw new Error('retried create omitted its identity');
      const local = await activities.read({ kind: 'activity', activityId });
      if (local === undefined) throw new Error('missing remapped create projection');
      server = { ...local.activity, updatedAt: createVersion };
      return server;
    });
    const patch = vi.fn<ActivityPushTransport['patch']>(
      async (activityId, input, ifMatch) => {
        observed.push({ activityId, ifMatch });
        if (server === undefined || ifMatch !== server.updatedAt) {
          throw new ApiError(
            'conflict',
            'retried create PATCH used stale precondition',
            409,
            'req_collision_cas',
          );
        }
        server = { ...server, ...input, updatedAt: patchVersion } as Activity;
        return server;
      },
    );
    const pullActivity = vi.fn<ActivityPullAdapter['activity']>(async () => {
      if (server === undefined) throw new Error('retried create is not on the server');
      return {
        activity: server,
        reminders: [],
        capabilities: { complete: true, skip: true, snooze: true },
      };
    });
    const sync = syncEngine({
      push: { ...pushTransport(), create, patch },
      pull: { ...pullAdapter(), activity: pullActivity },
    });
    const coordinator = new NativeActivityActionCoordinator(
      OWNER,
      transactions,
      service,
      outbox,
      sync,
      () => THIRD,
    );

    const retried = await coordinator.retryBlocked(
      'collision-create',
      'fresh-collision-create',
      clock,
    );
    expect(retried).toMatchObject({ kind: 'accepted', intent: { entityId: THIRD } });
    await sync.syncNow();
    sync.stop();

    expect(observed).toEqual([{ activityId: THIRD, ifMatch: createVersion }]);
    expect(await outbox.all()).toEqual([]);
    expect(
      (await activities.read({ kind: 'activity', activityId: THIRD }))?.activity,
    ).toMatchObject({
      title: 'Dependent edit reached server',
      updatedAt: patchVersion,
    });
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

  it('requeues an expected transport failure without presenting it as a rejected change', async () => {
    client.setMutationDefaults(['activity', 'patch'], {
      mutationFn: async () => {
        throw new NetworkError(
          'The request could not be sent.',
          new TypeError('offline'),
        );
      },
    });
    const sync = syncEngine();
    await transactions.run((transaction) =>
      service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'transport-offline-edit',
        input: { title: 'Still committed offline' },
        ifMatch: 'v1',
      }),
    );

    await expect(sync.syncNow()).rejects.toThrow('The request could not be sent.');
    sync.stop();

    const [queued] = await outbox.all();
    expect(queued).toMatchObject({
      intentId: 'transport-offline-edit',
      status: 'queued',
      attempts: 1,
    });
    expect(queued?.lastError).toBeUndefined();
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

  it('rolls a permanent rejection back before exposing structured recovery', async () => {
    const canonical = await activities.read({
      kind: 'activity',
      activityId: ACTIVITY,
    });
    const canonicalAgenda = await agenda.read({
      from: '2026-08-19',
      to: '2026-08-19',
      timezone: 'UTC',
    });
    if (canonical === undefined) throw new Error('missing canonical rejection fixture');
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
    const sync = syncEngine({
      push,
      pull: {
        ...pullAdapter(),
        activity: async () => canonical,
        agenda: async () => canonicalAgenda,
      },
    });

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
    ).toMatchObject({ title: 'Canonical seed', local_state: 'canonical' });
    expect(
      (
        await agenda.read({
          from: '2026-08-19',
          to: '2026-08-19',
          timezone: 'UTC',
        })
      ).days[0]?.anytime,
    ).toContainEqual(
      expect.objectContaining({ activityId: ACTIVITY, title: 'Canonical seed' }),
    );
  });

  it('keeps failed rollback recovery durable across restart until Discard verifies canonical truth', async () => {
    const canonical = await activities.read({ kind: 'activity', activityId: ACTIVITY });
    const canonicalAgenda = await agenda.read({
      from: '2026-08-19',
      to: '2026-08-19',
      timezone: 'UTC',
    });
    if (canonical === undefined || database === undefined) {
      throw new Error('missing failed rollback fixture');
    }
    await transactions.run((transaction) =>
      service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'failed-rollback-edit',
        input: { title: 'Rejected local title' },
        ifMatch: 'v1',
      }),
    );
    const rejectingSync = syncEngine({
      push: {
        ...pushTransport(),
        patch: async () => {
          throw new ApiError(
            'validation_failed',
            'Rejected local title',
            422,
            'req_failed_rollback',
          );
        },
      },
      pull: {
        ...pullAdapter(),
        activity: async () => {
          throw new NetworkError('Rollback detail is offline.', undefined);
        },
      },
    });

    await expect(rejectingSync.syncNow()).rejects.toThrow('Rejected local title');
    rejectingSync.stop();

    expect((await outbox.all())[0]).toMatchObject({
      intentId: 'failed-rollback-edit',
      status: 'needs_attention',
      recoveryRequired: true,
      attention: { kind: 'rejected', status: 422, recoveryRequired: true },
    });
    expect(
      await database.first(
        'SELECT title, local_state FROM activities WHERE activity_id = ?;',
        [ACTIVITY],
      ),
    ).toEqual({ title: 'Rejected local title', local_state: 'needs_attention' });

    /* The recovery receipt, and its refusal to discard unverified data, survive restart. */
    await database.close();
    database = await createNodeSqliteFactory(directory).open('sync.sqlite');
    const restartedSubscriptions = new RepositorySubscriptions();
    transactions = new SerializedTransactionRunner(database, restartedSubscriptions);
    activities = new ActivityRepository(database, restartedSubscriptions);
    agenda = new AgendaRepository(database, restartedSubscriptions);
    anytime = new AnytimeRepository(database, restartedSubscriptions);
    outbox = new OutboxRepository(database);
    service = new ActivityTransactionService(outbox, activities, agenda);

    const offlineRecovery = syncEngine({
      pull: {
        ...pullAdapter(),
        activity: async () => {
          throw new NetworkError('Still offline.', undefined);
        },
      },
    });
    const offlineCoordinator = new NativeActivityActionCoordinator(
      OWNER,
      transactions,
      service,
      outbox,
      offlineRecovery,
    );
    await expect(
      offlineCoordinator.discardBlocked('failed-rollback-edit', clock),
    ).resolves.toBe(false);
    offlineRecovery.stop();
    expect((await outbox.all())[0]).toMatchObject({
      intentId: 'failed-rollback-edit',
      status: 'needs_attention',
      recoveryRequired: true,
    });

    const recoveredPull: ActivityPullAdapter = {
      ...pullAdapter(),
      activity: async () => canonical,
      agenda: async () => canonicalAgenda,
    };
    const recoverySync = syncEngine({
      pull: recoveredPull,
      targeted: {
        load: async () => ({
          activityId: ACTIVITY,
          activityVersion: canonical.activity.updatedAt,
          rows: canonicalAgenda.days.flatMap((day) =>
            [...day.schedule, ...day.anytime, ...day.earlier]
              .filter((item) => item.activityId === ACTIVITY)
              .map((item) => ({ date: day.date, item })),
          ),
        }),
      },
    });
    const recoveryCoordinator = new NativeActivityActionCoordinator(
      OWNER,
      transactions,
      service,
      outbox,
      recoverySync,
    );
    await expect(
      recoveryCoordinator.discardBlocked('failed-rollback-edit', clock),
    ).resolves.toBe(true);
    await recoverySync.syncNow();
    recoverySync.stop();

    expect(await outbox.all()).toEqual([]);
    expect(
      await database.first(
        'SELECT title, local_state FROM activities WHERE activity_id = ?;',
        [ACTIVITY],
      ),
    ).toEqual({ title: 'Canonical seed', local_state: 'canonical' });
    expect(
      await database.all(
        'SELECT title, local_state FROM agenda_rows WHERE activity_id = ?;',
        [ACTIVITY],
      ),
    ).toEqual([{ title: 'Canonical seed', local_state: 'canonical' }]);
  });

  it('recovers the exact rejected occurrence and its Agenda rows before Discard', async () => {
    await seedRecurring();
    const target = {
      kind: 'occurrence' as const,
      activityId: ACTIVITY,
      date: '2026-08-19',
    };
    const canonical = await activities.read(target);
    const canonicalAgenda = await agenda.read({
      from: '2026-08-19',
      to: '2026-08-19',
      timezone: 'UTC',
      include: 'anytime_unscheduled,overdue',
    });
    if (canonical === undefined) throw new Error('missing occurrence recovery fixture');
    await transactions.run((transaction) =>
      service.complete(
        transaction,
        {
          activityId: ACTIVITY,
          idempotencyKey: 'rejected-occurrence-complete',
          input: { occurrenceDate: target.date },
        },
        true,
        'scheduled',
        clock,
      ),
    );
    const rejectingSync = syncEngine({
      push: {
        ...pushTransport(),
        complete: async () => {
          throw new ApiError(
            'validation_failed',
            'Occurrence completion rejected',
            422,
            'req_occurrence_rejection',
          );
        },
      },
      pull: {
        ...pullAdapter(),
        activity: async () => {
          throw new NetworkError('Occurrence rollback is offline.', undefined);
        },
      },
    });

    await expect(rejectingSync.syncNow()).rejects.toThrow(
      'Occurrence completion rejected',
    );
    rejectingSync.stop();
    expect((await outbox.all())[0]).toMatchObject({
      intentId: 'rejected-occurrence-complete',
      recoveryRequired: true,
    });
    expect(
      await database?.first(
        `SELECT status, local_state FROM activity_occurrences
         WHERE activity_id = ? AND nominal_date = ?;`,
        [ACTIVITY, target.date],
      ),
    ).toMatchObject({ status: 'completed_occurrence' });

    const mismatchedSync = syncEngine({
      pull: { ...pullAdapter(), activity: async () => canonical },
      targeted: {
        load: async () => ({
          activityId: ACTIVITY,
          activityVersion: '2026-08-19T23:59:00.000Z',
          rows: [],
        }),
      },
    });
    const mismatchedCoordinator = new NativeActivityActionCoordinator(
      OWNER,
      transactions,
      service,
      outbox,
      mismatchedSync,
    );
    await expect(
      mismatchedCoordinator.discardBlocked('rejected-occurrence-complete', clock),
    ).resolves.toBe(false);
    mismatchedSync.stop();
    expect((await outbox.all())[0]).toMatchObject({
      intentId: 'rejected-occurrence-complete',
      recoveryRequired: true,
    });

    const detailRead = vi.fn<ActivityPullAdapter['activity']>(async () => canonical);
    const targetedRead = vi.fn(async () => ({
      activityId: ACTIVITY,
      activityVersion: canonical.activity.updatedAt,
      rows: canonicalAgenda.days.flatMap((day) =>
        [...day.schedule, ...day.anytime, ...day.earlier]
          .filter((item) => item.activityId === ACTIVITY)
          .map((item) => ({ date: day.date, item })),
      ),
    }));
    const recoverySync = syncEngine({
      pull: { ...pullAdapter(), activity: detailRead },
      targeted: { load: targetedRead },
    });
    const coordinator = new NativeActivityActionCoordinator(
      OWNER,
      transactions,
      service,
      outbox,
      recoverySync,
    );

    await expect(
      coordinator.discardBlocked('rejected-occurrence-complete', clock),
    ).resolves.toBe(true);
    await recoverySync.syncNow();
    recoverySync.stop();

    expect(detailRead).toHaveBeenCalledWith(target);
    expect(targetedRead).toHaveBeenCalledTimes(1);
    expect(await outbox.all()).toEqual([]);
    expect(
      await database?.first(
        `SELECT status, local_state FROM activity_occurrences
         WHERE activity_id = ? AND nominal_date = ?;`,
        [ACTIVITY, target.date],
      ),
    ).toEqual({ status: 'scheduled', local_state: 'canonical' });
    expect(
      await database?.all(
        `SELECT status, local_state FROM agenda_rows
         WHERE activity_id = ? AND occurrence_date = ?;`,
        [ACTIVITY, target.date],
      ),
    ).toEqual([{ status: 'scheduled', local_state: 'canonical' }]);
  });

  it('treats an occurrence rollback 404 as exact absence without deleting its parent', async () => {
    await seedRecurring();
    const parent = await activities.read({ kind: 'activity', activityId: ACTIVITY });
    if (parent === undefined) throw new Error('missing occurrence rollback 404 fixture');
    const canonicalParent: typeof parent = {
      ...parent,
      activity: {
        ...parent.activity,
        recurrence: {
          mode: 'fixed',
          segments: [
            {
              freq: 'weekly',
              interval: 1,
              byWeekday: [4],
              effectiveFrom: '2026-08-20',
            },
          ],
        },
        updatedAt: '2026-08-20T00:00:00.000Z',
      },
    };
    const previousAgenda = await agenda.read({
      from: '2026-08-19',
      to: '2026-08-19',
      timezone: 'UTC',
    });
    const canonicalAgenda = {
      ...previousAgenda,
      days: previousAgenda.days.map((day) => {
        const { upNext: _upNext, ...rest } = day;
        return {
          ...rest,
          schedule: day.schedule.filter((item) => item.activityId !== ACTIVITY),
          anytime: day.anytime.filter((item) => item.activityId !== ACTIVITY),
          earlier: day.earlier.filter((item) => item.activityId !== ACTIVITY),
        };
      }),
    };
    await transactions.run((transaction) =>
      service.complete(
        transaction,
        {
          activityId: ACTIVITY,
          idempotencyKey: 'immediate-occurrence-404',
          input: { occurrenceDate: '2026-08-19' },
        },
        true,
        'scheduled',
        clock,
      ),
    );
    const detailRead = vi.fn<ActivityPullAdapter['activity']>(async (target) => {
      if (target.kind === 'occurrence') {
        throw new ApiError('not_found', 'Occurrence is gone', 404, 'req_occurrence_gone');
      }
      return canonicalParent;
    });
    const rejectingSync = syncEngine({
      push: {
        ...pushTransport(),
        complete: async () => {
          throw new ApiError(
            'validation_failed',
            'Occurrence completion rejected',
            422,
            'req_occurrence_rejected',
          );
        },
      },
      pull: {
        ...pullAdapter(),
        activity: detailRead,
        agenda: async () => canonicalAgenda,
      },
    });

    await expect(rejectingSync.syncNow()).rejects.toThrow(
      'Occurrence completion rejected',
    );
    rejectingSync.stop();

    expect(detailRead).toHaveBeenNthCalledWith(1, {
      kind: 'occurrence',
      activityId: ACTIVITY,
      date: '2026-08-19',
    });
    expect(detailRead).toHaveBeenNthCalledWith(2, {
      kind: 'activity',
      activityId: ACTIVITY,
    });
    const rejected = (await outbox.all())[0];
    expect(rejected).toMatchObject({
      intentId: 'immediate-occurrence-404',
      status: 'needs_attention',
    });
    expect(rejected).not.toHaveProperty('recoveryRequired');
    expect(
      await database?.first(
        'SELECT local_state, canonical_version FROM activities WHERE activity_id = ?;',
        [ACTIVITY],
      ),
    ).toEqual({
      local_state: 'canonical',
      canonical_version: canonicalParent.activity.updatedAt,
    });
    expect(
      await database?.first(
        `SELECT nominal_date FROM activity_occurrences
         WHERE activity_id = ? AND nominal_date = ?;`,
        [ACTIVITY, '2026-08-19'],
      ),
    ).toBeUndefined();
    expect(
      await database?.first(
        `SELECT occurrence_date FROM agenda_rows
         WHERE activity_id = ? AND occurrence_date = ?;`,
        [ACTIVITY, '2026-08-19'],
      ),
    ).toBeUndefined();
    expect(
      await database?.first(
        'SELECT activity_id FROM activity_tombstones WHERE activity_id = ?;',
        [ACTIVITY],
      ),
    ).toBeUndefined();
  });

  it('survives restart and Discard treats an Activity 404 as authoritative absence', async () => {
    if (database === undefined) throw new Error('missing Activity 404 recovery database');
    const canonical = await activities.read({ kind: 'activity', activityId: ACTIVITY });
    if (canonical === undefined) throw new Error('missing Activity 404 recovery fixture');
    await transactions.run(async (transaction) => {
      await anytime.acceptCanonicalActivity(transaction, canonical.activity);
      await transaction.database.run(
        `INSERT INTO activity_reminders (
          reminder_id, activity_id, owner_user_id, offset_minutes, channel, local_state
        ) VALUES (?, ?, ?, -10, 'push', 'canonical');`,
        [REMINDER, ACTIVITY, OWNER],
      );
      await transaction.database.run(
        `INSERT INTO activity_occurrences (
          activity_id, nominal_date, viewer_date, status, is_snoozed, local_state
        ) VALUES (?, '2026-08-19', '2026-08-19', 'scheduled', 0, 'canonical');`,
        [ACTIVITY],
      );
      transaction.changed('anytime');
      transaction.changed('reminders');
    });
    await transactions.run((transaction) =>
      service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'activity-404-recovery',
        input: { title: 'Rejected before remote deletion' },
        ifMatch: 'v1',
      }),
    );
    const rejectingSync = syncEngine({
      push: {
        ...pushTransport(),
        patch: async () => {
          throw new ApiError(
            'validation_failed',
            'Rejected before remote deletion',
            422,
            'req_activity_404_rejection',
          );
        },
      },
      pull: {
        ...pullAdapter(),
        activity: async () => {
          throw new NetworkError('Rollback detail is offline.', undefined);
        },
      },
    });
    await expect(rejectingSync.syncNow()).rejects.toThrow(
      'Rejected before remote deletion',
    );
    rejectingSync.stop();

    await database.close();
    database = await createNodeSqliteFactory(directory).open('sync.sqlite');
    const restartedSubscriptions = new RepositorySubscriptions();
    transactions = new SerializedTransactionRunner(database, restartedSubscriptions);
    activities = new ActivityRepository(database, restartedSubscriptions);
    agenda = new AgendaRepository(database, restartedSubscriptions);
    anytime = new AnytimeRepository(database, restartedSubscriptions);
    outbox = new OutboxRepository(database);
    service = new ActivityTransactionService(outbox, activities, agenda);

    const detailRead = vi.fn<ActivityPullAdapter['activity']>(async () => {
      throw new ApiError('not_found', 'Activity is gone', 404, 'req_activity_gone');
    });
    const recoverySync = syncEngine({
      pull: { ...pullAdapter(), activity: detailRead },
    });
    const coordinator = new NativeActivityActionCoordinator(
      OWNER,
      transactions,
      service,
      outbox,
      recoverySync,
    );

    await expect(
      coordinator.discardBlocked('activity-404-recovery', clock),
    ).resolves.toBe(true);
    await recoverySync.syncNow();
    recoverySync.stop();

    expect(detailRead).toHaveBeenCalledWith({
      kind: 'activity',
      activityId: ACTIVITY,
    });
    expect(await outbox.all()).toEqual([]);
    for (const table of [
      'activities',
      'activity_occurrences',
      'activity_reminders',
      'agenda_rows',
      'anytime_rows',
    ]) {
      expect(
        await database.first(
          `SELECT activity_id FROM ${table} WHERE activity_id = ? LIMIT 1;`,
          [ACTIVITY],
        ),
      ).toBeUndefined();
    }
    expect(
      await database.first(
        'SELECT activity_id FROM activity_tombstones WHERE activity_id = ?;',
        [ACTIVITY],
      ),
    ).toEqual({ activity_id: ACTIVITY });
  });

  it('survives restart and Discard removes an authoritatively absent occurrence only', async () => {
    if (database === undefined)
      throw new Error('missing occurrence 404 recovery database');
    await seedRecurring();
    const parent = await activities.read({ kind: 'activity', activityId: ACTIVITY });
    if (parent === undefined) throw new Error('missing occurrence 404 parent fixture');
    await transactions.run((transaction) =>
      service.complete(
        transaction,
        {
          activityId: ACTIVITY,
          idempotencyKey: 'occurrence-404-recovery',
          input: { occurrenceDate: '2026-08-19' },
        },
        true,
        'scheduled',
        clock,
      ),
    );
    const rejectingSync = syncEngine({
      push: {
        ...pushTransport(),
        complete: async () => {
          throw new ApiError(
            'validation_failed',
            'Occurrence rejected before recurrence changed',
            422,
            'req_occurrence_404_rejection',
          );
        },
      },
      pull: {
        ...pullAdapter(),
        activity: async () => {
          throw new NetworkError('Occurrence rollback is offline.', undefined);
        },
      },
    });
    await expect(rejectingSync.syncNow()).rejects.toThrow(
      'Occurrence rejected before recurrence changed',
    );
    rejectingSync.stop();

    await database.close();
    database = await createNodeSqliteFactory(directory).open('sync.sqlite');
    const restartedSubscriptions = new RepositorySubscriptions();
    transactions = new SerializedTransactionRunner(database, restartedSubscriptions);
    activities = new ActivityRepository(database, restartedSubscriptions);
    agenda = new AgendaRepository(database, restartedSubscriptions);
    anytime = new AnytimeRepository(database, restartedSubscriptions);
    outbox = new OutboxRepository(database);
    service = new ActivityTransactionService(outbox, activities, agenda);

    const canonicalParent: typeof parent = {
      ...parent,
      activity: {
        ...parent.activity,
        recurrence: {
          mode: 'fixed',
          segments: [
            {
              freq: 'weekly',
              interval: 1,
              byWeekday: [4],
              effectiveFrom: '2026-08-19',
            },
          ],
        },
        updatedAt: '2026-08-20T00:00:00.000Z',
      },
    };
    const detailRead = vi.fn<ActivityPullAdapter['activity']>(async (target) => {
      if (target.kind === 'occurrence') {
        throw new ApiError('not_found', 'Occurrence is gone', 404, 'req_occurrence_gone');
      }
      return canonicalParent;
    });
    const targetedRead = vi.fn(async () => ({
      activityId: ACTIVITY,
      activityVersion: canonicalParent.activity.updatedAt,
      rows: [],
    }));
    const recoverySync = syncEngine({
      pull: { ...pullAdapter(), activity: detailRead },
      targeted: { load: targetedRead },
    });
    const coordinator = new NativeActivityActionCoordinator(
      OWNER,
      transactions,
      service,
      outbox,
      recoverySync,
    );

    await expect(
      coordinator.discardBlocked('occurrence-404-recovery', clock),
    ).resolves.toBe(true);
    await recoverySync.syncNow();
    recoverySync.stop();

    expect(detailRead).toHaveBeenNthCalledWith(1, {
      kind: 'occurrence',
      activityId: ACTIVITY,
      date: '2026-08-19',
    });
    expect(detailRead).toHaveBeenNthCalledWith(2, {
      kind: 'activity',
      activityId: ACTIVITY,
    });
    expect(targetedRead).toHaveBeenCalledTimes(1);
    expect(await outbox.all()).toEqual([]);
    expect(
      await database.first(
        'SELECT local_state, canonical_version FROM activities WHERE activity_id = ?;',
        [ACTIVITY],
      ),
    ).toEqual({
      local_state: 'canonical',
      canonical_version: canonicalParent.activity.updatedAt,
    });
    expect(
      await database.first(
        `SELECT nominal_date FROM activity_occurrences
         WHERE activity_id = ? AND nominal_date = ?;`,
        [ACTIVITY, '2026-08-19'],
      ),
    ).toBeUndefined();
    expect(
      await database.first(
        `SELECT occurrence_date FROM agenda_rows
         WHERE activity_id = ? AND occurrence_date = ?;`,
        [ACTIVITY, '2026-08-19'],
      ),
    ).toBeUndefined();
    expect(
      await database.first(
        'SELECT activity_id FROM activity_tombstones WHERE activity_id = ?;',
        [ACTIVITY],
      ),
    ).toBeUndefined();
  });

  it('parks later same-activity work when its predecessor is rejected', async () => {
    const canonical = await activities.read({ kind: 'activity', activityId: ACTIVITY });
    if (canonical === undefined) throw new Error('missing ordered rejection fixture');
    await transactions.run(async (transaction) => {
      await service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'rejected-first',
        input: { title: 'Rejected first' },
        ifMatch: 'v1',
      });
      await service.patch(transaction, {
        activityId: ACTIVITY,
        intentId: 'blocked-second',
        input: { title: 'Depends on first' },
        ifMatch: 'v1',
      });
    });
    const sync = syncEngine({
      push: {
        ...pushTransport(),
        patch: async () => {
          throw new ApiError('validation_failed', 'Rejected first', 422, 'req_order');
        },
      },
      pull: { ...pullAdapter(), activity: async () => canonical },
    });

    await expect(sync.syncNow()).rejects.toThrow('Rejected first');
    sync.stop();

    expect(await outbox.all()).toMatchObject([
      {
        intentId: 'rejected-first',
        status: 'needs_attention',
        attention: { kind: 'rejected', status: 422 },
      },
      {
        intentId: 'blocked-second',
        status: 'needs_attention',
        attention: { kind: 'parked', reason: 'predecessor_rejected' },
      },
    ]);
    expect(
      await database?.first(
        'SELECT title, local_state FROM activities WHERE activity_id = ?;',
        [ACTIVITY],
      ),
    ).toMatchObject({ title: 'Canonical seed', local_state: 'canonical' });
  });

  it('restores an activity after its optimistic delete is permanently rejected', async () => {
    const canonical = await activities.read({ kind: 'activity', activityId: ACTIVITY });
    if (canonical === undefined) throw new Error('missing delete rejection fixture');
    await transactions.run((transaction) =>
      service.remove(transaction, { activityId: ACTIVITY, intentId: 'rejected-delete' }),
    );
    expect(
      await activities.read({ kind: 'activity', activityId: ACTIVITY }),
    ).toBeUndefined();
    const sync = syncEngine({
      push: {
        ...pushTransport(),
        remove: async () => {
          throw new ApiError(
            'forbidden',
            'Cannot delete this activity',
            403,
            'req_delete',
          );
        },
      },
      pull: { ...pullAdapter(), activity: async () => canonical },
    });

    await expect(sync.syncNow()).rejects.toThrow('Cannot delete this activity');
    sync.stop();

    expect((await outbox.all())[0]).toMatchObject({
      intentId: 'rejected-delete',
      status: 'needs_attention',
      attention: { kind: 'rejected', status: 403 },
    });
    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity.title,
    ).toBe('Canonical seed');
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

  it.each([
    ['Task', false],
    ['Task', true],
    ['Plan', false],
    ['Plan', true],
  ] as const)(
    'installs clock-skewed canonical capabilities for a %s (scheduled=%s)',
    async (kind, scheduled) => {
      const input: CreateActivityInput =
        kind === 'Task'
          ? {
              activityId: OTHER,
              objectKind: 'task',
              type: 'task',
              title: `${kind} created ahead of server`,
              ...(scheduled
                ? { schedule: { date: '2026-08-19', time: '10:00', timezone: 'UTC' } }
                : {}),
            }
          : {
              activityId: OTHER,
              objectKind: 'plan',
              type: 'custom',
              title: `${kind} created ahead of server`,
              ...(scheduled
                ? { schedule: { date: '2026-08-19', time: '10:00', timezone: 'UTC' } }
                : {}),
            };
      await transactions.run((transaction) =>
        service.create(
          transaction,
          OWNER,
          { input, idempotencyKey: `clock-skew-${kind}-${scheduled}` },
          clock,
          '2026-08-19T23:00:00.000Z',
        ),
      );
      expect(
        await database?.first(
          'SELECT canonical_version FROM activities WHERE activity_id = ?;',
          [OTHER],
        ),
      ).toEqual({ canonical_version: null });
      const local = await activities.read({ kind: 'activity', activityId: OTHER });
      if (local === undefined) throw new Error('missing clock-skew create fixture');
      const serverVersion = '2026-08-19T02:00:00.000Z';
      const canonicalActivity: Activity = {
        ...local.activity,
        createdAt: '2026-08-19T01:00:00.000Z',
        lastActivityAt: serverVersion,
        updatedAt: serverVersion,
      };
      const canonicalDetail = {
        activity: canonicalActivity,
        reminders: [],
        capabilities: { complete: true, skip: true, snooze: true },
        completedOccurrenceCount: 0,
      };
      const create = vi.fn(async () => canonicalActivity);
      const pullActivity = vi.fn(async () => canonicalDetail);
      const sync = syncEngine({
        push: { ...pushTransport(), create },
        pull: { ...pullAdapter(), activity: pullActivity },
      });

      await sync.syncNow();
      sync.stop();

      expect(create).toHaveBeenCalledTimes(1);
      expect(pullActivity).toHaveBeenCalledTimes(1);
      expect(await outbox.forEntity(OTHER)).toEqual([]);
      expect(
        await database?.first(
          `SELECT local_state, canonical_version
           FROM activities WHERE activity_id = ?;`,
          [OTHER],
        ),
      ).toEqual({ local_state: 'canonical', canonical_version: serverVersion });
      expect(
        (await activities.read({ kind: 'activity', activityId: OTHER }))?.capabilities
          ?.complete,
      ).toBe(true);
    },
  );

  it('acknowledges a create without overwriting a later local intent', async () => {
    await transactions.run((transaction) =>
      service.create(
        transaction,
        OWNER,
        {
          input: {
            activityId: OTHER,
            objectKind: 'task',
            type: 'task',
            title: 'Initial local create',
          },
          idempotencyKey: 'create-before-later-intent',
        },
        clock,
        '2026-08-19T23:00:00.000Z',
      ),
    );
    const local = await activities.read({ kind: 'activity', activityId: OTHER });
    if (local === undefined) throw new Error('missing later-create-intent fixture');
    let releaseCreate: ((activity: Activity) => void) | undefined;
    let releasePatch: ((activity: Activity) => void) | undefined;
    const createResponse = new Promise<Activity>((resolve) => {
      releaseCreate = resolve;
    });
    const patchResponse = new Promise<Activity>((resolve) => {
      releasePatch = resolve;
    });
    const create = vi.fn(() => createResponse);
    const patch = vi.fn(() => patchResponse);
    const sync = syncEngine({ push: { ...pushTransport(), create, patch } });
    const running = sync.syncNow();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    await transactions.run(async (transaction) => {
      await outbox.append(transaction.database, {
        intentId: 'later-create-patch',
        mutationKey: ['activity', 'patch'],
        variables: {
          activityId: OTHER,
          intentId: 'later-create-patch',
          input: { title: 'Later local title' },
          ifMatch: 'v0',
          changeNames: ['title'],
        },
        entityId: OTHER,
      });
      await activities.patchLocal(
        transaction,
        OTHER,
        { title: 'Later local title' },
        'queued',
      );
      transaction.changed('outbox');
    });
    releaseCreate?.({
      ...local.activity,
      title: 'Create response title',
      updatedAt: '2026-08-19T02:00:00.000Z',
    });
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(1));

    expect(
      (await activities.read({ kind: 'activity', activityId: OTHER }))?.activity.title,
    ).toBe('Later local title');
    expect(await outbox.forEntity(OTHER)).toMatchObject([
      { intentId: 'later-create-patch', status: 'in_flight' },
    ]);
    const later = await activities.read({ kind: 'activity', activityId: OTHER });
    if (later === undefined) throw new Error('missing later local projection');
    releasePatch?.({
      ...later.activity,
      updatedAt: '2026-08-19T03:00:00.000Z',
    });
    await running;
    sync.stop();
  });

  it('keeps distinct identities and capabilities across create-delete-create at one time', async () => {
    const serverActivities = new Map<string, Activity>();
    const create = vi.fn<ActivityPushTransport['create']>(async (input) => {
      if (input.activityId === undefined) throw new Error('missing stable create id');
      const local = await activities.read({
        kind: 'activity',
        activityId: input.activityId,
      });
      if (local === undefined) throw new Error('missing repeated-create projection');
      const canonicalActivity = {
        ...local.activity,
        updatedAt:
          input.activityId === OTHER
            ? '2026-08-19T02:00:00.000Z'
            : '2026-08-19T04:00:00.000Z',
      };
      serverActivities.set(input.activityId, canonicalActivity);
      return canonicalActivity;
    });
    const remove = vi.fn<ActivityPushTransport['remove']>(async (activityId) => {
      serverActivities.delete(activityId);
    });
    const pullActivity = vi.fn<ActivityPullAdapter['activity']>(async (target) => {
      const activity = serverActivities.get(target.activityId);
      if (activity === undefined) throw new Error('missing repeated-create server row');
      return {
        activity,
        reminders: [],
        capabilities: { complete: true, skip: true, snooze: true },
      };
    });
    const sync = syncEngine({
      push: { ...pushTransport(), create, remove },
      pull: { ...pullAdapter(), activity: pullActivity },
    });
    const sameTime = {
      date: '2026-08-19',
      time: '10:00',
      timezone: 'UTC',
    } as const;

    await transactions.run((transaction) =>
      service.create(
        transaction,
        OWNER,
        {
          input: {
            activityId: OTHER,
            objectKind: 'task',
            type: 'task',
            title: 'First identity',
            schedule: sameTime,
          },
          idempotencyKey: 'repeat-create-one',
        },
        clock,
        '2026-08-19T23:00:00.000Z',
      ),
    );
    await sync.syncNow();
    expect(
      (await activities.read({ kind: 'activity', activityId: OTHER }))?.capabilities
        ?.complete,
    ).toBe(true);

    await transactions.run((transaction) =>
      service.remove(transaction, {
        activityId: OTHER,
        intentId: 'repeat-delete-one',
      }),
    );
    await sync.syncNow();
    expect(
      await activities.read({ kind: 'activity', activityId: OTHER }),
    ).toBeUndefined();

    await transactions.run((transaction) =>
      service.create(
        transaction,
        OWNER,
        {
          input: {
            activityId: THIRD,
            objectKind: 'task',
            type: 'task',
            title: 'Final identity',
            schedule: sameTime,
          },
          idempotencyKey: 'repeat-create-two',
        },
        clock,
        '2026-08-20T23:00:00.000Z',
      ),
    );
    await sync.syncNow();
    sync.stop();

    expect(OTHER).not.toBe(THIRD);
    expect(await outbox.forEntity(THIRD)).toEqual([]);
    expect(await activities.read({ kind: 'activity', activityId: THIRD })).toMatchObject({
      activity: { activityId: THIRD, title: 'Final identity' },
      capabilities: { complete: true },
    });
  });

  it('clears Pending after a transiently offline create receives its canonical response', async () => {
    await transactions.run((transaction) =>
      service.create(
        transaction,
        OWNER,
        {
          input: {
            activityId: OTHER,
            objectKind: 'plan',
            type: 'custom',
            title: 'Offline plan',
            schedule: { date: '2026-08-19', time: '10:00', timezone: 'UTC' },
          },
          idempotencyKey: 'offline-create',
        },
        clock,
        '2026-08-19T01:00:00.000Z',
      ),
    );
    const local = await activities.read({ kind: 'activity', activityId: OTHER });
    if (local === undefined) throw new Error('missing offline create fixture');
    const canonical = {
      ...local.activity,
      updatedAt: '2026-08-19T02:00:00.000Z',
    };
    const canonicalDetail = {
      activity: canonical,
      reminders: [],
      capabilities: { complete: true, skip: true, snooze: true },
      completedOccurrenceCount: 0,
    };
    const create = vi
      .fn<ActivityPushTransport['create']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(canonical);
    const pullActivity = vi.fn(async () => canonicalDetail);
    const sync = syncEngine({
      push: { ...pushTransport(), create },
      pull: { ...pullAdapter(), activity: pullActivity },
    });

    await expect(sync.syncNow()).rejects.toThrow('offline');
    expect(await outbox.forEntity(OTHER)).toMatchObject([
      { intentId: 'offline-create', status: 'queued' },
    ]);

    await sync.syncNow();
    sync.stop();

    expect(create).toHaveBeenCalledTimes(2);
    expect(pullActivity).toHaveBeenCalledTimes(1);
    expect(await outbox.forEntity(OTHER)).toEqual([]);
    expect(
      (await activities.read({ kind: 'activity', activityId: OTHER }))?.capabilities,
    ).toEqual({ complete: true, skip: true, snooze: true });
    expect(
      await database?.first('SELECT local_state FROM activities WHERE activity_id = ?;', [
        OTHER,
      ]),
    ).toEqual({ local_state: 'canonical' });
    expect(
      await database?.all(
        'SELECT DISTINCT local_state FROM agenda_rows WHERE activity_id = ?;',
        [OTHER],
      ),
    ).toEqual([{ local_state: 'canonical' }]);
  });

  it('retries earlier offline creates when connectivity returns during a multi-create drain', async () => {
    await transactions.run(async (transaction) => {
      await service.create(
        transaction,
        OWNER,
        {
          input: {
            activityId: OTHER,
            objectKind: 'plan',
            type: 'custom',
            title: 'First offline plan',
            schedule: { date: '2026-08-19', time: '10:00', timezone: 'UTC' },
          },
          idempotencyKey: 'offline-create-first',
        },
        clock,
        '2026-08-19T01:00:00.000Z',
      );
      await service.create(
        transaction,
        OWNER,
        {
          input: {
            activityId: THIRD,
            objectKind: 'plan',
            type: 'custom',
            title: 'Second offline plan',
            schedule: { date: '2026-08-19', time: '11:00', timezone: 'UTC' },
          },
          idempotencyKey: 'offline-create-second',
        },
        clock,
        '2026-08-19T01:01:00.000Z',
      );
    });
    const first = await activities.read({ kind: 'activity', activityId: OTHER });
    const second = await activities.read({ kind: 'activity', activityId: THIRD });
    if (first === undefined || second === undefined) {
      throw new Error('missing multi-create fixtures');
    }
    const canonical = new Map([
      [OTHER, { ...first.activity, updatedAt: '2026-08-19T02:00:00.000Z' }],
      [THIRD, { ...second.activity, updatedAt: '2026-08-19T02:01:00.000Z' }],
    ]);
    let firstAttempts = 0;
    let announceSecondStarted: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolve) => {
      announceSecondStarted = resolve;
    });
    const secondMayFinish = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const dispatched: string[] = [];
    const create = vi.fn<ActivityPushTransport['create']>(async (input) => {
      const activityId = input.activityId;
      if (activityId === undefined) throw new Error('missing create identity');
      dispatched.push(activityId);
      if (activityId === OTHER && firstAttempts++ === 0) {
        throw new NetworkError('The first create is still offline.', undefined);
      }
      if (activityId === THIRD) {
        announceSecondStarted?.();
        await secondMayFinish;
      }
      const result = canonical.get(activityId);
      if (result === undefined) throw new Error('missing canonical create fixture');
      return result;
    });
    const pullActivity = vi.fn(async (target: { readonly activityId: string }) => {
      const activity = canonical.get(target.activityId);
      if (activity === undefined) throw new Error('missing canonical detail fixture');
      return {
        activity,
        reminders: [],
        capabilities: { complete: true, skip: true, snooze: true },
        completedOccurrenceCount: 0,
      };
    });
    const sync = syncEngine({
      push: { ...pushTransport(), create },
      pull: { ...pullAdapter(), activity: pullActivity },
    });

    const running = sync.syncNow();
    await secondStarted;
    sync.request('connectivity');
    releaseSecond?.();
    await expect(running).rejects.toThrow('The first create is still offline.');
    sync.stop();

    expect(dispatched).toEqual([OTHER, THIRD, OTHER]);
    expect(await outbox.all()).toEqual([]);
    expect(
      await database?.all(
        `SELECT activity_id, local_state FROM activities
         WHERE activity_id IN (?, ?) ORDER BY activity_id;`,
        [OTHER, THIRD],
      ),
    ).toEqual([
      { activity_id: OTHER, local_state: 'canonical' },
      { activity_id: THIRD, local_state: 'canonical' },
    ]);
  });

  it('still settles a successful create when detail enrichment is unavailable', async () => {
    await transactions.run((transaction) =>
      service.create(
        transaction,
        OWNER,
        {
          input: {
            activityId: OTHER,
            objectKind: 'task',
            type: 'task',
            title: 'Created before detail is readable',
          },
          idempotencyKey: 'create-with-lagging-detail',
        },
        clock,
        '2026-08-19T01:00:00.000Z',
      ),
    );
    const local = await activities.read({ kind: 'activity', activityId: OTHER });
    if (local === undefined) throw new Error('missing create enrichment fixture');
    const canonicalActivity = {
      ...local.activity,
      updatedAt: '2026-08-19T02:00:00.000Z',
    };
    const create = vi.fn(async () => canonicalActivity);
    const detail = vi.fn(async () => {
      throw new Error('detail projection is not readable yet');
    });
    const sync = syncEngine({
      push: { ...pushTransport(), create },
      pull: { ...pullAdapter(), activity: detail },
    });

    await sync.syncNow();
    sync.stop();

    expect(create).toHaveBeenCalledTimes(1);
    expect(detail).toHaveBeenCalledTimes(1);
    expect(await outbox.forEntity(OTHER)).toEqual([]);
    expect(
      await database?.first(
        `SELECT local_state, canonical_version, capabilities_json
         FROM activities WHERE activity_id = ?;`,
        [OTHER],
      ),
    ).toEqual({
      local_state: 'canonical',
      canonical_version: canonicalActivity.updatedAt,
      capabilities_json: null,
    });

    const hydrate = syncEngine({
      pull: {
        ...pullAdapter(),
        activity: async () => ({
          activity: canonicalActivity,
          reminders: [],
          capabilities: { complete: true, skip: true, snooze: true },
        }),
      },
    });
    await expect(
      hydrate.pullActivity({ kind: 'activity', activityId: OTHER }),
    ).resolves.toMatchObject({ capabilities: { complete: true } });
    hydrate.stop();
    expect(
      (await activities.read({ kind: 'activity', activityId: OTHER }))?.activity
        .updatedAt,
    ).toBe(canonicalActivity.updatedAt);
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
      include: 'anytime_unscheduled,overdue',
    });
  });

  it('does not repeat coverage already present in the active pull snapshot', async () => {
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
    const sync = syncEngine({ pull: { ...pullAdapter(), agenda: agendaPull } });

    sync.request('foreground');
    await vi.waitFor(() => expect(agendaPull).toHaveBeenCalledTimes(1));
    const sameCoverage = sync.pullAgenda({
      from: '2026-08-19',
      to: '2026-08-19',
      tz: 'UTC',
    });
    release?.();

    await sameCoverage;
    sync.stop();
    expect(agendaPull).toHaveBeenCalledTimes(1);
  });

  it('refreshes only the latest persisted window in each coverage domain', async () => {
    await database?.exec(`
      INSERT INTO agenda_coverage
        (from_date, to_date, timezone, include_key, refreshed_at, warnings_json)
      VALUES
        ('2026-08-20', '2026-10-20', 'UTC', '', 'now', '[]'),
        ('2026-08-21', '2026-10-21', 'UTC', '', 'now', '[]'),
        ('2026-08-19', '2026-08-26', 'UTC', 'reminders', 'now', '[]'),
        ('2026-08-20', '2026-08-27', 'UTC', 'reminders', 'now', '[]');
    `);
    const agendaPull = vi.fn(pullAdapter().agenda);
    const sync = syncEngine({ pull: { ...pullAdapter(), agenda: agendaPull } });

    await sync.syncNow();
    sync.stop();

    expect(agendaPull.mock.calls.map(([request]) => request)).toEqual([
      {
        from: '2026-08-21',
        to: '2026-10-21',
        tz: 'UTC',
        include: 'anytime_unscheduled,overdue',
      },
      {
        from: '2026-08-20',
        to: '2026-08-27',
        tz: 'UTC',
        include: 'anytime_unscheduled,overdue,reminders',
      },
    ]);
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

  it('prioritizes a targeted detail read ahead of the next background coverage pull', async () => {
    const canonical = await activities.read({ kind: 'activity', activityId: ACTIVITY });
    if (canonical === undefined) throw new Error('missing activity fixture');
    await database?.run(
      `INSERT INTO agenda_coverage
        (from_date, to_date, timezone, include_key, refreshed_at, warnings_json)
       VALUES ('2026-08-19', '2026-08-26', 'UTC', 'reminders', 'now', '[]');`,
    );
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const agendaPull = vi.fn(async () => {
      order.push(`agenda-${agendaPull.mock.calls.length}`);
      if (agendaPull.mock.calls.length === 1) await first;
      return { days: [], warnings: [] };
    });
    const activityPull = vi.fn(async () => {
      order.push('activity');
      return canonical;
    });
    const sync = syncEngine({
      pull: { ...pullAdapter(), agenda: agendaPull, activity: activityPull },
    });

    const foreground = sync.syncNow();
    await vi.waitFor(() => expect(agendaPull).toHaveBeenCalledTimes(1));
    const detail = sync.pullActivity({ kind: 'activity', activityId: ACTIVITY });
    releaseFirst?.();

    await expect(detail).resolves.toMatchObject({ activity: { activityId: ACTIVITY } });
    await vi.waitFor(() => expect(agendaPull).toHaveBeenCalledTimes(2));
    expect(order).toEqual(['agenda-1', 'activity', 'agenda-2']);
    await foreground;
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

  it('persists distinct NUL-free row identities for multiple activities on one date', async () => {
    const coverage = { from: '2026-08-19', to: '2026-08-19', timezone: 'UTC' };
    const current = await agenda.read(coverage);
    const item = current.days[0]?.anytime[0];
    if (item === undefined) throw new Error('missing agenda projection fixture');

    await transactions.run((transaction) =>
      agenda.installCanonical(
        transaction,
        { from: coverage.from, to: coverage.to, tz: coverage.timezone },
        {
          days: [
            {
              date: coverage.from,
              schedule: [],
              anytime: [item, { ...item, activityId: OTHER, title: 'Second activity' }],
              earlier: [],
            },
          ],
          warnings: [],
        },
      ),
    );

    const rows = await database?.all(
      'SELECT row_id, activity_id FROM agenda_rows ORDER BY activity_id;',
    );
    expect(rows).toHaveLength(2);
    expect(rows?.map((row) => row.activity_id)).toEqual([ACTIVITY, OTHER]);
    expect(rows?.every((row) => !String(row.row_id).includes('\u0000'))).toBe(true);
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

  it('reconciles Agenda topology after converting a recurrence to a one-off', async () => {
    const activity = await seedRecurring();
    const before = await agenda.read({
      from: '2026-08-19',
      to: '2026-08-19',
      timezone: 'UTC',
    });
    const recurringItem = before.days[0]?.schedule.find(
      (item) => item.activityId === ACTIVITY,
    );
    if (recurringItem === undefined) throw new Error('missing recurring Agenda row');
    expect(recurringItem.isRecurring).toBe(true);

    await transactions.run((transaction) =>
      service.appendOnly(transaction, 'convert-recurrence', {
        activityId: ACTIVITY,
        idempotencyKey: 'convert-to-one-off',
        input: { selectedDate: '2026-08-19' },
      }),
    );
    const { recurrence: _recurrence, ...oneOff } = activity;
    const converted: Activity = {
      ...oneOff,
      updatedAt: '2026-08-19T12:00:00.000Z',
    };
    const {
      occurrenceDate: _occurrenceDate,
      recurrenceDescription: _recurrenceDescription,
      ...oneOffItem
    } = recurringItem;
    const targeted = vi.fn(async () => ({
      activityId: ACTIVITY,
      activityVersion: converted.updatedAt,
      rows: [
        {
          date: '2026-08-19',
          item: { ...oneOffItem, isRecurring: false },
        },
      ],
    }));
    const convertRecurrence = vi.fn(async () => converted);
    const sync = syncEngine({
      push: { ...pushTransport(), convertRecurrence },
      targeted: { load: targeted },
    });

    await sync.syncNow();
    sync.stop();

    expect(convertRecurrence).toHaveBeenCalledTimes(1);
    expect(targeted).toHaveBeenCalledTimes(1);
    expect(await outbox.all()).toEqual([]);
    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity,
    ).toMatchObject({
      activityId: ACTIVITY,
      updatedAt: converted.updatedAt,
    });
    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity
        .recurrence,
    ).toBeUndefined();
    expect(
      await database?.first(
        `SELECT is_recurring, recurrence_description, occurrence_date, local_state
         FROM agenda_rows WHERE activity_id = ? LIMIT 1;`,
        [ACTIVITY],
      ),
    ).toMatchObject({
      is_recurring: 0,
      recurrence_description: null,
      occurrence_date: null,
      local_state: 'canonical',
    });
  });

  it('retains recurrence rows and receipt on targeted failure, then accepts zero rows on Retry', async () => {
    const activity = await seedRecurring();
    await transactions.run((transaction) =>
      activities.installAcknowledgedActivity(transaction, activity, {
        activity,
        reminders: [],
        capabilities: { complete: true, skip: true, snooze: true },
      }),
    );
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
    expect(await activities.hasInstalledCapabilities(ACTIVITY)).toBe(true);
    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.capabilities,
    ).toEqual({ complete: true, skip: true, snooze: true });
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
        include: 'anytime_unscheduled,overdue',
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
        include: 'anytime_unscheduled,overdue',
      }),
    ).toBeUndefined();
  });

  it('restores canonical List state before Discard retires a failed rollback receipt', async () => {
    if (database === undefined) throw new Error('missing List recovery database');
    const list: List = {
      listId: 'lst_01J0000000000000000000000A',
      ownerId: OWNER,
      behaviour: 'collection',
      templateKey: 'groceries',
      title: 'Groceries',
      icon: 'cart',
      emptyStateCopy: 'Add something to buy.',
      capabilities: { checkable: true, supportsLocation: false },
      slot: null,
      itemCount: 3,
      uncheckedCount: 2,
      memberCount: 1,
      rankVersion: 0,
      archived: false,
      updatedAt: instant.parse('2026-08-19T00:00:00.000Z'),
      lastItemActivityAt: instant.parse('2026-08-19T00:00:00.000Z'),
    };
    const lists = new ListsRepository(database, new RepositorySubscriptions());
    const listService = new ListTransactionService(outbox, lists);
    await transactions.run(async (transaction) => {
      await lists.replaceCanonical(transaction, [list]);
      await listService.setArchived(transaction, list, true, 'list-failed-rollback');
      await outbox.needsAttention(
        transaction.database,
        'list-failed-rollback',
        { kind: 'rejected', status: 422, recoveryRequired: true },
        'List rollback was offline',
      );
    });
    const recoveryEngine = new SerializedNativeSyncEngine(
      transactions,
      outbox,
      activities,
      agenda,
      pushTransport(),
      {
        ...pullAdapter(),
        listsPage: async () => ({ data: [list] }),
      },
      targetedTransport(),
      anytime,
      lists,
    );
    const sync = {
      request: vi.fn(),
      recoverRejectedIntent: (intentId: string) =>
        recoveryEngine.recoverRejectedIntent(intentId),
    } as unknown as SerializedNativeSyncEngine;
    const coordinator = new NativeActivityActionCoordinator(
      OWNER,
      transactions,
      service,
      outbox,
      sync,
      undefined,
      listService,
    );

    await expect(coordinator.discardBlocked('list-failed-rollback', clock)).resolves.toBe(
      true,
    );

    expect(await outbox.all()).toEqual([]);
    expect(await lists.read()).toEqual([list]);
    expect(sync.request).toHaveBeenCalledWith('manual');
    recoveryEngine.stop();
  });

  it('settles an already-archived retry after its unaccepted Undo offer expired', async () => {
    if (database === undefined) throw new Error('missing List retry database');
    const list: List = {
      listId: 'lst_01J0000000000000000000000C',
      ownerId: OWNER,
      behaviour: 'collection',
      templateKey: 'groceries',
      title: 'Groceries',
      icon: 'cart',
      emptyStateCopy: 'Add something to buy.',
      capabilities: { checkable: true, supportsLocation: false },
      slot: null,
      itemCount: 3,
      uncheckedCount: 2,
      memberCount: 1,
      rankVersion: 0,
      archived: false,
      updatedAt: instant.parse('2026-08-19T00:00:00.000Z'),
      lastItemActivityAt: instant.parse('2026-08-19T00:00:00.000Z'),
    };
    const acknowledged = {
      ...list,
      archived: true,
      updatedAt: instant.parse('2026-08-20T00:00:00.000Z'),
    };
    const lists = new ListsRepository(database, new RepositorySubscriptions());
    const listService = new ListTransactionService(outbox, lists);
    await transactions.run(async (transaction) => {
      await lists.replaceCanonical(transaction, [list]);
      await listService.setArchived(transaction, list, true, 'expired-archive-retry');
      // The presentation window elapsed before this retry. With no accepted inverse left,
      // an already-archived server response legitimately carries no new Undo authority.
      await outbox.clearListArchiveUndoOffer(
        transaction.database,
        'expired-archive-retry',
        true,
      );
    });
    const patch = vi.fn(async () => ({ list: acknowledged }));
    const listPush: ListPushTransport = {
      create: async () => {
        throw new Error('unexpected List POST');
      },
      createItem: async () => {
        throw new Error('unexpected list item POST');
      },
      patchItem: async () => {
        throw new Error('unexpected list item PATCH');
      },
      patch,
      changeBehaviour: async () => {
        throw new Error('unexpected List behaviour POST');
      },
      remove: async () => {
        throw new Error('unexpected List DELETE');
      },
      undo: async () => {
        throw new Error('unexpected List Undo');
      },
    };
    const sync = new SerializedNativeSyncEngine(
      transactions,
      outbox,
      activities,
      agenda,
      pushTransport(),
      pullAdapter(),
      targetedTransport(),
      anytime,
      lists,
      listPush,
    );

    await sync.syncNow();
    sync.stop();

    expect(patch).toHaveBeenCalledWith(
      list.listId,
      { archived: true },
      list.updatedAt,
      'expired-archive-retry',
    );
    expect(await lists.read()).toEqual([acknowledged]);
    expect(await outbox.all()).toEqual([]);
  });

  /**
   * The P3-32 inventory extension, settled (§P3-09).
   *
   * A behaviour acknowledgement installs the **whole** canonical row rather than the settings
   * subset: the migration moves `behaviour` and advances `rankVersion`, and `applySettings`
   * writes neither. The Undo token is installed because an offer is waiting for one, which is
   * the enqueue-time decision rather than a re-reading of the payload.
   */
  it('settles a behaviour upgrade with the canonical row and its Undo receipt', async () => {
    if (database === undefined) throw new Error('missing List behaviour database');
    const list: List = {
      listId: 'lst_01J0000000000000000000000D',
      ownerId: OWNER,
      behaviour: 'collection',
      templateKey: 'groceries',
      title: 'Groceries',
      icon: 'cart',
      emptyStateCopy: 'Add something to buy.',
      capabilities: { checkable: true, supportsLocation: false },
      slot: null,
      itemCount: 3,
      uncheckedCount: 2,
      memberCount: 1,
      rankVersion: 0,
      archived: false,
      updatedAt: instant.parse('2026-08-19T00:00:00.000Z'),
      lastItemActivityAt: instant.parse('2026-08-19T00:00:00.000Z'),
    };
    const acknowledged: List = {
      ...list,
      behaviour: 'watch',
      rankVersion: 1,
      updatedAt: instant.parse('2026-08-20T00:00:00.000Z'),
    };
    const lists = new ListsRepository(database, new RepositorySubscriptions());
    const listService = new ListTransactionService(outbox, lists);
    await transactions.run(async (transaction) => {
      await lists.replaceCanonical(transaction, [list]);
      await listService.changeBehaviour(
        transaction,
        list,
        { behaviour: 'watch' },
        'upgrade-intent',
      );
    });
    const changeBehaviour = vi.fn(async () => ({
      list: acknowledged,
      undoToken: 'server-upgrade-token',
      undoExpiresAt: '2026-08-20T00:00:06.000Z',
    }));
    const listPush: ListPushTransport = {
      create: async () => {
        throw new Error('unexpected List POST');
      },
      createItem: async () => {
        throw new Error('unexpected list item POST');
      },
      patchItem: async () => {
        throw new Error('unexpected list item PATCH');
      },
      patch: async () => {
        throw new Error('unexpected List PATCH');
      },
      changeBehaviour,
      remove: async () => {
        throw new Error('unexpected List DELETE');
      },
      undo: async () => {
        throw new Error('unexpected List Undo');
      },
    };
    const sync = new SerializedNativeSyncEngine(
      transactions,
      outbox,
      activities,
      agenda,
      pushTransport(),
      pullAdapter(),
      targetedTransport(),
      anytime,
      lists,
      listPush,
    );

    await sync.syncNow();
    sync.stop();

    expect(changeBehaviour).toHaveBeenCalledWith(
      list.listId,
      { behaviour: 'watch' },
      list.updatedAt,
      'upgrade-intent',
    );
    expect(await lists.read()).toEqual([acknowledged]);
    expect(await outbox.all()).toEqual([]);
    expect(await outbox.listArchiveUndoOffer(database, 'upgrade-intent')).toMatchObject({
      undoToken: 'server-upgrade-token',
      undoExpiresAt: '2026-08-20T00:00:06.000Z',
    });
  });

  it('settles an acknowledged archive Undo without re-entering the network lane', async () => {
    if (database === undefined) throw new Error('missing List Undo database');
    const archived: List = {
      listId: 'lst_01J0000000000000000000000B',
      ownerId: OWNER,
      behaviour: 'collection',
      templateKey: 'groceries',
      title: 'Groceries',
      icon: 'cart',
      emptyStateCopy: 'Add something to buy.',
      capabilities: { checkable: true, supportsLocation: false },
      slot: null,
      itemCount: 3,
      uncheckedCount: 2,
      memberCount: 1,
      rankVersion: 0,
      archived: true,
      updatedAt: instant.parse('2026-08-19T00:01:00.000Z'),
      lastItemActivityAt: instant.parse('2026-08-19T00:00:00.000Z'),
    };
    const restored = {
      ...archived,
      archived: false,
      updatedAt: instant.parse('2026-08-19T00:02:00.000Z'),
    };
    const lists = new ListsRepository(database, new RepositorySubscriptions());
    const listService = new ListTransactionService(outbox, lists);
    await transactions.run(async (transaction) => {
      await lists.replaceCanonical(transaction, [archived]);
      await outbox.createListArchiveUndoOffer(
        transaction.database,
        'acknowledged-archive',
        archived.listId,
      );
      await outbox.recordListArchiveUndoToken(
        transaction.database,
        'acknowledged-archive',
        'server-undo-token',
        '2026-08-19T00:01:06.000Z',
      );
      await listService.undoSettings(
        transaction,
        archived.listId,
        'acknowledged-archive',
        'accepted-list-undo',
      );
    });
    const undo = vi.fn(async () => ({ affectedCount: 1 }));
    const listPush: ListPushTransport = {
      create: async () => {
        throw new Error('unexpected List POST');
      },
      createItem: async () => {
        throw new Error('unexpected list item POST');
      },
      patchItem: async () => {
        throw new Error('unexpected list item PATCH');
      },
      patch: async () => {
        throw new Error('unexpected List PATCH');
      },
      changeBehaviour: async () => {
        throw new Error('unexpected List behaviour POST');
      },
      remove: async () => {
        throw new Error('unexpected List DELETE');
      },
      undo,
    };
    const listsPage = vi.fn(async () => ({ data: [restored] }));
    const sync = new SerializedNativeSyncEngine(
      transactions,
      outbox,
      activities,
      agenda,
      pushTransport(),
      { ...pullAdapter(), listsPage },
      targetedTransport(),
      anytime,
      lists,
      listPush,
    );

    await sync.syncNow();
    sync.stop();

    expect(undo).toHaveBeenCalledWith(
      archived.listId,
      'server-undo-token',
      'accepted-list-undo',
    );
    expect(listsPage).toHaveBeenCalledTimes(1);
    expect(await lists.read()).toEqual([restored]);
    expect(await outbox.all()).toEqual([]);
    expect(
      await outbox.listArchiveUndoOffer(database, 'acknowledged-archive'),
    ).toBeUndefined();
  });

  describe('the durable List create (§P3-26, §P3-05)', () => {
    const LIST_ID = 'lst_01J0000000000000000000000D';
    const SEED = {
      behaviour: 'collection',
      capabilities: { checkable: true, supportsLocation: false },
      slot: 'groceries',
      icon: 'cart',
      emptyStateCopy: 'Add something to buy.',
    } as const;
    const CREATE = {
      listId: LIST_ID,
      intentId: 'create-costco-run',
      idempotencyKey: 'create-costco-run',
      input: { listId: LIST_ID, title: 'Costco run', templateKey: 'groceries' },
      seed: SEED,
    };

    /** What the server made of it: its own owner, timestamps and copied catalogue values. */
    const canonical = (): List => ({
      listId: LIST_ID,
      ownerId: OWNER,
      behaviour: 'collection',
      templateKey: 'groceries',
      title: 'Costco run',
      icon: 'cart',
      emptyStateCopy: 'Add something to buy.',
      capabilities: { checkable: true, supportsLocation: false },
      slot: 'groceries',
      itemCount: 0,
      uncheckedCount: 0,
      memberCount: 1,
      rankVersion: 0,
      archived: false,
      updatedAt: instant.parse('2026-08-27T09:20:00.000Z'),
      lastItemActivityAt: instant.parse('2026-08-27T09:20:00.000Z'),
    });

    function listHarness(currentDatabase: SqliteDatabase) {
      const lists = new ListsRepository(currentDatabase, new RepositorySubscriptions());
      return { lists, listService: new ListTransactionService(outbox, lists) };
    }

    function engine(
      lists: ListsRepository,
      listPush: ListPushTransport,
      pull: Partial<ActivityPullAdapter> = {},
    ) {
      return new SerializedNativeSyncEngine(
        transactions,
        outbox,
        activities,
        agenda,
        pushTransport(),
        { ...pullAdapter(), ...pull },
        targetedTransport(),
        anytime,
        lists,
        listPush,
      );
    }

    function listPushTransport(create: ListPushTransport['create']): ListPushTransport {
      return {
        create,
        createItem: async () => {
          throw new Error('unexpected list item POST');
        },
        patchItem: async () => {
          throw new Error('unexpected list item PATCH');
        },
        patch: async () => {
          throw new Error('unexpected List PATCH');
        },
        changeBehaviour: async () => {
          throw new Error('unexpected List behaviour POST');
        },
        remove: async () => {
          throw new Error('unexpected List DELETE');
        },
        undo: async () => {
          throw new Error('unexpected List Undo');
        },
      };
    }

    it('replaces the optimistic copy with server truth on acknowledgement', async () => {
      if (database === undefined) throw new Error('missing List create database');
      const { lists, listService } = listHarness(database);
      await transactions.run((transaction) =>
        listService.create(
          transaction,
          OWNER,
          CREATE,
          instant.parse('2026-08-27T09:19:00.000Z'),
        ),
      );
      const create = vi.fn(async () => canonical());
      const sync = engine(lists, listPushTransport(create));

      await sync.syncNow();
      sync.stop();

      expect(create).toHaveBeenCalledWith(CREATE.input, 'create-costco-run');
      expect(await lists.read()).toEqual([canonical()]);
      expect(await outbox.all()).toEqual([]);
    });

    /**
     * §P3-05's rule, asserted where it can actually fail: a transport retry reuses **both**
     * the minted `lst_` and the mutation id. A fresh id on a retry is how one confirmed
     * create becomes two lists.
     */
    it('reuses the minted list and mutation ids across a transport retry', async () => {
      if (database === undefined) throw new Error('missing List retry database');
      const { lists, listService } = listHarness(database);
      await transactions.run((transaction) =>
        listService.create(
          transaction,
          OWNER,
          CREATE,
          instant.parse('2026-08-27T09:19:00.000Z'),
        ),
      );
      let attempts = 0;
      const create = vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new NetworkError('offline', undefined);
        return canonical();
      });
      const sync = engine(lists, listPushTransport(create));

      await expect(sync.syncNow()).rejects.toThrow();
      await sync.syncNow();
      sync.stop();

      expect(create.mock.calls).toEqual([
        [CREATE.input, 'create-costco-run'],
        [CREATE.input, 'create-costco-run'],
      ]);
      expect(await lists.read()).toEqual([canonical()]);
    });

    /**
     * `409` says only that the id is taken. One exact read decides it, and a `200` means the
     * create landed and its response was lost — so the canonical row is adopted rather than
     * the create being sent again under a second identity.
     */
    it('adopts the canonical list when a collision turns out to be its own', async () => {
      if (database === undefined) throw new Error('missing List collision database');
      const { lists, listService } = listHarness(database);
      await transactions.run((transaction) =>
        listService.create(
          transaction,
          OWNER,
          CREATE,
          instant.parse('2026-08-27T09:19:00.000Z'),
        ),
      );
      const list = vi.fn(async () => canonical());
      const sync = engine(
        lists,
        listPushTransport(async () => {
          throw new ApiError('conflict', 'That id is taken.', 409, 'req-collision');
        }),
        { list },
      );

      await sync.syncNow();
      sync.stop();

      expect(list).toHaveBeenCalledWith(LIST_ID);
      expect(await lists.read()).toEqual([canonical()]);
      expect(await outbox.all()).toEqual([]);
    });

    /**
     * The other half: a `404` means the id names something this caller cannot see, which no
     * retry resolves. The intent parks, the row the user made stays visible, and the account
     * banner offers Retry and Discard — **nothing re-mints on its own**.
     */
    it('parks an ambiguous collision and re-mints only when Retry is tapped', async () => {
      if (database === undefined) throw new Error('missing List parked database');
      const { lists, listService } = listHarness(database);
      await transactions.run((transaction) =>
        listService.create(
          transaction,
          OWNER,
          CREATE,
          instant.parse('2026-08-27T09:19:00.000Z'),
        ),
      );
      const create = vi.fn(async () => {
        throw new ApiError('conflict', 'That id is taken.', 409, 'req-collision');
      });
      const sync = engine(lists, listPushTransport(create), {
        list: async () => {
          throw new ApiError('not_found', "This isn't here any more.", 404, 'req-404');
        },
      });

      await sync.syncNow();

      // Parked, not rejected: `needs_attention` is what the banner selects on, and the row
      // stays protected from canonical drains while the user decides.
      expect(await outbox.get(database, 'create-costco-run')).toMatchObject({
        status: 'needs_attention',
        attention: { kind: 'parked', reason: 'ambiguous_collision' },
      });
      expect((await lists.read())[0]).toMatchObject({ listId: LIST_ID });
      expect(create).toHaveBeenCalledTimes(1);

      const freshListId = 'lst_01J0000000000000000000000E';
      const coordinator = new NativeActivityActionCoordinator(
        OWNER,
        transactions,
        service,
        outbox,
        recoveryOnly(sync),
        undefined,
        listService,
        () => freshListId,
      );

      const retried = await coordinator.retryBlocked(
        'create-costco-run',
        'retry-costco-run',
        clock,
      );
      sync.stop();

      expect(retried.kind).toBe('accepted');
      // The local list and its queued payload both moved onto the fresh identity.
      expect(await outbox.get(database, 'create-costco-run')).toBeUndefined();
      expect(await outbox.get(database, 'retry-costco-run')).toMatchObject({
        status: 'queued',
        entityId: freshListId,
        orderingKey: `list:${freshListId}`,
        variables: {
          listId: freshListId,
          idempotencyKey: 'retry-costco-run',
          input: { listId: freshListId, title: 'Costco run', templateKey: 'groceries' },
        },
      });
      expect((await lists.read()).map((row) => row.listId)).toEqual([freshListId]);
    });

    /** Discard retires the parked create and takes its optimistic row with it. */
    it('discards a parked collision without leaving the row behind', async () => {
      if (database === undefined) throw new Error('missing List discard database');
      const { lists, listService } = listHarness(database);
      await transactions.run((transaction) =>
        listService.create(
          transaction,
          OWNER,
          CREATE,
          instant.parse('2026-08-27T09:19:00.000Z'),
        ),
      );
      const sync = engine(
        lists,
        listPushTransport(async () => {
          throw new ApiError('conflict', 'That id is taken.', 409, 'req-collision');
        }),
        {
          list: async () => {
            throw new ApiError('not_found', "This isn't here any more.", 404, 'req-404');
          },
          listsPage: async () => ({ data: [] }),
        },
      );
      await sync.syncNow();
      const coordinator = new NativeActivityActionCoordinator(
        OWNER,
        transactions,
        service,
        outbox,
        recoveryOnly(sync),
        undefined,
        listService,
        () => 'lst_01J0000000000000000000000F',
      );

      await expect(coordinator.discardBlocked('create-costco-run', clock)).resolves.toBe(
        true,
      );
      sync.stop();

      expect(await outbox.all()).toEqual([]);
      expect(await lists.read()).toEqual([]);
    });
  });

  describe('the item slice and its fence (§P3-27, §P3-08)', () => {
    const LIST_ID = 'lst_01J0000000000000000000000G';
    const ITEM_ID = 'itm_01J000000000000000000000AA';

    const listRow = (overrides: Partial<List> = {}): List => ({
      listId: LIST_ID,
      ownerId: OWNER,
      behaviour: 'collection',
      templateKey: 'groceries',
      title: 'Groceries',
      icon: 'cart',
      emptyStateCopy: 'Add something to buy.',
      capabilities: { checkable: true, supportsLocation: false },
      slot: 'groceries',
      itemCount: 2,
      uncheckedCount: 2,
      memberCount: 1,
      rankVersion: 3,
      archived: false,
      updatedAt: instant.parse('2026-08-27T09:00:00.000Z'),
      lastItemActivityAt: instant.parse('2026-08-27T09:00:00.000Z'),
      ...overrides,
    });

    const row = (itemId: string, rank: string, title: string) => ({
      itemId,
      listId: LIST_ID,
      rank,
      title,
      checked: false,
    });

    function itemHarness(currentDatabase: SqliteDatabase) {
      const subscriptions = new RepositorySubscriptions();
      const lists = new ListsRepository(currentDatabase, subscriptions);
      const items = new ListItemsRepository(currentDatabase, subscriptions);
      return {
        lists,
        items,
        listService: new ListTransactionService(outbox, lists, items),
      };
    }

    function itemEngine(
      lists: ListsRepository,
      items: ListItemsRepository,
      pull: Partial<ActivityPullAdapter>,
      listPush?: Partial<ListPushTransport>,
    ) {
      return new SerializedNativeSyncEngine(
        transactions,
        outbox,
        activities,
        agenda,
        pushTransport(),
        { ...pullAdapter(), ...pull },
        targetedTransport(),
        anytime,
        lists,
        {
          create: async () => {
            throw new Error('unexpected List POST');
          },
          createItem: async () => {
            throw new Error('unexpected list item POST');
          },
          patchItem: async () => {
            throw new Error('unexpected list item PATCH');
          },
          patch: async () => {
            throw new Error('unexpected List PATCH');
          },
          changeBehaviour: async () => {
            throw new Error('unexpected List behaviour POST');
          },
          remove: async () => {
            throw new Error('unexpected List DELETE');
          },
          undo: async () => {
            throw new Error('unexpected List Undo');
          },
          ...listPush,
        },
        items,
      );
    }

    it('installs META and the fenced first page together', async () => {
      if (database === undefined) throw new Error('missing item database');
      const { lists, items } = itemHarness(database);
      const sync = itemEngine(lists, items, {
        listDetail: async () => ({
          list: listRow(),
          items: [
            row(ITEM_ID, 'a', 'Milk'),
            row('itm_01J000000000000000000000BB', 'b', 'Eggs'),
          ],
        }),
      });

      await sync.pullListDetail(LIST_ID);
      sync.stop();

      expect((await items.read(LIST_ID)).map((item) => item.title)).toEqual([
        'Milk',
        'Eggs',
      ]);
      expect(await items.pageState(LIST_ID)).toEqual({ rankVersion: 3, complete: true });
      expect((await lists.read())[0]?.itemCount).toBe(2);
    });

    it('merges a later page without replacing what page one installed', async () => {
      if (database === undefined) throw new Error('missing item page database');
      const { lists, items } = itemHarness(database);
      const sync = itemEngine(lists, items, {
        listDetail: async () => ({
          list: listRow(),
          items: [row(ITEM_ID, 'a', 'Milk')],
          nextCursor: 'cursor-1',
        }),
        listItemsPage: async (_listId, cursor) => {
          expect(cursor).toBe('cursor-1');
          return { items: [row('itm_01J000000000000000000000BB', 'b', 'Eggs')] };
        },
      });

      await sync.pullListDetail(LIST_ID);
      await sync.pullListItemPage(LIST_ID);
      sync.stop();

      expect((await items.read(LIST_ID)).map((item) => item.title)).toEqual([
        'Milk',
        'Eggs',
      ]);
      expect(await items.pageState(LIST_ID)).toEqual({ rankVersion: 3, complete: true });
    });

    /**
     * The `503` contract, in the order it states: the committed rows stay, every cursor goes,
     * the wait is the server's `Retry-After`, and **nothing** is installed until page one
     * succeeds. This is projection recovery, not a `409` edit conflict.
     */
    it('recovers a fenced item page by restarting at page one', async () => {
      if (database === undefined) throw new Error('missing fence database');
      const { lists, items } = itemHarness(database);
      let detailCalls = 0;
      const observed: string[] = [];
      const sync = itemEngine(lists, items, {
        listDetail: async () => {
          detailCalls += 1;
          // Page one is asked for twice: once before the fence, once as the restart.
          return {
            list: listRow({ rankVersion: detailCalls === 1 ? 3 : 4 }),
            items:
              detailCalls === 1
                ? [row(ITEM_ID, 'a', 'Milk')]
                : [
                    row(ITEM_ID, 'a', 'Milk'),
                    row('itm_01J000000000000000000000CC', 'c', 'Bread'),
                  ],
            ...(detailCalls === 1 ? { nextCursor: 'cursor-1' } : {}),
          };
        },
        listItemsPage: async () => {
          // The rows the user is looking at while the fence is up.
          observed.push((await items.read(LIST_ID)).map((item) => item.title).join(','));
          throw new ApiError(
            'internal',
            'Try again shortly.',
            503,
            'req-fence',
            undefined,
            1,
          );
        },
      });

      await sync.pullListDetail(LIST_ID);
      await sync.pullListItemPage(LIST_ID);
      sync.stop();

      // The projection was never emptied on the way through.
      expect(observed).toEqual(['Milk']);
      expect(detailCalls).toBe(2);
      // Installed only after page one succeeded — and from the new generation, not spliced.
      expect((await items.read(LIST_ID)).map((item) => item.title)).toEqual([
        'Milk',
        'Bread',
      ]);
      expect(await items.pageState(LIST_ID)).toEqual({ rankVersion: 4, complete: true });
    });

    it('replaces the optimistic item with server truth on acknowledgement', async () => {
      if (database === undefined) throw new Error('missing item create database');
      const { lists, items, listService } = itemHarness(database);
      await transactions.run((transaction) =>
        listService.createItem(transaction, {
          listId: LIST_ID,
          itemId: ITEM_ID,
          intentId: 'create-milk',
          idempotencyKey: 'create-milk',
          input: { itemId: ITEM_ID, title: 'Milk' },
          rank: 'zzz',
        }),
      );
      // The server allocated its own rank under its own `rankVersion`.
      const canonical = row(ITEM_ID, 'm', 'Milk');
      const createItem = vi.fn(async () => canonical);
      const sync = itemEngine(lists, items, {}, { createItem });

      await sync.syncNow();
      sync.stop();

      expect(createItem).toHaveBeenCalledWith(
        LIST_ID,
        { itemId: ITEM_ID, title: 'Milk' },
        'create-milk',
      );
      expect(await items.read(LIST_ID)).toEqual([canonical]);
      expect(await outbox.all()).toEqual([]);
    });

    it('reuses the minted item and mutation ids across a transport retry', async () => {
      if (database === undefined) throw new Error('missing item retry database');
      const { lists, items, listService } = itemHarness(database);
      await transactions.run((transaction) =>
        listService.createItem(transaction, {
          listId: LIST_ID,
          itemId: ITEM_ID,
          intentId: 'create-milk',
          idempotencyKey: 'create-milk',
          input: { itemId: ITEM_ID, title: 'Milk' },
          rank: 'zzz',
        }),
      );
      let attempts = 0;
      const createItem = vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new NetworkError('offline', undefined);
        return row(ITEM_ID, 'm', 'Milk');
      });
      const sync = itemEngine(lists, items, {}, { createItem });

      await expect(sync.syncNow()).rejects.toThrow();
      await sync.syncNow();
      sync.stop();

      expect(createItem.mock.calls).toEqual([
        [LIST_ID, { itemId: ITEM_ID, title: 'Milk' }, 'create-milk'],
        [LIST_ID, { itemId: ITEM_ID, title: 'Milk' }, 'create-milk'],
      ]);
    });

    it('parks an ambiguous item collision and re-mints only when Retry is tapped', async () => {
      if (database === undefined) throw new Error('missing item collision database');
      const { lists, items, listService } = itemHarness(database);
      await transactions.run((transaction) =>
        listService.createItem(transaction, {
          listId: LIST_ID,
          itemId: ITEM_ID,
          intentId: 'create-milk',
          idempotencyKey: 'create-milk',
          input: { itemId: ITEM_ID, title: 'Milk' },
          rank: 'zzz',
        }),
      );
      const sync = itemEngine(
        lists,
        items,
        {
          listItem: async () => {
            throw new ApiError('not_found', "This isn't here any more.", 404, 'req-404');
          },
        },
        {
          createItem: async () => {
            throw new ApiError('conflict', 'That id is taken.', 409, 'req-collision');
          },
        },
      );

      await sync.syncNow();

      expect(await outbox.get(database, 'create-milk')).toMatchObject({
        status: 'needs_attention',
        attention: { kind: 'parked', reason: 'ambiguous_collision' },
      });
      // The row the user made stays visible while they decide.
      expect(await items.read(LIST_ID)).toHaveLength(1);

      const freshItemId = 'itm_01J000000000000000000000DD';
      const coordinator = new NativeActivityActionCoordinator(
        OWNER,
        transactions,
        service,
        outbox,
        recoveryOnly(sync),
        undefined,
        listService,
        undefined,
        () => freshItemId,
      );

      const retried = await coordinator.retryBlocked('create-milk', 'retry-milk', clock);
      sync.stop();

      expect(retried.kind).toBe('accepted');
      expect(await outbox.get(database, 'retry-milk')).toMatchObject({
        status: 'queued',
        entityId: freshItemId,
        // The ordering key names the list and must not move with the item.
        orderingKey: `list:${LIST_ID}`,
        variables: {
          itemId: freshItemId,
          idempotencyKey: 'retry-milk',
          input: { itemId: freshItemId, title: 'Milk' },
        },
      });
      expect((await items.read(LIST_ID)).map((item) => item.itemId)).toEqual([
        freshItemId,
      ]);
    });

    it('adopts the canonical item when a collision turns out to be its own', async () => {
      if (database === undefined) throw new Error('missing item adoption database');
      const { lists, items, listService } = itemHarness(database);
      await transactions.run((transaction) =>
        listService.createItem(transaction, {
          listId: LIST_ID,
          itemId: ITEM_ID,
          intentId: 'create-milk',
          idempotencyKey: 'create-milk',
          input: { itemId: ITEM_ID, title: 'Milk' },
          rank: 'zzz',
        }),
      );
      const canonical = row(ITEM_ID, 'm', 'Milk');
      const listItem = vi.fn(async () => canonical);
      const sync = itemEngine(
        lists,
        items,
        { listItem },
        {
          createItem: async () => {
            throw new ApiError('conflict', 'That id is taken.', 409, 'req-collision');
          },
        },
      );

      await sync.syncNow();
      sync.stop();

      expect(listItem).toHaveBeenCalledWith(LIST_ID, ITEM_ID);
      expect(await items.read(LIST_ID)).toEqual([canonical]);
      expect(await outbox.all()).toEqual([]);
    });

    /**
     * The durable field edit (§P3-29).
     *
     * Three rules, and each one is the create's rule turned around: an acknowledged patch
     * installs the server's row; a **rejected** patch restores it rather than deleting the row
     * as a rejected create does; and a page arriving mid-flight may not overwrite the edit the
     * device is still holding.
     */
    describe('the durable item edit (§P3-29)', () => {
      async function withPendingEdit(currentDatabase: SqliteDatabase) {
        const built = itemHarness(currentDatabase);
        await transactions.run((transaction) =>
          built.listService.createItem(transaction, {
            listId: LIST_ID,
            itemId: ITEM_ID,
            intentId: 'create-milk',
            idempotencyKey: 'create-milk',
            input: { itemId: ITEM_ID, title: 'Milk' },
            rank: 'm',
          }),
        );
        await transactions.run((transaction) =>
          outbox.acknowledge(transaction.database, 'create-milk'),
        );
        await transactions.run((transaction) =>
          built.listService.patchItem(transaction, {
            listId: LIST_ID,
            itemId: ITEM_ID,
            intentId: 'patch-milk',
            idempotencyKey: 'patch-milk',
            input: { title: 'Oat milk' },
          }),
        );
        return built;
      }

      it('sends the fields and installs the acknowledged row', async () => {
        if (database === undefined) throw new Error('missing item patch database');
        const { lists, items } = await withPendingEdit(database);
        // Server truth, including a rank and a note this device never sent.
        const canonical = { ...row(ITEM_ID, 'q', 'Oat milk'), note: 'from the shop' };
        const patchItem = vi.fn(async () => canonical);
        const sync = itemEngine(lists, items, {}, { patchItem });

        await sync.syncNow();
        sync.stop();

        expect(patchItem).toHaveBeenCalledWith(LIST_ID, ITEM_ID, { title: 'Oat milk' });
        expect(await items.read(LIST_ID)).toEqual([canonical]);
        expect(await outbox.all()).toEqual([]);
      });

      /** A rejected **edit** must not take a real row off the screen. */
      it('restores server truth over a permanently rejected edit', async () => {
        if (database === undefined) throw new Error('missing item rejection database');
        const { lists, items } = await withPendingEdit(database);
        const canonical = row(ITEM_ID, 'm', 'Milk');
        const listItem = vi.fn(async () => canonical);
        const sync = itemEngine(
          lists,
          items,
          { listItem },
          {
            patchItem: async () => {
              throw new ApiError('validation_failed', 'No.', 422, 'req-reject');
            },
          },
        );

        // The cycle reports the rejection; the rollback has already run by then.
        await expect(sync.syncNow()).rejects.toThrow('No.');
        sync.stop();

        expect(listItem).toHaveBeenCalledWith(LIST_ID, ITEM_ID);
        expect(await items.read(LIST_ID)).toEqual([canonical]);
        expect(await outbox.get(database, 'patch-milk')).toMatchObject({
          status: 'needs_attention',
          attention: { kind: 'rejected' },
        });
      });

      /** `404` on the targeted read is an answer: the item is gone, so removing it is the restore. */
      it('removes the row when the rejected edit names an item that no longer exists', async () => {
        if (database === undefined) throw new Error('missing item gone database');
        const { lists, items } = await withPendingEdit(database);
        const sync = itemEngine(
          lists,
          items,
          {
            listItem: async () => {
              throw new ApiError(
                'not_found',
                "This isn't here any more.",
                404,
                'req-404',
              );
            },
          },
          {
            patchItem: async () => {
              throw new ApiError(
                'not_found',
                "This isn't here any more.",
                404,
                'req-404',
              );
            },
          },
        );

        await expect(sync.syncNow()).rejects.toThrow("This isn't here any more.");
        sync.stop();

        expect(await items.read(LIST_ID)).toEqual([]);
      });

      /**
       * The row checkbox is the same durable write with one field (§P3-29's amendment).
       *
       * §5.11.5's first row, end to end: the tick is sent as the **absolute** value, a lost
       * connection replays the same intent rather than minting a second, and the row does not
       * un-tick at any point on the way — including when the queue finally drains.
       */
      it('replays one offline tick and never un-ticks the row', async () => {
        if (database === undefined) throw new Error('missing item tick database');
        const built = itemHarness(database);
        await transactions.run((transaction) =>
          built.listService.createItem(transaction, {
            listId: LIST_ID,
            itemId: ITEM_ID,
            intentId: 'create-milk',
            idempotencyKey: 'create-milk',
            input: { itemId: ITEM_ID, title: 'Milk' },
            rank: 'm',
          }),
        );
        await transactions.run((transaction) =>
          outbox.acknowledge(transaction.database, 'create-milk'),
        );
        await transactions.run((transaction) =>
          built.listService.patchItem(transaction, {
            listId: LIST_ID,
            itemId: ITEM_ID,
            intentId: 'tick-milk',
            idempotencyKey: 'tick-milk',
            input: { checked: true },
          }),
        );
        // Accepted and visible before any connection existed.
        expect((await built.items.read(LIST_ID))[0]?.checked).toBe(true);

        const seen: unknown[] = [];
        let attempts = 0;
        const patchItem = vi.fn(async (_listId, _itemId, input: unknown) => {
          seen.push(input);
          attempts += 1;
          if (attempts === 1) throw new NetworkError('offline', undefined);
          return { ...row(ITEM_ID, 'm', 'Milk'), checked: true };
        });
        const sync = itemEngine(built.lists, built.items, {}, { patchItem });

        await expect(sync.syncNow()).rejects.toThrow();
        expect((await built.items.read(LIST_ID))[0]?.checked).toBe(true);
        await sync.syncNow();
        sync.stop();

        // One intent, replayed — not two writes, and never `!checked` recomputed anywhere.
        expect(seen).toEqual([{ checked: true }, { checked: true }]);
        expect((await built.items.read(LIST_ID))[0]?.checked).toBe(true);
        expect(await outbox.all()).toEqual([]);
      });

      /** Otherwise a background page lands between the accepted edit and its acknowledgement. */
      it('protects the edited row from a canonical page that predates it', async () => {
        if (database === undefined) throw new Error('missing item protection database');
        const { lists, items } = await withPendingEdit(database);
        const sync = itemEngine(lists, items, {
          listDetail: async () => ({
            list: listRow(),
            items: [row(ITEM_ID, 'm', 'Milk')],
          }),
        });

        await sync.pullListDetail(LIST_ID);
        sync.stop();

        expect((await items.read(LIST_ID)).map((item) => item.title)).toEqual([
          'Oat milk',
        ]);
      });
    });
  });
});
