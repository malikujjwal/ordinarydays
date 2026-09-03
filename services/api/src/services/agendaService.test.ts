import type { Activity, Recurrence } from '@od/shared/types';
import { describe, expect, it, vi } from 'vitest';
import type { StoredItem } from '../repositories/migrate.js';
import { projectAgendaItems } from './agendaProjection.js';
import {
  type AgendaDependencies,
  assembleAgenda,
  rollForwardOverdue,
} from './agendaService.js';

const now = '2026-08-06T19:00:00.000Z'; // 15:00 New York
let sequence = 0;

function activity(overrides: Partial<Activity> = {}): Activity {
  sequence += 1;
  const stamp = `2026-08-0${Math.min(sequence, 9)}T10:00:00.000Z`;
  return {
    activityId: `act_${String(sequence).padStart(26, '0')}`,
    ownerId: 'usr_alice',
    objectKind: 'task' as const,
    type: 'task' as const,
    status: 'scheduled' as const,
    title: `Activity ${sequence}`,
    details: { kind: 'task' as const },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private' as const,
    icsSequence: 0,
    createdAt: stamp,
    lastActivityAt: stamp,
    updatedAt: stamp,
    schemaVersion: 1 as const,
    ...overrides,
  } as Activity;
}

const index = (subject: Activity, extra: StoredItem = {}): StoredItem => ({
  activityId: subject.activityId,
  ...extra,
});

interface Fixture {
  readonly activities: readonly Activity[];
  readonly buckets?: Partial<Record<'S' | 'P' | 'N' | 'R', readonly StoredItem[]>>;
  readonly seriesCursor?: string;
  readonly overdue?: readonly StoredItem[];
  readonly occurrences?: Awaited<ReturnType<AgendaDependencies['batchAgendaRows']>>;
  readonly moved?: Awaited<ReturnType<AgendaDependencies['batchOccurrences']>>;
  readonly expanded?: readonly string[];
  readonly participants?: Readonly<Record<string, readonly StoredItem[]>>;
  readonly bucketPageSize?: number;
}

function fixture(input: Fixture) {
  const byId = new Map(input.activities.map((row) => [row.activityId, row]));
  const calls: ('S' | 'P' | 'N' | 'R')[] = [];
  const bucketCalls: {
    bucket: 'S' | 'P' | 'N' | 'R';
    options: Parameters<AgendaDependencies['listBucket']>[2];
  }[] = [];
  const listReminders = vi.fn(async () => []);
  const expand = vi.fn(() => [...(input.expanded ?? [])]);
  const listOverdue = vi.fn(async () => [...(input.overdue ?? [])]);
  const batchAgendaRows = vi.fn(
    async () => input.occurrences ?? { occurrences: [], markers: [] },
  );
  const batchOccurrences = vi.fn(async () => [...(input.moved ?? [])]);
  const batchActivities = vi.fn(async (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined ? [] : [row];
    }),
  );
  const dependencies: AgendaDependencies = {
    listBucket: async (_userId, bucket, options = {}) => {
      calls.push(bucket);
      bucketCalls.push({ bucket, options });
      const rows = [...(input.buckets?.[bucket] ?? [])];
      const pageSize = input.bucketPageSize;
      if (pageSize !== undefined && bucket !== 'R') {
        const start = options.cursor === undefined ? 0 : Number(options.cursor);
        const end = start + pageSize;
        return {
          items: rows.slice(start, end),
          ...(end < rows.length ? { nextCursor: String(end) } : {}),
        };
      }
      return {
        items: rows,
        ...(bucket === 'R' && input.seriesCursor !== undefined
          ? { nextCursor: input.seriesCursor }
          : {}),
      };
    },
    listOverdue,
    batchActivities,
    listParticipants: async (activityId) => [...(input.participants?.[activityId] ?? [])],
    batchAgendaRows,
    batchOccurrences,
    listReminders,
    expand,
    warn: vi.fn(),
  };
  return {
    dependencies,
    calls,
    bucketCalls,
    expand,
    listReminders,
    listOverdue,
    batchAgendaRows,
    batchOccurrences,
    batchActivities,
  };
}

function emitted(result: Awaited<ReturnType<typeof assembleAgenda>>) {
  return result.days.flatMap((day) => [...day.schedule, ...day.anytime, ...day.earlier]);
}

describe('agenda projection versions', () => {
  const assemble = async (indexUpdatedAt: string) => {
    const subject = activity({
      schedule: { date: '2026-08-06', time: '09:00', timezone: 'America/New_York' },
      updatedAt: '2026-08-06T14:00:00.000Z',
    });
    const setup = fixture({
      activities: [subject],
      buckets: { S: [index(subject, { updatedAt: indexUpdatedAt })] },
    });
    return assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-06',
        to: '2026-08-06',
        timezone: 'America/New_York',
        now,
      },
      setup.dependencies,
    );
  };

  it('proves a projection only when the selected index row matches canonical META', async () => {
    const result = await assemble('2026-08-06T14:00:00.000Z');

    expect(result.projectionVersions).toEqual([
      {
        activityId: emitted(result)[0]?.activity.activityId,
        version: '2026-08-06T14:00:00.000Z',
      },
    ]);
  });

  it('withholds proof while the selected index row is stale', async () => {
    const result = await assemble('2026-08-06T13:59:00.000Z');

    expect(emitted(result)).toHaveLength(1);
    expect(result.projectionVersions).toEqual([]);
  });

  it.each([
    ['matching', '2026-08-06T14:00:00.000Z', true],
    ['stale', '2026-08-06T13:59:00.000Z', false],
  ] as const)(
    '%s overdue index version controls projection proof',
    async (_, version, proven) => {
      const overdue = activity({
        schedule: { date: '2026-08-05', timezone: 'UTC' },
        updatedAt: '2026-08-06T14:00:00.000Z',
      });
      const setup = fixture({
        activities: [overdue],
        overdue: [index(overdue, { updatedAt: version })],
      });

      const result = await assembleAgenda(
        {
          userId: 'usr_alice',
          from: '2026-08-06',
          to: '2026-08-06',
          timezone: 'UTC',
          now: '2026-08-06T12:00:00.000Z',
          includeOverdue: true,
        },
        setup.dependencies,
      );

      expect(result.days[0]?.anytime[0]?.overdueFromDate).toBe('2026-08-05');
      expect(result.projectionVersions).toEqual(
        proven ? [{ activityId: overdue.activityId, version: overdue.updatedAt }] : [],
      );
    },
  );
});

