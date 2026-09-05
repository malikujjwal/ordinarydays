import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CreateActivityInput, parseWallDate, plansData } from '@od/shared/schemas';
import type { ActivityDetail, AgendaItem } from '@od/shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeedsDateRowData } from '@/features/agenda/model/plansApply';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';
import { ActivityRepository } from './activityRepository';
import { ActivityTransactionService } from './activityTransactions';
import { AgendaRepository } from './agendaRepository';
import type { SqliteDatabase } from './database';
import { FOUNDATION_MIGRATIONS, runMigrations } from './migrations';
import { OutboxRepository } from './outbox';
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

  it('installs a new page without rewriting other dates and removes an exhausted empty date', async () => {
    if (database === undefined) throw new Error('Missing database');
    await transactions.run((transaction) =>
      plans.install(transaction, TIMEZONE, initial([datedItem(A)])),
    );
    await database.exec(`
      CREATE TABLE page_write_audit (date TEXT);
      CREATE TRIGGER audit_plans_delete AFTER DELETE ON native_plans_date_rows
      BEGIN INSERT INTO page_write_audit VALUES (OLD.date); END;
      CREATE TRIGGER audit_plans_insert AFTER INSERT ON native_plans_date_rows
      BEGIN INSERT INTO page_write_audit VALUES (NEW.date); END;
    `);
    const page = plansData.parse({
      mode: 'upcoming_window',
      upcoming: [{ date: '2026-10-07', items: [datedItem(B)] }],
      upcomingWindow: { from: '2026-10-07', through: '2026-12-07', nextFrom: null },
      warnings: [],
    });
    await transactions.run((transaction) => plans.install(transaction, TIMEZONE, page));
    expect(
      await database.all('SELECT date FROM page_write_audit WHERE date = ?;', [
        PLANS_DATE,
      ]),
    ).toEqual([]);
    expect(
      (await plans.read(TIMEZONE))?.store.byDate.get(PLANS_DATE)?.[0]?.activityId,
    ).toBe(A);
    await transactions.run((transaction) =>
      plans.install(
        transaction,
        TIMEZONE,
        plansData.parse({
          mode: 'upcoming_window',
          upcoming: [],
          upcomingWindow: {
            from: '2026-08-10',
            through: '2026-08-10',
            nextFrom: '2026-08-11',
          },
          warnings: [],
        }),
      ),
    );
    const current = await plans.read(TIMEZONE);
    expect(current?.store.byDate.has(PLANS_DATE)).toBe(false);
    expect(current?.store.byDate.get(parseWallDate('2026-10-07'))?.[0]?.activityId).toBe(
      B,
    );
  });

  it('merges replayed partial Past pages by identity and replaces exhausted dates', async () => {
    await transactions.run((transaction) =>
      plans.install(transaction, TIMEZONE, initial()),
    );
    const partial = (items: AgendaItem[]) =>
      plansData.parse({
        mode: 'past_cursor',
        past: [{ date: '2026-07-04', items }],
        pastPage: {},
        warnings: [],
      });
    for (const response of [
      partial([datedItem(A)]),
      partial([datedItem(B)]),
      partial([datedItem(A, 'completed')]),
    ]) {
      await transactions.run((transaction) =>
        plans.install(transaction, TIMEZONE, response),
      );
    }
    expect(
      (await plans.read(TIMEZONE))?.store.byDate
        .get(parseWallDate('2026-07-04'))
        ?.map((item) => [item.activityId, item.status]),
    ).toEqual([
      [A, 'completed'],
      [B, 'scheduled'],
    ]);
    await transactions.run((transaction) =>
      plans.install(
        transaction,
        TIMEZONE,
        plansData.parse({
          mode: 'past_window',
          past: [],
          pastCoverage: {
            requestedFrom: '2026-07-04',
            requestedThrough: '2026-07-04',
            coveredFrom: '2026-07-04',
            coveredThrough: '2026-07-04',
            complete: true,
          },
          warnings: [],
        }),
      ),
    );
    expect(
      (await plans.read(TIMEZONE))?.store.byDate.has(parseWallDate('2026-07-04')),
    ).toBe(false);
  });

  it.each(['task', 'plan', 'linked-plan'] as const)(
    'projects a new daily %s throughout loaded Plans windows without filling distant gaps',
    async (kind) => {
      if (database === undefined) throw new Error('Missing database');
      const service = new ActivityTransactionService(
        new OutboxRepository(database),
        activities,
        agenda,
      );
      await transactions.run(async (transaction) => {
        await plans.install(transaction, TIMEZONE, initial());
        await plans.install(
          transaction,
          TIMEZONE,
          plansData.parse({
            mode: 'upcoming_window',
            upcoming: [],
            warnings: [],
            upcomingWindow: { from: '2027-09-01', through: '2027-09-30', nextFrom: null },
          }),
        );
        await transaction.database.run(
          "INSERT INTO agenda_coverage (from_date, to_date, timezone, include_key, refreshed_at, warnings_json) VALUES ('2026-09-04', '2026-09-11', ?, '', '2026-09-04T12:00:00.000Z', '[]');",
          [TIMEZONE],
        );
        const fields = {
          title: 'Daily after the first week',
          schedule: { date: '2026-09-04', time: '09:00', timezone: TIMEZONE },
          recurrence: {
            mode: 'fixed' as const,
            segments: [
              { freq: 'daily' as const, interval: 1, effectiveFrom: '2026-09-04' },
            ],
          },
        } satisfies Pick<CreateActivityInput, 'title' | 'schedule' | 'recurrence'>;
        const clock = { today: '2026-09-04', currentMinute: '08:00' };
        if (kind === 'linked-plan') {
          await service.scheduleListItem(
            transaction,
            OWNER,
            {
              activityId: A,
              listId: 'lst_01J0000000000000000000000A',
              itemId: 'itm_01J0000000000000000000000A',
              idempotencyKey: 'daily-loaded-plans',
              input: {
                ...fields,
                activityId: A,
                audience: { mode: 'just_me' },
                creationTarget: { objectKind: 'plan', type: 'custom' },
              },
            },
            clock,
            '2026-09-04T12:00:00.000Z',
          );
        } else {
          await service.create(
            transaction,
            OWNER,
            {
              input: {
                ...fields,
                activityId: A,
                ...(kind === 'task'
                  ? { objectKind: 'task' as const, type: 'task' as const }
                  : { objectKind: 'plan' as const, type: 'custom' as const }),
              },
              idempotencyKey: 'daily-loaded-plans',
            },
            clock,
            '2026-09-04T12:00:00.000Z',
          );
        }
      });
      const projection = await plans.read(TIMEZONE);
      for (const date of ['2026-09-12', '2026-10-06', '2027-09-15']) {
        expect(projection?.store.byDate.get(parseWallDate(date))).toEqual([
          expect.objectContaining({
            activityId: A,
            title: 'Daily after the first week',
            occurrenceDate: date,
            status: 'scheduled',
          }),
        ]);
      }
      expect(
        await database.all(
          "SELECT viewer_date FROM agenda_rows WHERE viewer_date > '2026-10-06' AND viewer_date < '2027-09-01';",
        ),
      ).toEqual([]);
      const outbox = new OutboxRepository(database);
      const created = await activities.read({ kind: 'activity', activityId: A });
      if (created === undefined) throw new Error('Missing created Activity');
      await transactions.run(async (transaction) => {
        await activities.installAcknowledgedActivity(
          transaction,
          created.activity,
          created,
        );
        await agenda.acceptCanonicalActivitySummary(transaction, created.activity);
        await outbox.acknowledge(transaction.database, 'daily-loaded-plans');
        // An eventually consistent Plans response can still be empty after the create ack.
        await plans.install(
          transaction,
          TIMEZONE,
          plansData.parse({
            mode: 'upcoming_window',
            upcoming: [],
            warnings: [],
            upcomingWindow: { from: '2026-09-12', through: '2026-10-06', nextFrom: null },
          }),
        );
      });
      expect(
        (await plans.read(TIMEZONE))?.store.byDate.get(parseWallDate('2026-09-12')),
      ).toEqual(projection?.store.byDate.get(parseWallDate('2026-09-12')));
      // A newly constructed reader has the same durable projection, without a network refresh.
      expect(
        (
          await new PlansRepository(database, subscriptions).read(TIMEZONE)
        )?.store.byDate.get(parseWallDate('2026-09-12')),
      ).toEqual(projection?.store.byDate.get(parseWallDate('2026-09-12')));
    },
  );

  it('preserves the first unknown scrolling window across distant calendar installs', async () => {
    const first = initial();
    if (first.mode !== 'initial') throw new Error('Expected initial fixture');
    await transactions.run((transaction) =>
      plans.install(transaction, TIMEZONE, {
        ...first,
        upcomingWindow: { ...first.upcomingWindow, nextFrom: '2026-10-07' },
      }),
    );
    const installWindow = async (
      from: string,
      through: string,
      nextFrom: string | null,
    ) => {
      await transactions.run((transaction) =>
        plans.install(
          transaction,
          TIMEZONE,
          plansData.parse({
            mode: 'upcoming_window',
            upcoming: [],
            warnings: [],
            upcomingWindow: { from, through, nextFrom },
          }),
        ),
      );
    };
    await installWindow('2027-09-01', '2027-09-30', null);
    expect((await plans.read(TIMEZONE))?.upcomingWindow).toMatchObject({
      through: '2027-09-30',
      nextFrom: '2026-10-07',
    });
    await installWindow('2026-10-07', '2026-12-07', '2026-12-08');
    expect((await plans.read(TIMEZONE))?.upcomingWindow).toMatchObject({
      through: '2027-09-30',
      nextFrom: '2026-12-08',
    });
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

  it('reads a locally snoozed time from Agenda before the Plans index catches up', async () => {
    const scheduled = { ...datedItem(A), time: '09:00' };
    const snoozed = {
      ...scheduled,
      time: '10:30',
      isSnoozed: true,
      originalTime: '09:00',
    };
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

    await transactions.run((transaction) =>
      agenda.replaceLocalTargetRows(transaction, A, undefined, {
        days: [
          {
            date: PLANS_DATE,
            schedule: [snoozed],
            anytime: [],
            earlier: [],
          },
        ],
        warnings: [],
      }),
    );

    expect((await plans.read(TIMEZONE))?.store.byDate.get(PLANS_DATE)).toEqual([snoozed]);
  });
});
