import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWallDate, plansData } from '@od/shared/schemas';
import type { ActivityDetail, AgendaItem } from '@od/shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeedsDateRowData } from '@/features/agenda/model/plansApply';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';
import { ActivityRepository } from './activityRepository';
import { AgendaRepository } from './agendaRepository';
import type { SqliteDatabase } from './database';
import { FOUNDATION_MIGRATIONS, runMigrations } from './migrations';
import { PlansRepository } from './plansRepository';
import type { RevisionedProjectionReader } from './projectionReader';
import { RepositorySubscriptions } from './subscriptions';
import { SerializedTransactionRunner } from './transaction';

const TIMEZONE = 'America/New_York';
const OWNER = 'usr_01J0000000000000000000000A';
const A = 'act_01J8PANA000000000000000000';
const B = 'act_01J8PANB000000000000000000';
const PLANS_DATE = parseWallDate('2026-08-10');

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

function scheduledDetail(activityId: string): ActivityDetail {
  const base = detail(activityId, '2026-08-09T12:00:00.000Z');
  return {
    ...base,
    activity: {
      ...base.activity,
      objectKind: 'task',
      type: 'task',
      status: 'scheduled',
      details: { kind: 'task' },
      schedule: { date: PLANS_DATE, timezone: TIMEZONE },
    },
  };
}

function datedItem(
  activityId: string,
  status: AgendaItem['status'] = 'scheduled',
): AgendaItem {
  return {
    activityId,
    type: 'task',
    title: activityId,
    status,
    isRecurring: false,
    isSnoozed: false,
    hasCheckbox: true,
    capabilities: { complete: true, skip: true, snooze: true },
    participantAvatars: [],
    participantCount: 0,
    isPast: false,
  };
}

function initial(upcoming: readonly AgendaItem[] = []) {
  return plansData.parse({
    mode: 'initial',
    needsDate: [
      needsDateRow(B, '2026-08-02T10:00:00.000Z'),
      needsDateRow(A, '2026-08-01T10:00:00.000Z'),
    ],
    upcoming: upcoming.length === 0 ? [] : [{ date: PLANS_DATE, items: upcoming }],
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
  let agenda: AgendaRepository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ordinarydays-plans-'));
    database = await createNodeSqliteFactory(directory).open('plans.sqlite');
    await runMigrations(database, FOUNDATION_MIGRATIONS);
    subscriptions = new RepositorySubscriptions();
    transactions = new SerializedTransactionRunner(database, subscriptions);
    plans = new PlansRepository(database, subscriptions);
    activities = new ActivityRepository(database, subscriptions);
    agenda = new AgendaRepository(database, subscriptions);
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

  it('serves overlapping UI reads through the serialized projection reader', async () => {
    if (database === undefined) throw new Error('missing plans database');
    const current = database;
    let served = 0;
    /* The account reader's writer-fallback path: reads queue on the serialized scheduler. */
    const projections: RevisionedProjectionReader = {
      snapshot: <T>(task: Parameters<RevisionedProjectionReader['snapshot']>[0]) =>
        transactions.read(async (reader) => {
          served += 1;
          return {
            data: (await task(reader)) as T,
            commitRevision: 1,
            source: 'writer-fallback' as const,
            metrics: { callCount: 1, durationMs: 0 },
          };
        }),
    };
    const projected = new PlansRepository(current, subscriptions, projections);
    await transactions.run((transaction) =>
      projected.install(transaction, TIMEZONE, initial()),
    );

    // The native hook issues two reads on mount. A bare writer-connection transaction nests
    // BEGIN under the other read (the device reports it as a failed ROLLBACK)...
    await expect(
      Promise.all([plans.read(TIMEZONE), plans.read(TIMEZONE)]),
    ).rejects.toThrow(/within a transaction/);

    // ...while the projection reader serializes them.
    const [first, second] = await Promise.all([
      projected.read(TIMEZONE),
      projected.read(TIMEZONE),
    ]);

    expect(served).toBe(2);
    expect(first?.needsDate.map((row) => row.activityId)).toEqual([B, A]);
    expect(second).toEqual(first);
  });

  it('publishes and reads a newly created dated Task before the Plans index catches up', async () => {
    const created = datedItem(A);
    await transactions.run((transaction) =>
      plans.install(transaction, TIMEZONE, initial()),
    );
    const invalidated = vi.fn();
    const stop = plans.subscribe(invalidated);

    await transactions.run(async (transaction) => {
      await activities.putCanonical(transaction, scheduledDetail(A));
      await agenda.replaceLocalActivityRows(transaction, A, {
        days: [
          {
            date: PLANS_DATE,
            schedule: [created],
            anytime: [],
            earlier: [],
          },
        ],
        warnings: [],
      });
    });
    stop();

    expect(invalidated).toHaveBeenCalledOnce();
    expect((await plans.read(TIMEZONE))?.store.byDate.get(PLANS_DATE)).toEqual([created]);
  });

  it('publishes a local Plan completion whose status is joined into the Plans row', async () => {
    const scheduled = {
      ...datedItem(A),
      type: 'custom' as const,
      hasCheckbox: false,
    };
    const completed = { ...scheduled, status: 'completed' as const };
    await transactions.run((transaction) =>
      plans.install(transaction, TIMEZONE, initial([scheduled])),
    );
    await transactions.run((transaction) =>
      agenda.replaceLocalActivityRows(transaction, A, {
        days: [
          {
            date: PLANS_DATE,
            schedule: [scheduled],
            anytime: [],
            earlier: [],
          },
        ],
        warnings: [],
      }),
    );
    const invalidated = vi.fn();
    const stop = plans.subscribe(invalidated);

    await transactions.run((transaction) =>
      agenda.replaceLocalTargetRows(transaction, A, undefined, {
        days: [
          {
            date: PLANS_DATE,
            schedule: [],
            anytime: [],
            earlier: [completed],
          },
        ],
        warnings: [],
      }),
    );
    stop();

    expect(invalidated).toHaveBeenCalledOnce();
    expect((await plans.read(TIMEZONE))?.store.byDate.get(PLANS_DATE)).toEqual([
      completed,
    ]);
  });
});