describe('hydration and bucket boundaries', () => {
  it('hydrates a thin series row before one complete-recurrence expansion and never queries #P', async () => {
    const recurrence: Recurrence = {
      mode: 'fixed',
      segments: [{ freq: 'daily', effectiveFrom: '2026-08-01', time: '18:00' }],
    };
    const series = activity({
      schedule: { date: '2026-08-01', time: '18:00', timezone: 'America/New_York' },
      recurrence,
    });
    const undated = activity({ status: 'saved' });
    const subject = fixture({
      activities: [series, undated],
      buckets: { R: [index(series)], N: [index(undated)] },
      expanded: ['2026-08-06'],
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-06',
        to: '2026-08-06',
        timezone: 'America/New_York',
        now,
        includeAnytimeUnscheduled: true,
      },
      subject.dependencies,
    );

    expect(subject.calls).toEqual(['S', 'R', 'N']);
    expect(subject.calls).not.toContain('P');
    expect(subject.expand).toHaveBeenCalledWith(
      recurrence,
      '2026-08-04',
      '2026-08-08',
      'America/New_York',
    );
    expect(subject.batchAgendaRows).toHaveBeenCalledWith(
      [{ activityId: series.activityId, date: '2026-08-06' }],
      ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'].map(
        (date) => ({ activityId: series.activityId, date }),
      ),
    );
    expect(result.days[0]?.schedule.map((row) => row.activity.activityId)).toContain(
      series.activityId,
    );
    expect(result.days[0]?.anytime.map((row) => row.activity.activityId)).toContain(
      undated.activityId,
    );
  });

  it('paginates more than 200 dated items to exhaustion across a 62-day window', async () => {
    const dated = Array.from({ length: 205 }, () =>
      activity({
        schedule: { date: '2026-08-06', time: '18:00', timezone: 'UTC' },
      }),
    );
    const subject = fixture({
      activities: dated,
      buckets: { S: dated.map((row) => index(row)) },
      bucketPageSize: 73,
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-01',
        to: '2026-10-01',
        timezone: 'UTC',
        now: '2026-08-01T00:00:00.000Z',
      },
      subject.dependencies,
    );

    expect(emitted(result)).toHaveLength(205);
    expect(subject.calls.filter((bucket) => bucket === 'S')).toHaveLength(3);
    expect(
      subject.bucketCalls
        .filter(({ bucket }) => bucket === 'S')
        .map(({ options }) => options),
    ).toEqual([
      { between: ['2026-07-30T00:00', '2026-10-03T23:59'] },
      {
        between: ['2026-07-30T00:00', '2026-10-03T23:59'],
        cursor: '73',
      },
      {
        between: ['2026-07-30T00:00', '2026-10-03T23:59'],
        cursor: '146',
      },
    ]);
    expect(subject.bucketCalls.find(({ bucket }) => bucket === 'R')?.options).toEqual({
      limit: 200,
    });
  });
});

