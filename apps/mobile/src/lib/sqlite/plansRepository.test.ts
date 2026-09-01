import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plansData } from '@od/shared/schemas';
import type { ActivityDetail } from '@od/shared/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NeedsDateRowData } from '@/features/agenda/model/plansApply';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';
import { ActivityRepository } from './activityRepository';
import type { SqliteDatabase } from './database';
import { FOUNDATION_MIGRATIONS, runMigrations } from './migrations';
import { PlansRepository } from './plansRepository';
import { RepositorySubscriptions } from './subscriptions';
import { SerializedTransactionRunner } from './transaction';

const TIMEZONE = 'America/New_York';
const OWNER = 'usr_01J0000000000000000000000A';
const A = 'act_01J8PANA000000000000000000';
const B = 'act_01J8PANB000000000000000000';

function needsDateRow(activityId: string, lastActivityAt: string): NeedsDateRowData {
  return {
    activityId,
    type: 'custom',
    title: activityId,
    status: 'scheduled',
    isRecurring: false,
    isSnoozed: false,
    hasCheckbox: false,
    capabilities: { complete: true, skip: false, snooze: false },
    participantAvatars: [],
    participantCount: 0,
    isPast: false,
    lastActivityAt,
    suggestionCount: 0,
    rsvpSummary: {
      interested: { count: 0, names: [] },
      maybe: { count: 0, names: [] },
      pass: { count: 0, names: [] },
      pending: { count: 0, names: [] },
    },
  };
}

function detail(activityId: string, lastActivityAt: string): ActivityDetail {
  return {
    activity: {
      activityId,
      ownerId: OWNER,
      objectKind: 'plan',
      type: 'custom',
      status: 'saved',
      title: activityId,
      participantCount: 0,
      childCount: 0,
      expenseTotalCents: 0,
      visibility: 'private',
      details: { kind: 'custom' },
      icsSequence: 0,
      createdAt: '2026-08-01T00:00:00.000Z',
      lastActivityAt,
      updatedAt: lastActivityAt,
      schemaVersion: 1,
    },
    reminders: [],
    updates: [],
  };
}

function initial() {
  return plansData.parse({
    mode: 'initial',
    needsDate: [
      needsDateRow(B, '2026-08-02T10:00:00.000Z'),
      needsDateRow(A, '2026-08-01T10:00:00.000Z'),
    ],
    upcoming: [],
    upcomingWindow: {
      from: '2026-08-06',
      through: '2026-10-06',
      nextFrom: null,
    },
    past: [],
    pastPage: {},
    warnings: [],
  });
}

describe('native Plans projection', () => {
  let directory = '';
  let database: SqliteDatabase | undefined;
  let subscriptions: RepositorySubscriptions;
  let transactions: SerializedTransactionRunner;
  let plans: PlansRepository;
  let activities: ActivityRepository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ordinarydays-plans-'));
    database = await createNodeSqliteFactory(directory).open('plans.sqlite');
    await runMigrations(database, FOUNDATION_MIGRATIONS);
    subscriptions = new RepositorySubscriptions();
    transactions = new SerializedTransactionRunner(database, subscriptions);
    plans = new PlansRepository(database, subscriptions);
    activities = new ActivityRepository(database, subscriptions);
  });

  afterEach(async () => {
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('survives restart and holds an authoritative Activity floor against a stale refetch', async () => {
    await transactions.run((transaction) =>
      plans.install(transaction, TIMEZONE, initial()),
    );
    expect((await plans.read(TIMEZONE))?.needsDate.map((row) => row.activityId)).toEqual([
      B,
      A,
    ]);

    await transactions.run((transaction) =>
      activities.putCanonical(transaction, detail(A, '2026-08-03T09:00:00.000Z')),
    );
    expect((await plans.read(TIMEZONE))?.needsDate.map((row) => row.activityId)).toEqual([
      A,
      B,
    ]);

    await database?.close();
    database = await createNodeSqliteFactory(directory).open('plans.sqlite');
    subscriptions = new RepositorySubscriptions();
    transactions = new SerializedTransactionRunner(database, subscriptions);
    plans = new PlansRepository(database, subscriptions);

    await transactions.run((transaction) =>
      plans.install(transaction, TIMEZONE, initial()),
    );
    const restored = await plans.read(TIMEZONE);
    expect(restored?.needsDate.map((row) => row.activityId)).toEqual([A, B]);
    expect(restored?.needsDate[0]?.lastActivityAt).toBe('2026-08-03T09:00:00.000Z');
  });
});
