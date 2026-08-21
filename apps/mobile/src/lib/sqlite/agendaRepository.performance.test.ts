import type { Activity, OccurrenceDetailProjection } from '@od/shared/types';
import { describe, expect, it, vi } from 'vitest';
import { AgendaRepository } from './agendaRepository';
import type { SqliteExecutor, SqliteReader } from './database';
import type { RevisionedProjectionReader } from './projectionReader';
import { RepositorySubscriptions } from './subscriptions';
import type { SqliteReadScheduler, TransactionContext } from './transaction';

const coverage = {
  from: '2026-08-20',
  to: '2026-08-21',
  timezone: 'America/New_York',
  include: 'anytime_unscheduled,overdue',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('AgendaRepository hot paths', () => {
  it('labels exact local target invalidations separately from immediate Agenda changes', async () => {
    const executor: SqliteExecutor = {
      all: vi.fn(async () => []),
      first: vi.fn(async () => undefined),
      exec: vi.fn(async () => undefined),
      run: vi.fn(async () => ({ changes: 0, lastInsertRowId: 0 })),
    };
    const subscriptions = new RepositorySubscriptions();
    const agenda = new AgendaRepository(executor, subscriptions);
    const invalidated = vi.fn();
    const stop = agenda.subscribe(coverage, invalidated);
    const changed = new Set<string>();

    await agenda.replaceLocalTargetRows(
      { database: executor, changed: (scope) => changed.add(scope) },
      'act_target',
      undefined,
      {
        days: [{ date: '2026-08-20', schedule: [], anytime: [], earlier: [] }],
        warnings: [],
      },
    );
    subscriptions.publish(changed, 12);
    expect(invalidated).toHaveBeenCalledExactlyOnceWith({
      kind: 'local-day',
      date: '2026-08-20',
      commitRevision: 12,
      urgent: true,
    });
    expect(agenda.version(coverage)).toBe(1);

    changed.clear();
    await agenda.replaceLocalActivityRows(
      { database: executor, changed: (scope) => changed.add(scope) },
      'act_target',
      {
        days: [{ date: '2026-08-20', schedule: [], anytime: [], earlier: [] }],
        warnings: [],
      },
    );
    subscriptions.publish(changed, 13);
    expect(invalidated).toHaveBeenLastCalledWith({
      kind: 'immediate',
      commitRevision: 13,
      urgent: true,
    });
    expect(agenda.version(coverage)).toBe(2);

    subscriptions.publish(new Set(['agenda']), 14);
    expect(invalidated).toHaveBeenLastCalledWith({
      kind: 'immediate',
      commitRevision: 14,
    });
    expect(agenda.version(coverage)).toBe(3);
    stop();
  });

  it('shares one in-flight SQLite snapshot for equivalent consumers', async () => {
    const rows = deferred<readonly []>();
    const reader: SqliteReader = {
      all: vi.fn(() => rows.promise),
      first: vi.fn(async () => ({
        warnings_json: '[]',
        projection_versions_json: null,
      })),
    };
    const agenda = new AgendaRepository(reader, new RepositorySubscriptions());

    const first = agenda.readSnapshot(coverage);
    const second = agenda.readSnapshot(coverage);
    expect(second).toBe(first);
    expect(reader.all).toHaveBeenCalledOnce();

    rows.resolve([]);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(reader.first).toHaveBeenCalledOnce();

    await agenda.readSnapshot(coverage);
    expect(reader.all).toHaveBeenCalledTimes(2);
  });

  it('does not share a pre-commit snapshot with a consumer mounted after publication', async () => {
    const firstRows = deferred<readonly []>();
    const reader: SqliteReader = {
      all: vi
        .fn<SqliteReader['all']>()
        .mockImplementationOnce(() => firstRows.promise)
        .mockResolvedValueOnce([]),
      first: vi.fn(async () => ({
        warnings_json: '[]',
        projection_versions_json: null,
      })),
    };
    const subscriptions = new RepositorySubscriptions();
    const agenda = new AgendaRepository(reader, subscriptions);

    const beforeCommit = agenda.readSnapshot(coverage);
    subscriptions.publish(new Set(['agenda']));
    const afterCommit = agenda.readSnapshot(coverage);

    expect(afterCommit).not.toBe(beforeCommit);
    await expect(afterCommit).resolves.toMatchObject({ covered: true });
    firstRows.resolve([]);
    await beforeCommit;
    expect(reader.all).toHaveBeenCalledTimes(2);
  });

  it('schedules external snapshots through a delayed background read', async () => {
    const reader: SqliteReader = {
      all: vi.fn(async () => []),
      first: vi.fn(async () => ({
        warnings_json: '[]',
        projection_versions_json: null,
      })),
    };
    const delays: number[] = [];
    const scheduler: SqliteReadScheduler = {
      read: (task, delayMs) => {
        delays.push(delayMs ?? 0);
        return task(reader);
      },
    };
    const agenda = new AgendaRepository(reader, new RepositorySubscriptions(), scheduler);

    await expect(agenda.readSnapshot(coverage)).resolves.toMatchObject({
      covered: true,
    });

    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThan(0);
    expect(reader.all).toHaveBeenCalledOnce();
    expect(reader.first).toHaveBeenCalledOnce();
  });

  it('routes committed UI rows and metadata through one revisioned reader snapshot', async () => {
    let inSnapshot = false;
    const reader: SqliteReader = {
      all: vi.fn(async () => {
        expect(inSnapshot).toBe(true);
        return [];
      }),
      first: vi.fn(async () => {
        expect(inSnapshot).toBe(true);
        return { warnings_json: '[]', projection_versions_json: null };
      }),
    };
    const projectionReader: RevisionedProjectionReader = {
      snapshot: async (task) => {
        inSnapshot = true;
        const data = await task(reader);
        inSnapshot = false;
        return {
          data,
          commitRevision: 17,
          source: 'reader',
          metrics: { callCount: 3, durationMs: 4 },
        };
      },
    };
    const agenda = new AgendaRepository(
      reader,
      new RepositorySubscriptions(),
      undefined,
      projectionReader,
    );

    const snapshot = await agenda.readSnapshot(coverage);
    expect(snapshot).toMatchObject({
      commitRevision: 17,
      source: 'reader',
      covered: true,
      metrics: { callCount: 3, durationMs: 4 },
      data: {
        days: [
          { date: '2026-08-20', schedule: [], anytime: [], earlier: [] },
          { date: '2026-08-21', schedule: [], anytime: [], earlier: [] },
        ],
      },
    });
    expect(reader.all).toHaveBeenCalledOnce();
    expect(reader.first).toHaveBeenCalledOnce();
  });

  it('returns targeted days with the revision from their exact reader snapshot', async () => {
    const reader: SqliteReader = {
      all: vi.fn(async () => []),
      first: vi.fn(async () => undefined),
    };
    const projectionReader: RevisionedProjectionReader = {
      snapshot: async (task) => ({
        data: await task(reader),
        commitRevision: 22,
        source: 'reader',
        metrics: { callCount: 2, durationMs: 3 },
      }),
    };
    const agenda = new AgendaRepository(
      reader,
      new RepositorySubscriptions(),
      undefined,
      projectionReader,
    );

    await expect(
      agenda.readDaysSnapshot(coverage, ['2026-08-20']),
    ).resolves.toMatchObject({
      commitRevision: 22,
      source: 'reader',
      metrics: { callCount: 2, durationMs: 3 },
      days: [{ date: '2026-08-20', schedule: [], anytime: [], earlier: [] }],
    });
    expect(reader.all).toHaveBeenCalledOnce();
    expect(reader.first).not.toHaveBeenCalled();
  });

  it('projects one target day with one indexed SQLite read and no coverage lookup', async () => {
    const executor: SqliteExecutor = {
      all: vi.fn(async () => []),
      first: vi.fn(async () => undefined),
      exec: vi.fn(async () => undefined),
      run: vi.fn(async () => ({ changes: 0, lastInsertRowId: 0 })),
    };
    const agenda = new AgendaRepository(executor, new RepositorySubscriptions());

    await expect(
      agenda.readMaterializedTargetDay(executor, 'act_target', '2026-08-20'),
    ).resolves.toEqual({ days: [], warnings: [] });

    expect(executor.all).toHaveBeenCalledOnce();
    expect(executor.first).not.toHaveBeenCalled();
    expect(vi.mocked(executor.all).mock.calls[0]?.[0]).toContain('WHERE viewer_date =');
  });

  it('refreshes requested Plans days without reading coverage metadata or the full window', async () => {
    const executor: SqliteExecutor = {
      all: vi.fn(async () => []),
      first: vi.fn(async () => undefined),
      exec: vi.fn(async () => undefined),
      run: vi.fn(async () => ({ changes: 0, lastInsertRowId: 0 })),
    };
    const agenda = new AgendaRepository(executor, new RepositorySubscriptions());

    await expect(
      agenda.readDays(coverage, ['2026-08-21', '2026-08-20', '2026-08-21', '2026-08-22']),
    ).resolves.toEqual([
      { date: '2026-08-20', schedule: [], anytime: [], earlier: [] },
      { date: '2026-08-21', schedule: [], anytime: [], earlier: [] },
    ]);

    expect(executor.all).toHaveBeenCalledOnce();
    expect(executor.first).not.toHaveBeenCalled();
    const [sql, parameters] = vi.mocked(executor.all).mock.calls[0] ?? [];
    expect(sql).toContain('WHERE viewer_date IN (?, ?)');
    expect(sql).not.toContain('BETWEEN');
    expect(parameters).toEqual(['2026-08-20', '2026-08-21']);
  });

  it('does not invalidate visible Agenda data for metadata-only acknowledgement', async () => {
    const run = vi
      .fn<SqliteExecutor['run']>()
      .mockResolvedValue({ changes: 0, lastInsertRowId: 0 });
    const executor: SqliteExecutor = {
      all: vi.fn(async () => []),
      first: vi.fn(async () => undefined),
      exec: vi.fn(async () => undefined),
      run,
    };
    const changed = vi.fn();
    const transaction: TransactionContext = { database: executor, changed };
    const agenda = new AgendaRepository(executor, new RepositorySubscriptions());
    const activity = {
      activityId: 'act_ack',
      title: 'Already committed locally',
      type: 'task',
      status: 'completed',
      updatedAt: '2026-08-20T12:00:00.000Z',
    } as Activity;

    await agenda.acceptCanonicalActivitySummary(transaction, activity);

    expect(run).toHaveBeenCalledTimes(2);
    expect(changed).not.toHaveBeenCalled();

    run.mockResolvedValueOnce({ changes: 1, lastInsertRowId: 0 });
    await agenda.acceptCanonicalActivitySummary(transaction, {
      ...activity,
      title: 'Server-corrected title',
    });
    expect(changed).toHaveBeenCalledWith('agenda');
  });

  it('does not invalidate an occurrence for metadata-only acknowledgement', async () => {
    const run = vi
      .fn<SqliteExecutor['run']>()
      .mockResolvedValue({ changes: 0, lastInsertRowId: 0 });
    const executor: SqliteExecutor = {
      all: vi.fn(async () => []),
      first: vi.fn(async () => undefined),
      exec: vi.fn(async () => undefined),
      run,
    };
    const changed = vi.fn();
    const transaction: TransactionContext = { database: executor, changed };
    const agenda = new AgendaRepository(executor, new RepositorySubscriptions());
    const activity = {
      activityId: 'act_recurring_ack',
      title: 'Recurring task',
      type: 'task',
      status: 'scheduled',
      updatedAt: '2026-08-20T12:00:00.000Z',
    } as Activity;
    const projection: OccurrenceDetailProjection = {
      date: '2026-08-21',
      nominalDate: '2026-08-20',
      status: 'completed',
      time: '09:00',
      endTime: '09:30',
      isSnoozed: true,
    };

    await agenda.acceptCanonicalOccurrence(transaction, activity, projection);

    expect(run).toHaveBeenCalledTimes(2);
    expect(changed).not.toHaveBeenCalled();

    run.mockResolvedValueOnce({ changes: 1, lastInsertRowId: 0 });
    await agenda.acceptCanonicalOccurrence(transaction, activity, {
      ...projection,
      status: 'scheduled',
    });
    expect(changed).toHaveBeenCalledWith('agenda');
  });
});