describe('today-and-tasks section 3.1 ordering', () => {
  it('orders all sections by the specified keys despite contradictory seed order', async () => {
    const series = activity({
      title: 'Series',
      schedule: { date: '2026-08-01', time: '18:00', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01', time: '18:00' }],
      },
    });
    const scheduleB = activity({
      title: 'Schedule B',
      schedule: { date: '2026-08-06', time: '18:00', timezone: 'UTC' },
    });
    const scheduleA = activity({
      title: 'Schedule A',
      schedule: { date: '2026-08-06', time: '18:00', timezone: 'UTC' },
    });
    const completedAt14 = activity({
      title: 'Completed at 14',
      status: 'completed',
      completedAt: '2026-08-06T14:00:00.000Z',
      schedule: { date: '2026-08-06', timezone: 'UTC' },
    });
    const timedAt12 = activity({
      title: 'Timed at 12',
      schedule: { date: '2026-08-06', time: '12:00', timezone: 'UTC' },
    });
    const completedAt13 = activity({
      title: 'Completed at 13',
      status: 'completed',
      completedAt: '2026-08-06T13:00:00.000Z',
      schedule: { date: '2026-08-06', timezone: 'UTC' },
    });
    const untimedToday = activity({
      title: 'Untimed today',
      schedule: { date: '2026-08-06', timezone: 'UTC' },
    });
    const undatedOld = activity({ status: 'saved', title: 'Undated old' });
    const undatedNew = activity({ status: 'saved', title: 'Undated new' });
    const overdue = activity({
      title: 'Overdue',
      schedule: { date: '2026-08-04', timezone: 'UTC' },
    });
    const all = [
      series,
      scheduleB,
      scheduleA,
      completedAt14,
      timedAt12,
      completedAt13,
      untimedToday,
      undatedOld,
      undatedNew,
      overdue,
    ];
    const subject = fixture({
      activities: all,
      buckets: {
        // Each seed list deliberately disagrees with at least one required output key.
        R: [index(series)],
        S: [
          index(scheduleA),
          index(scheduleB),
          index(timedAt12),
          index(completedAt13),
          index(completedAt14),
          index(untimedToday),
        ],
        N: [index(undatedOld), index(undatedNew)],
      },
      overdue: [index(overdue)],
      expanded: ['2026-08-06'],
      occurrences: {
        occurrences: [],
        markers: [
          {
            activityId: series.activityId,
            destinationDate: '2026-08-06',
            movedFrom: ['2026-08-05', '2026-08-04'],
          },
        ],
      },
      moved: [
        {
          activityId: series.activityId,
          date: '2026-08-05',
          status: 'rescheduled',
          overrideDate: '2026-08-06',
          overrideTime: '18:00',
        },
        {
          activityId: series.activityId,
          date: '2026-08-04',
          status: 'rescheduled',
          overrideDate: '2026-08-06',
          overrideTime: '18:00',
        },
      ],
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-06',
        to: '2026-08-06',
        timezone: 'UTC',
        now: '2026-08-06T15:00:00.000Z',
        includeAnytimeUnscheduled: true,
        includeOverdue: true,
      },
      subject.dependencies,
    );
    const day = result.days[0];

    expect(day?.schedule.map((row) => [row.activity.title, row.occurrenceDate])).toEqual([
      ['Series', '2026-08-04'],
      ['Series', '2026-08-05'],
      ['Series', '2026-08-06'],
      ['Schedule B', undefined],
      ['Schedule A', undefined],
    ]);
    expect(day?.earlier.map((row) => row.activity.title)).toEqual([
      'Completed at 14',
      'Completed at 13',
      'Timed at 12',
    ]);
    expect(day?.anytime.map((row) => row.activity.title)).toEqual([
      'Overdue',
      'Untimed today',
      'Undated new',
      'Undated old',
    ]);
  });
});

describe('undated Task completion day', () => {
  it('keeps a completed undated Task in Earlier Today only on its viewer-local completion day', async () => {
    const completedLater = activity({
      status: 'completed',
      title: 'Completed later',
      completedAt: '2026-08-06T14:00:00.000Z',
    });
    const completedMorning = activity({
      status: 'completed',
      title: 'Completed this morning',
      completedAt: '2026-08-06T13:00:00.000Z',
    });
    const completedYesterday = activity({
      status: 'completed',
      title: 'Completed last night',
      completedAt: '2026-08-06T03:30:00.000Z',
    });
    const saved = activity({ status: 'saved', title: 'Still anytime' });
    const subject = fixture({
      activities: [completedLater, completedMorning, completedYesterday, saved],
      buckets: {
        N: [
          index(completedLater),
          index(completedMorning),
          index(completedYesterday),
          index(saved),
        ],
      },
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-06',
        to: '2026-08-06',
        timezone: 'America/New_York',
        now: '2026-08-06T15:00:00.000Z',
        includeAnytimeUnscheduled: true,
      },
      subject.dependencies,
    );

    expect(result.days[0]?.earlier.map((row) => row.activity.title)).toEqual([
      'Completed later',
      'Completed this morning',
    ]);
    expect(result.days[0]?.anytime.map((row) => row.activity.title)).toEqual([
      'Still anytime',
    ]);
  });
});

describe('occurrence merge matrix', () => {
  it('applies snoozed, completed, skipped and moved-in rows without changing the series', async () => {
    const series = activity({
      schedule: { date: '2026-08-01', time: '18:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01', time: '18:00' }],
      },
    });
    const subject = fixture({
      activities: [series],
      buckets: { R: [index(series)] },
      expanded: ['2026-08-05', '2026-08-06', '2026-08-07'],
      occurrences: {
        occurrences: [
          {
            activityId: series.activityId,
            date: '2026-08-05',
            status: 'snoozed',
            snoozedUntil: '20:00',
          },
          {
            activityId: series.activityId,
            date: '2026-08-06',
            status: 'completed',
            completedAt: now,
          },
          { activityId: series.activityId, date: '2026-08-07', status: 'skipped' },
        ],
        markers: [
          {
            activityId: series.activityId,
            destinationDate: '2026-08-06',
            movedFrom: ['2026-08-04'],
          },
        ],
      },
      moved: [
        {
          activityId: series.activityId,
          date: '2026-08-04',
          status: 'rescheduled',
          overrideDate: '2026-08-06',
          overrideTime: '08:00',
        },
      ],
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-05',
        to: '2026-08-07',
        timezone: 'America/New_York',
        now,
      },
      subject.dependencies,
    );
    const rows = result.days.flatMap((day) => [
      ...day.schedule,
      ...day.anytime,
      ...day.earlier,
    ]);

    expect(rows.find((row) => row.occurrenceDate === '2026-08-05')?.time).toBe('20:00');
    expect(rows.find((row) => row.occurrenceDate === '2026-08-06')?.status).toBe(
      'completed_occurrence',
    );
    expect(rows.find((row) => row.occurrenceDate === '2026-08-07')?.status).toBe(
      'skipped_occurrence',
    );
    const moved = rows.filter((row) => row.occurrenceDate === '2026-08-04');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ viewerDate: '2026-08-06', time: '08:00' });
    expect(series.updatedAt).toBe(series.createdAt);
  });
});

