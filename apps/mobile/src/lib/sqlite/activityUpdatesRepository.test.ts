import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ActivityDetail,
  ActivityUpdate,
  PostActivityUpdateResult,
} from '@od/shared/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';
import { ActivityRepository } from './activityRepository';
import { ActivityTransactionService } from './activityTransactions';
import { AgendaRepository } from './agendaRepository';
import type { SqliteDatabase } from './database';
import { FOUNDATION_MIGRATIONS, runMigrations } from './migrations';
import { OutboxRepository } from './outbox';
import { RepositorySubscriptions } from './subscriptions';
import { SerializedTransactionRunner } from './transaction';

const OWNER = 'usr_01J0000000000000000000000A';
const ACTIVITY = 'act_01J0000000000000000000000A';

function update(sequence: string, createdAt: string): ActivityUpdate {
  return {
    updateId: `upd_01J0000000000000000000000${sequence}`,
    activityId: ACTIVITY,
    kind: 'user',
    authorUserId: OWNER,
    body: `Update ${sequence}`,
    createdAt,
    schemaVersion: 1,
  };
}

function detail(
  lastActivityAt: string,
  updates: readonly ActivityUpdate[],
  updatesCursor?: string,
  extras: Partial<ActivityDetail> = {},
): ActivityDetail {
  return {
    activity: {
      activityId: ACTIVITY,
      ownerId: OWNER,
      objectKind: 'plan',
      type: 'custom',
      status: 'saved',
      title: 'Durable plan',
      participantCount: 0,
      childCount: 0,
      expenseTotalCents: 0,
      visibility: 'private',
      details: { kind: 'custom' },
      icsSequence: 0,
      createdAt: '2026-08-19T10:00:00.000Z',
      lastActivityAt,
      updatedAt: '2026-08-19T10:00:00.000Z',
      schemaVersion: 1,
    },
    reminders: [],
    updates: [...updates],
    ...(updatesCursor === undefined ? {} : { updatesCursor }),
    ...extras,
  };
}

