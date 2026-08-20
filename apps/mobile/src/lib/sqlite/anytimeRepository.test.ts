import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';
import { ActivityRepository } from './activityRepository';
import { ActivityTransactionService } from './activityTransactions';
import { AgendaRepository } from './agendaRepository';
import { AnytimeRepository } from './anytimeRepository';
import type { SqliteDatabase } from './database';
import { FOUNDATION_MIGRATIONS, runMigrations } from './migrations';
import { OutboxRepository } from './outbox';
import { RepositorySubscriptions } from './subscriptions';
import { SerializedTransactionRunner } from './transaction';

describe('native Anytime SQLite index', () => {
  let directory = '';
  let database: SqliteDatabase | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ordinarydays-anytime-'));
    database = await createNodeSqliteFactory(directory).open('anytime.sqlite');
    await runMigrations(database, FOUNDATION_MIGRATIONS);
  });

  afterEach(async () => {
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('replaces the complete server index and reads it without a query cache', async () => {
    if (database === undefined) throw new Error('test database not open');
    const subscriptions = new RepositorySubscriptions();
    const transactions = new SerializedTransactionRunner(database, subscriptions);
    const anytime = new AnytimeRepository(database, subscriptions);

    await transactions.run((transaction) =>
      anytime.replaceCanonical(transaction, [
        {
          activityId: 'act_01J0000000000000000000000B',
          type: 'task',
          title: 'Second',
          status: 'saved',
          isRecurring: false,
          participantCount: 0,
        },
        {
          activityId: 'act_01J0000000000000000000000A',
          type: 'task',
          title: 'First',
          status: 'saved',
          isRecurring: false,
          participantCount: 0,
        },
      ]),
    );

    expect((await anytime.read()).map((item) => item.title)).toEqual(['First', 'Second']);

    await transactions.run((transaction) =>
      anytime.replaceCanonical(transaction, [
        {
          activityId: 'act_01J0000000000000000000000C',
          type: 'task',
          title: 'Replacement',
          status: 'saved',
          isRecurring: false,
          participantCount: 0,
        },
      ]),
    );
    expect((await anytime.read()).map((item) => item.title)).toEqual(['Replacement']);
  });

  it('overlays local saved-task changes and hides locally scheduled or deleted rows', async () => {
    if (database === undefined) throw new Error('test database not open');
    const subscriptions = new RepositorySubscriptions();
    const transactions = new SerializedTransactionRunner(database, subscriptions);
    const anytime = new AnytimeRepository(database, subscriptions);
    const outbox = new OutboxRepository(database);
    const service = new ActivityTransactionService(
      outbox,
      new ActivityRepository(database, subscriptions),
      new AgendaRepository(database, subscriptions),
    );
    const activityId = 'act_01J0000000000000000000000A';
    await transactions.run((transaction) =>
      anytime.replaceCanonical(transaction, [
        {
          activityId,
          type: 'task',
          title: 'Server title',
          status: 'saved',
          isRecurring: false,
          participantCount: 0,
        },
      ]),
    );
    await transactions.run((transaction) =>
      service.create(
        transaction,
        'usr_01J0000000000000000000000A',
        {
          input: {
            activityId,
            objectKind: 'task',
            type: 'task',
            title: 'Local title',
          },
          idempotencyKey: 'local-anytime-create',
        },
        { today: '2026-08-19', currentMinute: '08:00' },
        '2026-08-19T08:00:00.000Z',
      ),
    );
    expect((await anytime.read()).map((item) => item.title)).toEqual(['Local title']);

    await transactions.run((transaction) =>
      service.schedule(
        transaction,
        {
          activityId,
          input: { date: '2026-08-20', timezone: 'UTC' },
          idempotencyKey: 'local-anytime-schedule',
        },
        { today: '2026-08-19', currentMinute: '08:00' },
      ),
    );
    expect(await anytime.read()).toEqual([]);

    await transactions.run(async (transaction) => {
      await transaction.database.run('DELETE FROM activities WHERE activity_id = ?;', [
        activityId,
      ]);
      await outbox.append(transaction.database, {
        intentId: 'local-anytime-delete',
        mutationKey: ['activity', 'delete'],
        variables: { activityId, intentId: 'local-anytime-delete' },
        entityId: activityId,
      });
    });
    expect(await anytime.read()).toEqual([]);
  });
});