describe('transferred acceptance cases 25-28', () => {
  it('[25] snoozes one daily occurrence without rewriting or re-anchoring the series', async () => {
    const recurrence: Recurrence = {
      mode: 'fixed',
      segments: [{ freq: 'daily', effectiveFrom: '2026-08-01', time: '18:00' }],
    };
    const series = activity({
      schedule: { date: '2026-08-01', time: '17:00', timezone: 'UTC' },
      recurrence,
    });
    const before = structuredClone(series);
    const subject = fixture({
      activities: [series],
      buckets: { R: [index(series)] },
      expanded: ['2026-08-05', '2026-08-06', '2026-08-07'],
      occurrences: {
        occurrences: [
          {
            activityId: series.activityId,
            date: '2026-08-06',
            status: 'snoozed',
            snoozedUntil: '20:00',
          },
        ],
        markers: [],
      },
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-05',
        to: '2026-08-07',
        timezone: 'UTC',
        now: '2026-08-05T00:00:00.000Z',
      },
      subject.dependencies,
    );

    expect(
      emitted(result).map((row) => [
        row.occurrenceDate,
        row.time,
        row.originalTime,
        row.isSnoozed,
      ]),
    ).toEqual([
      ['2026-08-05', '18:00', undefined, false],
      ['2026-08-06', '20:00', '18:00', true],
      ['2026-08-07', '18:00', undefined, false],
    ]);
    expect(series).toEqual(before);
  });

  it('[26] completes one occurrence under its historical segment time without touching META', async () => {
    const series = activity({
      schedule: { date: '2026-08-01', time: '17:00', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [
          { freq: 'daily', effectiveFrom: '2026-08-01', time: '18:00' },
          { freq: 'daily', effectiveFrom: '2026-08-06', time: '20:00' },
        ],
      },
    });
    const originalUpdatedAt = series.updatedAt;
    const subject = fixture({
      activities: [series],
      buckets: { R: [index(series)] },
      expanded: ['2026-08-05', '2026-08-06'],
      occurrences: {
        occurrences: [
          {
            activityId: series.activityId,
            date: '2026-08-05',
            status: 'completed',
            completedAt: now,
          },
        ],
        markers: [],
      },
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-05',
        to: '2026-08-06',
        timezone: 'UTC',
        now: '2026-08-07T00:00:00.000Z',
      },
      subject.dependencies,
    );
    const rows = emitted(result);

    expect(rows.find((row) => row.occurrenceDate === '2026-08-05')).toMatchObject({
      status: 'completed_occurrence',
      time: '18:00',
    });
    expect(rows.find((row) => row.occurrenceDate === '2026-08-06')?.time).toBe('20:00');
    expect(series.updatedAt).toBe(originalUpdatedAt);
  });

  it('[27] emits skipped occurrences so P2-35 can hide or show them client-side', async () => {
    const series = activity({
      schedule: { date: '2026-08-01', time: '18:00', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
      },
    });
    const subject = fixture({
      activities: [series],
      buckets: { R: [index(series)] },
      expanded: ['2026-08-05', '2026-08-06', '2026-08-07'],
      occurrences: {
        occurrences: [
          { activityId: series.activityId, date: '2026-08-06', status: 'skipped' },
        ],
        markers: [],
      },
    });
    const input = {
      userId: 'usr_alice',
      from: '2026-08-05',
      to: '2026-08-07',
      timezone: 'UTC',
      now: '2026-08-05T00:00:00.000Z',
    } as const;

    const result = await assembleAgenda(input, subject.dependencies);
    expect(
      emitted(result).map((row) => [row.occurrenceDate, row.status, row.time]),
    ).toEqual([
      ['2026-08-05', 'scheduled', '18:00'],
      ['2026-08-06', 'skipped_occurrence', '18:00'],
      ['2026-08-07', 'scheduled', '18:00'],
    ]);
  });

  it('[28] keeps a normal occurrence, two moved-in rows and one time override collision-free', async () => {
    const series = activity({
      schedule: { date: '2026-08-01', time: '18:00', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
      },
    });
    const subject = fixture({
      activities: [series],
      buckets: { R: [index(series)] },
      expanded: ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'],
      occurrences: {
        occurrences: [
          {
            activityId: series.activityId,
            date: '2026-08-04',
            status: 'rescheduled',
            overrideDate: '2026-08-06',
            overrideTime: '08:00',
          },
          {
            activityId: series.activityId,
            date: '2026-08-05',
            status: 'rescheduled',
            overrideDate: '2026-08-06',
            overrideTime: '09:00',
          },
          {
            activityId: series.activityId,
            date: '2026-08-07',
            status: 'rescheduled',
            overrideTime: '21:00',
          },
        ],
        markers: [
          {
            activityId: series.activityId,
            destinationDate: '2026-08-06',
            movedFrom: ['2026-08-04', '2026-08-05'],
          },
        ],
      },
      moved: [
        {
          activityId: series.activityId,
          date: '2026-08-04',
          status: 'rescheduled',
          overrideDate: '2026-08-06',
          overrideTime: '08:00',
        },
        {
          activityId: series.activityId,
          date: '2026-08-05',
          status: 'rescheduled',
          overrideDate: '2026-08-06',
          overrideTime: '09:00',
        },
      ],
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-04',
        to: '2026-08-07',
        timezone: 'UTC',
        now: '2026-08-04T00:00:00.000Z',
      },
      subject.dependencies,
    );

    expect(result.days.find((day) => day.date === '2026-08-04')).toMatchObject({
      schedule: [],
      anytime: [],
      earlier: [],
    });
    expect(result.days.find((day) => day.date === '2026-08-05')).toMatchObject({
      schedule: [],
      anytime: [],
      earlier: [],
    });
    expect(
      emitted(result)
        .filter((row) => row.viewerDate === '2026-08-06')
        .map((row) => [row.occurrenceDate, row.time]),
    ).toEqual([
      ['2026-08-04', '08:00'],
      ['2026-08-05', '09:00'],
      ['2026-08-06', '18:00'],
    ]);
    expect(emitted(result).find((row) => row.occurrenceDate === '2026-08-07')?.time).toBe(
      '21:00',
    );
  });

  it('moves an ISO-snoozed source across days and emits it from its marker exactly once', async () => {
    const series = activity({
      schedule: { date: '2026-08-01', time: '18:00', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
      },
    });
    const moved = {
      activityId: series.activityId,
      date: '2026-08-05' as const,
      status: 'snoozed' as const,
      snoozedUntil: '2026-08-07T01:00:00.000Z',
    };
    const subject = fixture({
      activities: [series],
      buckets: { R: [index(series)] },
      expanded: ['2026-08-05', '2026-08-06'],
      occurrences: {
        occurrences: [moved],
        markers: [
          {
            activityId: series.activityId,
            destinationDate: '2026-08-07',
            movedFrom: ['2026-08-05'],
          },
        ],
      },
      moved: [moved],
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-05',
        to: '2026-08-07',
        timezone: 'UTC',
        now: '2026-08-05T00:00:00.000Z',
      },
      subject.dependencies,
    );

    const source = emitted(result).filter((row) => row.occurrenceDate === '2026-08-05');
    expect(source).toHaveLength(1);
    expect(source[0]).toMatchObject({
      viewerDate: '2026-08-07',
      time: '01:00',
      isSnoozed: true,
      movedFromDate: '2026-08-05',
    });
    expect(subject.batchOccurrences).toHaveBeenCalledWith([
      { activityId: series.activityId, date: '2026-08-05' },
    ]);
  });
});