describe('native Activity updates projection', () => {
  let directory = '';
  let database: SqliteDatabase | undefined;
  let subscriptions: RepositorySubscriptions;
  let transactions: SerializedTransactionRunner;
  let activities: ActivityRepository;
  let agenda: AgendaRepository;
  let outbox: OutboxRepository;
  let service: ActivityTransactionService;

  async function continuationCursor() {
    const cursor = (await activities.readUpdates(ACTIVITY)).cursor;
    if (cursor === undefined) throw new Error('Expected a continuation cursor.');
    return cursor;
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ordinarydays-activity-updates-'));
    database = await createNodeSqliteFactory(directory).open('updates.sqlite');
    await runMigrations(database, FOUNDATION_MIGRATIONS);
    subscriptions = new RepositorySubscriptions();
    transactions = new SerializedTransactionRunner(database, subscriptions);
    activities = new ActivityRepository(database, subscriptions);
    agenda = new AgendaRepository(database, subscriptions);
    outbox = new OutboxRepository(database);
    service = new ActivityTransactionService(outbox, activities, agenda);
  });

  afterEach(async () => {
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('commits the confirmed update and monotonic Plans timestamp atomically', async () => {
    const first = update('A', '2026-08-19T11:00:00.000Z');
    const confirmed = update('B', '2026-08-19T12:00:00.000Z');
    await transactions.run((transaction) =>
      activities.putCanonical(transaction, detail(first.createdAt, [first], 'cur_1')),
    );
    const result: PostActivityUpdateResult = {
      update: confirmed,
      lastActivityAt: confirmed.createdAt,
    };

    await expect(
      transactions.run(async (transaction) => {
        await activities.installConfirmedUpdate(transaction, result);
        throw new Error('interrupt the transaction');
      }),
    ).rejects.toThrow('interrupt the transaction');
    expect((await activities.readUpdates(ACTIVITY)).updates).toEqual([first]);
    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity
        .lastActivityAt,
    ).toBe(first.createdAt);

    await transactions.run((transaction) =>
      activities.installConfirmedUpdate(transaction, result),
    );
    expect((await activities.readUpdates(ACTIVITY)).updates).toEqual([confirmed, first]);
    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity
        .lastActivityAt,
    ).toBe(confirmed.createdAt);
  });

  it('survives restart and keeps the monotonic Plans timestamp under any later head', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    const first = update('A', '2026-08-19T11:00:00.000Z');
    const confirmed = update('B', '2026-08-19T12:00:00.000Z');
    await transactions.run((transaction) =>
      activities.putCanonical(transaction, detail(first.createdAt, [first], 'cur_1')),
    );
    await transactions.run(async (transaction) => {
      await activities.queueUpdatePost(
        transaction,
        ACTIVITY,
        'stable-stale-head-post',
        confirmed.body,
        1,
      );
      await activities.settlePostedUpdate(transaction, 'stable-stale-head-post', {
        update: confirmed,
        lastActivityAt: confirmed.createdAt,
      });
    });

    await database.close();
    database = await createNodeSqliteFactory(directory).open('updates.sqlite');
    subscriptions = new RepositorySubscriptions();
    transactions = new SerializedTransactionRunner(database, subscriptions);
    activities = new ActivityRepository(database, subscriptions);

    expect((await activities.readUpdates(ACTIVITY)).updates).toEqual([confirmed, first]);
    // A detail head is authoritative for the feed (the API reads it strongly), while the
    // Plans ordering timestamp stays a monotonic floor that an older value cannot lower.
    await transactions.run((transaction) =>
      activities.putCanonical(transaction, detail(first.createdAt, [first], 'cur_1')),
    );
    expect(
      (await activities.read({ kind: 'activity', activityId: ACTIVITY }))?.activity
        .lastActivityAt,
    ).toBe(confirmed.createdAt);
    expect((await activities.readUpdates(ACTIVITY)).updates).toEqual([first]);

    await transactions.run((transaction) =>
      activities.putCanonical(
        transaction,
        detail(confirmed.createdAt, [confirmed, first]),
      ),
    );
    expect((await activities.readUpdates(ACTIVITY)).updates).toEqual([confirmed, first]);
    expect((await activities.readUpdates(ACTIVITY)).cursor).toBeUndefined();
  });

  it('persists bounded Prep and source-List projections across an offline restart', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    const children = [
      {
        activityId: 'act_01J0000000000000000000000B',
        title: 'Pack a bag',
        status: 'scheduled' as const,
        restoredStatus: 'scheduled' as const,
        isRecurring: false,
      },
    ];
    const sourceLists = [
      {
        listId: 'lst_01J0000000000000000000000A',
        title: 'Weekend groceries',
        icon: 'cart',
        itemCount: 8,
        doneCount: 3,
      },
    ];
    await transactions.run((transaction) =>
      activities.putCanonical(
        transaction,
        detail('2026-08-19T11:00:00.000Z', [], undefined, {
          children,
          sourceLists,
        }),
      ),
    );

    await database.close();
    database = await createNodeSqliteFactory(directory).open('updates.sqlite');
    subscriptions = new RepositorySubscriptions();
    activities = new ActivityRepository(database, subscriptions);

    await expect(
      activities.read({ kind: 'activity', activityId: ACTIVITY }),
    ).resolves.toMatchObject({ children, sourceLists });
  });

  it('rebases older pages on an authoritative head and does not resurrect remote deletes', async () => {
    const older = update('A', '2026-08-19T11:00:00.000Z');
    const head = update('B', '2026-08-19T12:00:00.000Z');
    await transactions.run((transaction) =>
      activities.putCanonical(transaction, detail(head.createdAt, [head], 'cur_old')),
    );
    const oldPosition = await continuationCursor();
    await transactions.run((transaction) =>
      activities.installUpdatePage(transaction, ACTIVITY, oldPosition, {
        updates: [older],
        cursor: 'cur_tail',
      }),
    );
    expect((await activities.readUpdates(ACTIVITY)).updates).toEqual([head, older]);

    await transactions.run((transaction) =>
      activities.putCanonical(transaction, detail(head.createdAt, [head], 'cur_new')),
    );
    expect(await activities.readUpdates(ACTIVITY)).toEqual({
      updates: [head],
      cursor: 'cur_new',
    });

    const refreshedPosition = await continuationCursor();
    await transactions.run((transaction) =>
      activities.installUpdatePage(transaction, ACTIVITY, refreshedPosition, {
        updates: [],
        cursor: undefined,
      }),
    );
    expect((await activities.readUpdates(ACTIVITY)).updates).toEqual([head]);
  });

  it('keeps the local feed when a detail response predates a settled post', async () => {
    const first = update('A', '2026-08-19T11:00:00.000Z');
    const settled = update('B', '2026-08-19T12:00:00.000Z');
    const refreshedHead = update('C', '2026-08-20T12:00:00.000Z');
    await transactions.run((transaction) =>
      activities.putCanonical(transaction, detail(first.createdAt, [first], 'cur_old')),
    );
    const fetchedAt = activities.updatesVersion(ACTIVITY);
    await transactions.run(async (transaction) => {
      await activities.queueUpdatePost(
        transaction,
        ACTIVITY,
        'settled-in-flight',
        settled.body,
        1,
      );
      await activities.settlePostedUpdate(transaction, 'settled-in-flight', {
        update: settled,
        lastActivityAt: settled.createdAt,
      });
    });

    // A response fetched before the post settled installs everything but its feed page...
    const accepted = await transactions.run((transaction) =>
      activities.putCanonical(
        transaction,
        detail(refreshedHead.createdAt, [refreshedHead], 'cur_refreshed'),
        { updatesVersion: fetchedAt },
      ),
    );
    expect(accepted).toBe(true);
    expect(await activities.readUpdates(ACTIVITY)).toEqual({
      updates: [settled, first],
      cursor: 'cur_old',
    });

    // ...and the next read converges the feed.
    await transactions.run((transaction) =>
      activities.putCanonical(
        transaction,
        detail(refreshedHead.createdAt, [refreshedHead, settled], 'cur_next'),
      ),
    );
    expect(await activities.readUpdates(ACTIVITY)).toEqual({
      updates: [refreshedHead, settled],
      cursor: 'cur_next',
    });
  });

  it('keeps post and delete projections durable until atomic acknowledgement', async () => {
    if (database === undefined) throw new Error('Test database was not opened.');
    const first = update('A', '2026-08-19T11:00:00.000Z');
    const confirmed = update('B', '2026-08-19T12:00:00.000Z');
    await transactions.run((transaction) =>
      activities.putCanonical(transaction, detail(first.createdAt, [first])),
    );
    await transactions.run((transaction) =>
      service.postUpdate(transaction, {
        activityId: ACTIVITY,
        body: 'Update B',
        idempotencyKey: 'stable-update-post',
      }),
    );
    expect(await activities.readUpdatesProjection(ACTIVITY)).toMatchObject({
      updates: [first],
      pending: [{ localId: 'stable-update-post', body: 'Update B' }],
    });

    await database.close();
    database = await createNodeSqliteFactory(directory).open('updates.sqlite');
    subscriptions = new RepositorySubscriptions();
    transactions = new SerializedTransactionRunner(database, subscriptions);
    activities = new ActivityRepository(database, subscriptions);
    outbox = new OutboxRepository(database);
    expect((await outbox.all())[0]).toMatchObject({
      intentId: 'stable-update-post',
      mutationKey: ['activity', 'update-post'],
      variables: { idempotencyKey: 'stable-update-post' },
    });
    expect((await activities.readUpdatesProjection(ACTIVITY)).pending).toHaveLength(1);

    await expect(
      transactions.run(async (transaction) => {
        await activities.settlePostedUpdate(transaction, 'stable-update-post', {
          update: confirmed,
          lastActivityAt: confirmed.createdAt,
        });
        await outbox.acknowledge(transaction.database, 'stable-update-post');
        throw new Error('interrupt acknowledgement');
      }),
    ).rejects.toThrow('interrupt acknowledgement');
    expect((await activities.readUpdatesProjection(ACTIVITY)).pending).toHaveLength(1);

    await transactions.run(async (transaction) => {
      await activities.settlePostedUpdate(transaction, 'stable-update-post', {
        update: confirmed,
        lastActivityAt: confirmed.createdAt,
      });
      await outbox.acknowledge(transaction.database, 'stable-update-post');
    });
    expect(await activities.readUpdatesProjection(ACTIVITY)).toMatchObject({
      updates: [confirmed, first],
      pending: [],
    });

    service = new ActivityTransactionService(
      outbox,
      activities,
      new AgendaRepository(database, subscriptions),
    );
    await transactions.run((transaction) =>
      service.deleteUpdate(transaction, {
        activityId: ACTIVITY,
        updateId: confirmed.updateId,
        intentId: 'stable-update-delete',
      }),
    );
    expect((await activities.readUpdatesProjection(ACTIVITY)).updates).toEqual([first]);
    await transactions.run(async (transaction) => {
      await activities.settleDeletedUpdate(
        transaction,
        'stable-update-delete',
        ACTIVITY,
        confirmed.updateId,
      );
      await outbox.acknowledge(transaction.database, 'stable-update-delete');
    });
    expect((await activities.readUpdatesProjection(ACTIVITY)).updates).toEqual([first]);
  });
});