describe('timezone widening and mixed-generation rows', () => {
  it('[30] 2026-01-01 23:30 UTC−12 becomes 2026-01-03 UTC+14 for a scheduled row', async () => {
    const oneOff = activity({
      schedule: { date: '2026-01-01', time: '23:30', timezone: 'Etc/GMT+12' },
    });
    const subject = fixture({
      activities: [oneOff],
      // No projected timezone: prove the hydrated META fallback.
      buckets: { S: [index(oneOff)] },
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-01-03',
        to: '2026-01-03',
        timezone: 'Pacific/Kiritimati',
        now: '2026-01-02T00:00:00.000Z',
      },
      subject.dependencies,
    );

    expect(result.days[0]?.schedule).toHaveLength(1);
    expect(result.days[0]?.schedule[0]).toMatchObject({
      viewerDate: '2026-01-03',
      time: '01:30',
    });
  });

  it('[30] uses projected timezone and legacy META fallback identically across New York → Tokyo midnight', async () => {
    const oneOff = activity({
      schedule: { date: '2026-08-06', time: '22:00', timezone: 'America/New_York' },
    });
    const run = async (projected: boolean) => {
      const subject = fixture({
        activities: [oneOff],
        buckets: {
          S: [index(oneOff, projected ? { timezone: 'America/New_York' } : {})],
        },
      });
      return assembleAgenda(
        {
          userId: 'usr_alice',
          from: '2026-08-07',
          to: '2026-08-07',
          timezone: 'Asia/Tokyo',
          now: '2026-08-06T00:00:00.000Z',
        },
        subject.dependencies,
      );
    };

    const projected = await run(true);
    const legacy = await run(false);
    expect(projected.days[0]?.schedule[0]?.time).toBe('11:00');
    expect(legacy.days[0]?.schedule[0]?.time).toBe('11:00');
  });

  it('[29] keeps 18:00 New York as the stored truth when viewed from London', async () => {
    const oneOff = activity({
      schedule: { date: '2026-08-06', time: '18:00', timezone: 'America/New_York' },
    });
    const run = async (projected: boolean) => {
      const subject = fixture({
        activities: [oneOff],
        buckets: {
          S: [index(oneOff, projected ? { timezone: 'America/New_York' } : {})],
        },
      });
      return assembleAgenda(
        {
          userId: 'usr_alice',
          from: '2026-08-06',
          to: '2026-08-06',
          timezone: 'Europe/London',
          now: '2026-08-06T12:00:00.000Z',
        },
        subject.dependencies,
      );
    };

    const projected = emitted(await run(true));
    const legacy = emitted(await run(false));
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ viewerDate: '2026-08-06', time: '23:00' });
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ viewerDate: '2026-08-06', time: '23:00' });
    expect(oneOff.schedule?.time).toBe('18:00');
    expect(oneOff.schedule?.timezone).toBe('America/New_York');
  });

  it('[30] widens series expansion by two days for the UTC−12 to UTC+14 jump', async () => {
    const series = activity({
      schedule: { date: '2026-01-01', time: '23:30', timezone: 'Etc/GMT+12' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-01-01' }],
      },
    });
    const subject = fixture({
      activities: [series],
      buckets: { R: [index(series)] },
      expanded: ['2026-01-01'],
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-01-03',
        to: '2026-01-03',
        timezone: 'Pacific/Kiritimati',
        now: '2026-01-02T00:00:00.000Z',
      },
      subject.dependencies,
    );

    expect(subject.expand).toHaveBeenCalledWith(
      series.recurrence,
      '2026-01-01',
      '2026-01-05',
      'Etc/GMT+12',
    );
    expect(emitted(result)).toHaveLength(1);
    expect(emitted(result)[0]).toMatchObject({
      occurrenceDate: '2026-01-01',
      viewerDate: '2026-01-03',
      time: '01:30',
    });
  });

  it('New York → Tokyo cross-midnight override enters the viewer window', async () => {
    const series = activity({
      schedule: { date: '2026-08-06', time: '23:30', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-06' }],
      },
    });
    const subject = fixture({
      activities: [series],
      buckets: { R: [index(series)] },
      expanded: ['2026-08-06'],
      occurrences: {
        occurrences: [
          {
            activityId: series.activityId,
            date: '2026-08-06',
            status: 'rescheduled',
            overrideTime: '08:00',
          },
        ],
        markers: [],
      },
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-06',
        to: '2026-08-06',
        timezone: 'Asia/Tokyo',
        now: '2026-08-05T00:00:00.000Z',
      },
      subject.dependencies,
    );

    expect(emitted(result)).toHaveLength(1);
    expect(emitted(result)[0]).toMatchObject({
      occurrenceDate: '2026-08-06',
      viewerDate: '2026-08-06',
      time: '21:00',
    });
  });
});

describe('overdue roll-forward', () => {
  it('emits only eligible 30-day tasks onto Today, oldest first, without mutating them', async () => {
    const cutoff = activity({
      title: 'At the cutoff',
      schedule: { date: '2026-07-07', timezone: 'UTC' },
    });
    const recent = activity({
      title: 'Call apartment office',
      schedule: { date: '2026-08-04', timezone: 'UTC' },
    });
    const tooOld = activity({ schedule: { date: '2026-07-06', timezone: 'UTC' } });
    const event = activity({
      type: 'event',
      objectKind: 'plan',
      details: { kind: 'event' },
      schedule: { date: '2026-08-05', timezone: 'UTC' },
    });
    const recurring = activity({
      schedule: { date: '2026-08-05', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-05' }],
      },
    });
    const completed = activity({
      status: 'completed',
      title: 'Completed overdue today',
      completedAt: now,
      schedule: { date: '2026-08-05', timezone: 'UTC' },
    });
    const completedYesterday = activity({
      status: 'completed',
      title: 'Completed overdue yesterday',
      completedAt: '2026-08-05T19:00:00.000Z',
      schedule: { date: '2026-08-04', timezone: 'UTC' },
    });
    const anytime = activity({ status: 'saved', title: 'Ordinary Anytime task' });
    const subjects = [
      cutoff,
      recent,
      tooOld,
      event,
      recurring,
      completed,
      completedYesterday,
    ];
    const before = structuredClone(subjects);
    const subject = fixture({
      activities: [...subjects, anytime],
      overdue: subjects.map((row) => index(row)),
      buckets: { N: [index(anytime)] },
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-06',
        to: '2026-08-06',
        timezone: 'UTC',
        now: '2026-08-06T12:00:00.000Z',
        includeAnytimeUnscheduled: true,
        includeOverdue: true,
      },
      subject.dependencies,
    );

    expect(subject.listOverdue).toHaveBeenCalledWith(
      'usr_alice',
      '2026-07-07',
      '2026-08-05',
    );
    expect(
      result.days[0]?.anytime.map((row) => [row.activity.title, row.overdueFromDate]),
    ).toEqual([
      ['At the cutoff', '2026-07-07'],
      ['Call apartment office', '2026-08-04'],
      ['Ordinary Anytime task', undefined],
    ]);
    expect(result.days[0]?.earlier.map((row) => row.activity.title)).toEqual([
      'Completed overdue today',
    ]);
    expect(subjects).toEqual(before);
  });

  it('does not perform the overdue query when the include token is absent', async () => {
    const overdue = activity({ schedule: { date: '2026-08-04', timezone: 'UTC' } });
    const subject = fixture({
      activities: [overdue],
      overdue: [index(overdue)],
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-06',
        to: '2026-08-06',
        timezone: 'UTC',
        now: '2026-08-06T12:00:00.000Z',
      },
      subject.dependencies,
    );

    expect(subject.listOverdue).not.toHaveBeenCalled();
    expect(emitted(result)).toEqual([]);
  });

  it('exports the separate roll-forward function with original dates intact', async () => {
    const overdue = activity({ schedule: { date: '2026-08-04', timezone: 'UTC' } });
    const subject = fixture({
      activities: [overdue],
      overdue: [index(overdue)],
    });

    await expect(
      rollForwardOverdue('usr_alice', '2026-08-06', 'UTC', subject.dependencies),
    ).resolves.toEqual([
      expect.objectContaining({
        activity: overdue,
        viewerDate: '2026-08-06',
        overdueFromDate: '2026-08-04',
      }),
    ]);
    expect(overdue.schedule?.date).toBe('2026-08-04');
  });
});

describe('bounded fan-out', () => {
  it('caps reminder and parent-participant fan-outs at ten concurrent reads', async () => {
    const parents = Array.from({ length: 25 }, () => activity());
    const children = parents.map((parent) =>
      activity({
        parentActivityId: parent.activityId,
        schedule: { date: '2026-08-06', time: '18:00', timezone: 'UTC' },
      }),
    );
    const subject = fixture({
      activities: [...parents, ...children],
      buckets: { S: [...children].reverse().map((row) => index(row)) },
    });
    let activeParticipants = 0;
    let maxParticipants = 0;
    let activeReminders = 0;
    let maxReminders = 0;
    const dependencies: AgendaDependencies = {
      ...subject.dependencies,
      listParticipants: async () => {
        activeParticipants += 1;
        maxParticipants = Math.max(maxParticipants, activeParticipants);
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        activeParticipants -= 1;
        return [];
      },
      listReminders: async () => {
        activeReminders += 1;
        maxReminders = Math.max(maxReminders, activeReminders);
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        activeReminders -= 1;
        return [];
      },
    };

    await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-06',
        to: '2026-08-06',
        timezone: 'UTC',
        now,
        includeReminders: true,
      },
      dependencies,
    );

    expect(maxParticipants).toBe(10);
    expect(maxReminders).toBe(10);
  });

  it('adds zero reads while projecting any number of AgendaItems', async () => {
    const series = activity({
      schedule: { date: '2026-08-01', time: '18:00', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
      },
    });
    const subject = fixture({
      activities: [series],
      buckets: {
        R: [
          index(series, {
            participantAvatars: [
              { personId: 'psn_alice', displayName: 'Alice' },
              { personId: 42, displayName: 'Invalid' },
            ],
          }),
        ],
      },
      expanded: ['2026-08-05', '2026-08-06', '2026-08-07'],
    });
    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-05',
        to: '2026-08-07',
        timezone: 'UTC',
        now,
      },
      subject.dependencies,
    );
    const candidates = emitted(result);
    const readsBeforeProjection = subject.batchActivities.mock.calls.length;

    const projected = projectAgendaItems(candidates, {
      now,
      timezone: 'UTC',
      today: '2026-08-05',
    });

    expect(subject.batchActivities).toHaveBeenCalledTimes(readsBeforeProjection);
    expect(projected).toHaveLength(3);
    expect(projected[0]?.participantAvatars).toEqual([
      { personId: 'psn_alice', displayName: 'Alice' },
    ]);
  });

  it('reuses one action context and one reminder read across repeated occurrences', async () => {
    const series = activity({
      schedule: { date: '2026-08-01', time: '18:00', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
      },
    });
    const subject = fixture({
      activities: [series],
      buckets: { R: [index(series)] },
      expanded: ['2026-08-05', '2026-08-06', '2026-08-07'],
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-05',
        to: '2026-08-07',
        timezone: 'UTC',
        now,
        includeReminders: true,
      },
      subject.dependencies,
    );
    const rows = result.days.flatMap((day) => [...day.schedule, ...day.earlier]);

    expect(subject.listReminders).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.actionContext).toBe(rows[1]?.actionContext);
  });

  it('hydrates parent access once and distinguishes a participant child from its owned parent', async () => {
    const parent = activity({ ownerId: 'usr_alice' });
    const child = activity({
      ownerId: 'usr_bob',
      parentActivityId: parent.activityId,
      schedule: { date: '2026-08-06', time: '18:00', timezone: 'UTC' },
    });
    const subject = fixture({
      activities: [parent, child],
      buckets: { S: [index(child)] },
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-06',
        to: '2026-08-06',
        timezone: 'UTC',
        now,
      },
      subject.dependencies,
    );

    const candidate = result.days.flatMap((day) => [
      ...day.schedule,
      ...day.anytime,
      ...day.earlier,
    ])[0];
    expect(candidate?.actionContext).toMatchObject({
      callerRole: 'participant',
      parentOwnerId: 'usr_alice',
      participatesInParent: true,
    });
  });
});

describe('warnings and projection branches', () => {
  it('warns on the series cap, missing META and duplicate expanded occurrences', async () => {
    const series = activity({
      schedule: { date: '2026-08-01', time: '18:00', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
      },
    });
    const cancelledScheduled = activity({
      status: 'cancelled',
      schedule: { date: '2026-08-06', timezone: 'UTC' },
    });
    const cancelledAnytime = activity({ status: 'cancelled' });
    const skippedScheduled = activity({
      activityId: 'act_00000000000000000000000007',
      status: 'skipped',
      schedule: { date: '2026-08-06', timezone: 'UTC' },
    });
    const skippedAnytime = activity({
      activityId: 'act_00000000000000000000000008',
      status: 'skipped',
    });
    const subject = fixture({
      activities: [
        series,
        cancelledScheduled,
        cancelledAnytime,
        skippedScheduled,
        skippedAnytime,
      ],
      buckets: {
        R: [
          index(series),
          { activityId: 'act_00000000000000000000000999' },
          { activityId: 'not-a-valid-activity-id' },
        ],
        S: [index(cancelledScheduled), index(skippedScheduled)],
        N: [index(cancelledAnytime), index(skippedAnytime)],
      },
      seriesCursor: 'more',
      expanded: ['2026-08-06', '2026-08-06'],
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-06',
        to: '2026-08-06',
        timezone: 'UTC',
        now,
        includeAnytimeUnscheduled: true,
      },
      subject.dependencies,
    );

    expect(result.warnings).toEqual([
      'series_limit_exceeded',
      `duplicate_occurrence:${series.activityId}`,
    ]);
    expect(subject.dependencies.warn).toHaveBeenCalledWith(
      'Agenda dropped a missing META row.',
      expect.objectContaining({
        activityId: 'act_00000000000000000000000999',
        source: 'series',
      }),
    );
    expect(
      result.days.flatMap((day) => [...day.schedule, ...day.anytime, ...day.earlier]),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'cancelled' }),
        expect.objectContaining({ status: 'skipped' }),
      ]),
    );
    expect(subject.dependencies.warn).toHaveBeenCalledWith(
      'Agenda dropped an index row with an invalid activityId.',
      { source: 'series' },
    );
    expect(
      result.days.flatMap((day) => [...day.schedule, ...day.anytime, ...day.earlier]),
    ).toHaveLength(1);
  });

  it('projects absolute snoozes, untimed rows and converted end times', async () => {
    const absoluteSnooze = activity({
      snoozedUntil: '2026-08-06T20:30:00.000Z',
      schedule: { date: '2026-08-06', time: '09:00', timezone: 'UTC' },
    });
    const untimed = activity({ schedule: { date: '2026-08-06', timezone: 'UTC' } });
    const ranged = activity({
      schedule: {
        date: '2026-08-06',
        time: '16:00',
        endTime: '17:00',
        timezone: 'America/New_York',
      },
    });
    const subject = fixture({
      activities: [absoluteSnooze, untimed, ranged],
      buckets: {
        S: [index(absoluteSnooze), index(untimed), index(ranged)],
      },
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-06',
        to: '2026-08-06',
        timezone: 'UTC',
        now,
      },
      subject.dependencies,
    );
    const rows = result.days.flatMap((day) => [
      ...day.schedule,
      ...day.anytime,
      ...day.earlier,
    ]);

    expect(
      rows.find((row) => row.activity.activityId === absoluteSnooze.activityId),
    ).toMatchObject({ time: '20:30', originalTime: '09:00', isSnoozed: true });
    expect(
      rows.find((row) => row.activity.activityId === untimed.activityId)?.time,
    ).toBeUndefined();
    expect(
      rows.find((row) => row.activity.activityId === ranged.activityId)?.endTime,
    ).toBe('21:00');
  });
});

/**
 * The read-path amplifier behind "clicking complete on any task of the series marks the whole
 * series as complete".
 *
 * An occurrence's resolution lives on its `Occurrence` row and nowhere else (rule 3), so a
 * series that reads `completed` says nothing about any particular day. Falling back to it
 * crossed off every un-overridden occurrence at once — which is what kept the symptom alive
 * for already-damaged rows after every write path was guarded, and what a completed one-off
 * that later gains a recurrence still produces today.
 */
describe('a series status never resolves its occurrences', () => {
  const dailySeries = (status: Activity['status']) =>
    activity({
      status,
      schedule: { date: '2026-08-01', time: '18:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01', time: '18:00' }],
      },
    });

  const statusesFor = async (status: Activity['status']) => {
    const series = dailySeries(status);
    const subject = fixture({
      activities: [series],
      buckets: { R: [index(series)] },
      expanded: ['2026-08-05', '2026-08-06', '2026-08-07'],
      occurrences: { occurrences: [], markers: [] },
      moved: [],
    });
    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-05',
        to: '2026-08-07',
        timezone: 'America/New_York',
        now,
      },
      subject.dependencies,
    );
    return result.days
      .flatMap((day) => [...day.schedule, ...day.anytime, ...day.earlier])
      .map((row) => row.status);
  };

  it('renders un-overridden occurrences of a completed series as scheduled', async () => {
    expect(await statusesFor('completed')).toEqual([
      'scheduled',
      'scheduled',
      'scheduled',
    ]);
  });

  /**
   * `completed` is the only terminal status that reaches the merge at all — a `skipped` or
   * `cancelled` series is filtered out before expansion and emits nothing. That asymmetry is
   * why one unscoped completion was so visible while the equivalent skip was not, and it is
   * worth pinning: if the filter ever admits them, `unresolvedSeriesStatus` decides what they
   * render as rather than the fallback deciding by accident.
   */
  it.each([['skipped'], ['cancelled']] as const)(
    'emits no rows at all for a %s series',
    async (status) => {
      expect(await statusesFor(status)).toEqual([]);
    },
  );
});

/**
 * Reported: a recurring plan shows today's occurrence and none of the later ones.
 *
 * Every recurrence case above uses the `task` fixture, so nothing asserted that expansion is
 * blind to `objectKind` — which is exactly the axis a plan differs on. A series is a series;
 * `deriveGsi1Bucket` puts any recurring Activity in `#R`, and the window is the window.
 */
describe('a recurring plan expands like any other series', () => {
  const dailyEvent = () =>
    activity({
      objectKind: 'plan',
      type: 'event',
      details: { kind: 'event' },
      schedule: { date: '2026-08-06', time: '18:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-06', time: '18:00' }],
      },
    });

  it('emits one row per date across a multi-day window', async () => {
    const series = dailyEvent();
    const dates = ['2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09'];
    const subject = fixture({
      activities: [series],
      buckets: { R: [index(series)] },
      expanded: dates,
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-06',
        to: '2026-08-09',
        timezone: 'America/New_York',
        now,
      },
      subject.dependencies,
    );

    expect(
      result.days.map((day) => day.schedule.map((row) => row.activity.activityId)),
    ).toEqual(dates.map(() => [series.activityId]));
  });

  it('queries the recurring bucket for it, not the undated-plan one', async () => {
    const series = dailyEvent();
    const subject = fixture({
      activities: [series],
      buckets: { R: [index(series)] },
      expanded: ['2026-08-06', '2026-08-07'],
    });

    await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-06',
        to: '2026-08-07',
        timezone: 'America/New_York',
        now,
      },
      subject.dependencies,
    );

    expect(subject.calls).toContain('R');
    expect(subject.calls).not.toContain('P');
  });

  /** The projection has to carry the plan through too, or the rows exist and never render. */
  it('projects every occurrence with its own date and no checkbox', async () => {
    const series = dailyEvent();
    const dates = ['2026-08-06', '2026-08-07', '2026-08-08'];
    const subject = fixture({
      activities: [series],
      buckets: { R: [index(series)] },
      expanded: dates,
    });

    const result = await assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-06',
        to: '2026-08-08',
        timezone: 'America/New_York',
        now,
      },
      subject.dependencies,
    );

    const projected = result.days.map((day) =>
      projectAgendaItems(day.schedule, {
        now,
        timezone: 'America/New_York',
        today: '2026-08-06',
      }),
    );

    expect(projected.map((day) => day[0]?.occurrenceDate)).toEqual(dates);
    expect(projected.every((day) => day[0]?.hasCheckbox === false)).toBe(true);
    expect(projected.every((day) => day[0]?.isRecurring === true)).toBe(true);
  });
});
