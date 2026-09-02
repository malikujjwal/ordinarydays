import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Activity } from '@od/shared/types';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredItem } from '../repositories/migrate.js';
import type { AgendaCandidate } from './agendaService.js';
import type { PlansDependencies } from './plansService.js';
import { getPlans } from './plansService.js';

/**
 * Which streams each mode starts, and what the response is allowed to say (§P3-20).
 *
 * Driven through injected dependencies rather than a database, because the property under test
 * is the **query plan**: that scrolling Upcoming does not pay for Needs a date, that a bounded
 * Past window delegates `#S` and `#R` to shared assembly, and that `#N` is never read by
 * anything. Those are facts about the calls made, and a passing response body proves none of
 * them.
 */

const USER = 'usr_local_dev';
const TZ = 'America/New_York';
const NOW = '2026-09-01T15:00:00.000Z';
const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(QueryCommand).resolves({ Items: [] });
});

const plan = (overrides: Partial<Activity> = {}): Activity =>
  ({
    activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
    ownerId: USER,
    status: 'saved',
    objectKind: 'plan',
    type: 'event',
    title: 'Poconos trip',
    details: { kind: 'event' },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActivityAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  }) as Activity;

const indexRow = (activityId: string): StoredItem => ({
  pk: `USER#${USER}`,
  sk: `IDX#${activityId}`,
  entity: 'ActivityIndex',
  schemaVersion: 1,
  activityId,
  participantAvatars: [],
});

interface Recorded {
  readonly bucket: string;
  readonly options: Record<string, unknown>;
}

function deps(overrides: Partial<PlansDependencies> = {}): {
  dependencies: PlansDependencies;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const dependencies: PlansDependencies = {
    listBucket: vi.fn(async (_userId: string, bucket: string, options = {}) => {
      calls.push({ bucket, options: options as Record<string, unknown> });
      return { items: [] };
    }) as unknown as PlansDependencies['listBucket'],
    batchActivities: vi.fn(async () => []) as PlansDependencies['batchActivities'],
    assemble: vi.fn(async () => ({
      days: [],
      warnings: [],
      projectionVersions: [],
    })) as unknown as PlansDependencies['assemble'],
    expand: vi.fn(() => []) as unknown as PlansDependencies['expand'],
    warn: vi.fn(),
    ...overrides,
  };
  return { dependencies, calls };
}

const bucketsIn = (calls: readonly Recorded[]) => [
  ...new Set(calls.map((c) => c.bucket)),
];

function recurringCandidate(
  activity: Activity,
  occurrenceDate: string,
  status: AgendaCandidate['status'],
): AgendaCandidate {
  return {
    activity,
    occurrenceDate,
    status,
    viewerDate: occurrenceDate,
    ...(activity.schedule?.time === undefined ? {} : { time: activity.schedule.time }),
    isSnoozed: false,
    participantAvatars: [],
    actionContext: {
      activity,
      callerId: USER,
      callerRole: 'owner',
      participatesInParent: false,
    },
  };
}

describe('actual DynamoDB round-trip budget', () => {
  it('pins initial mode to six repository Query commands', async () => {
    await getPlans(USER, { mode: 'initial', tz: TZ }, NOW);

    const buckets = ddbMock
      .commandCalls(QueryCommand)
      .map(
        (call) =>
          call.args[0].input.ExpressionAttributeValues?.[':pk'] as string | undefined,
      );
    expect(buckets).toHaveLength(6);
    expect(buckets.filter((bucket) => bucket === `U#${USER}#P`)).toHaveLength(1);
    expect(buckets.filter((bucket) => bucket === `U#${USER}#S`)).toHaveLength(3);
    expect(buckets.filter((bucket) => bucket === `U#${USER}#R`)).toHaveLength(2);
    expect(buckets).not.toContain(`U#${USER}#N`);
  });
});

describe('which streams each mode starts', () => {
  it('initial reads #P, both #S slices and #R — and never #N', async () => {
    const { dependencies, calls } = deps();

    await getPlans(USER, { mode: 'initial', tz: TZ }, NOW, dependencies);

    expect(bucketsIn(calls).sort()).toEqual(['P', 'R', 'S']);
    expect(bucketsIn(calls)).not.toContain('N');

    /**
     * Two distinct `#S` slices, told apart by direction: the future probe reads ascending and
     * the past scan descending. One shared bucket, two streams — which is why the count of
     * calls alone would not prove this.
     */
    const scheduled = calls.filter((c) => c.bucket === 'S');
    expect(scheduled.some((c) => c.options.ascending === false)).toBe(true);
    expect(scheduled.some((c) => c.options.ascending !== false)).toBe(true);
    /**
     * P3-20's documented initial-mode budget exception is fixed, not open-ended: at the
     * Plans coordinator seam there are exactly four bucket calls, while shared agenda
     * assembly remains one separately owned operation. A fifth call is a budget regression.
     */
    expect(calls).toHaveLength(4);
    expect(dependencies.assemble).toHaveBeenCalledTimes(1);
  });

  it('an upcoming continuation reads neither needs-a-date nor past', async () => {
    const { dependencies, calls } = deps();

    await getPlans(
      USER,
      {
        mode: 'upcoming_window',
        tz: TZ,
        upcomingFrom: '2026-11-01',
        upcomingTo: '2026-12-01',
      },
      NOW,
      dependencies,
    );

    expect(bucketsIn(calls)).not.toContain('P');
    expect(bucketsIn(calls)).not.toContain('N');
    // Every `#S` read on this path is the ascending future probe behind `nextFrom`.
    expect(
      calls.filter((c) => c.bucket === 'S').every((c) => c.options.ascending !== false),
    ).toBe(true);
  });

  it('routes a bounded Past window through shared recurrence assembly', async () => {
    const { dependencies, calls } = deps();

    await getPlans(
      USER,
      {
        mode: 'past_window',
        tz: TZ,
        pastFrom: '2026-08-01',
        pastBefore: '2026-09-01',
      },
      NOW,
      dependencies,
    );

    expect(calls).toEqual([]);
    expect(dependencies.assemble).toHaveBeenCalledOnce();
    expect(vi.mocked(dependencies.assemble).mock.calls[0]?.[0]).toMatchObject({
      from: '2026-08-01',
      to: '2026-08-31',
      includeAnytimeUnscheduled: false,
      includeOverdue: false,
      includeReminders: false,
    });
  });

  /** The shared expansion path owns recurrence; this service must not call it for Upcoming. */
  it('routes upcoming expansion through the shared agenda path', async () => {
    const { dependencies } = deps();

    await getPlans(USER, { mode: 'initial', tz: TZ }, NOW, dependencies);

    expect(dependencies.assemble).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dependencies.assemble).mock.calls[0]?.[0]).toMatchObject({
      includeAnytimeUnscheduled: false,
      includeOverdue: false,
      includeReminders: false,
    });
  });

  it('propagates the shared path’s warnings untouched', async () => {
    const { dependencies } = deps({
      assemble: vi.fn(async () => ({
        days: [],
        warnings: ['series_limit_exceeded'],
        projectionVersions: [],
      })) as unknown as PlansDependencies['assemble'],
    });

    const data = await getPlans(USER, { mode: 'initial', tz: TZ }, NOW, dependencies);

    expect(data.warnings).toContain('series_limit_exceeded');
  });
});

describe('needs a date', () => {
  it('keeps missing, participant, populated Upcoming and paged Past edges bounded', async () => {
    const participantId = 'act_01J8XKQ2M4N5P6R7S8T9V0W1P1';
    const missingId = 'act_01J8XKQ2M4N5P6R7S8T9V0W1M1';
    const pastId = 'act_01J8XKQ2M4N5P6R7S8T9V0W1S1';
    const upcoming = plan({
      activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1U1',
      status: 'scheduled',
      schedule: { date: '2026-09-02', time: '09:00', timezone: TZ },
    });
    const participantRow = {
      ...indexRow(participantId),
      participantAvatars: 'stale-shape',
    } as unknown as StoredItem;
    const { dependencies, calls } = deps({
      listBucket: vi.fn(async (_u: string, bucket: string, options = {}) => {
        calls.push({ bucket, options: options as Record<string, unknown> });
        if (bucket === 'P') {
          return { items: [indexRow(missingId), participantRow] };
        }
        if (bucket === 'S' && options.ascending === false) {
          return { items: [indexRow(pastId)], nextCursor: 'older-stored-row' };
        }
        return { items: [] };
      }) as unknown as PlansDependencies['listBucket'],
      batchActivities: vi.fn(async (ids: readonly string[]) =>
        ids.flatMap((activityId) => {
          if (activityId === participantId) {
            return [plan({ activityId, ownerId: 'usr_plan_owner' })];
          }
          if (activityId === pastId) {
            return [
              plan({
                activityId,
                status: 'scheduled',
                schedule: { date: '2026-08-31', time: '09:00', timezone: TZ },
              }),
            ];
          }
          return [];
        }),
      ) as PlansDependencies['batchActivities'],
      assemble: vi.fn(async () => ({
        days: [
          {
            date: '2026-09-02',
            schedule: [recurringCandidate(upcoming, '2026-09-02', 'scheduled')],
            anytime: [],
            earlier: [],
          },
        ],
        warnings: [],
        projectionVersions: [],
      })) as unknown as PlansDependencies['assemble'],
    });

    const data = await getPlans(USER, { mode: 'initial', tz: TZ }, NOW, dependencies);

    if (data.mode !== 'initial') throw new Error('expected the initial arm');
    expect(data.needsDate).toEqual([
      expect.objectContaining({ activityId: participantId, participantAvatars: [] }),
    ]);
    expect(data.upcoming[0]).toMatchObject({ date: '2026-09-02' });
    expect(data.past[0]).toMatchObject({ date: '2026-08-31' });
    expect(data.pastPage.nextCursor).toEqual(expect.any(String));
  });

  it('performs no participant or suggestion read', async () => {
    const rows = [indexRow('act_01J8XKQ2M4N5P6R7S8T9V0W1X2')];
    const { dependencies, calls } = deps({
      listBucket: vi.fn(async (_u: string, bucket: string, options = {}) => {
        calls.push({ bucket, options: options as Record<string, unknown> });
        return bucket === 'P' ? { items: rows } : { items: [] };
      }) as unknown as PlansDependencies['listBucket'],
      batchActivities: vi.fn(async () => [
        plan(),
      ]) as PlansDependencies['batchActivities'],
    });

    const data = await getPlans(USER, { mode: 'initial', tz: TZ }, NOW, dependencies);

    if (data.mode !== 'initial') throw new Error('expected the initial arm');
    expect(data.needsDate).toHaveLength(1);
    expect(data.needsDate[0]?.rsvpSummary).toEqual({
      interested: { count: 0, names: [] },
      maybe: { count: 0, names: [] },
      pass: { count: 0, names: [] },
      pending: { count: 0, names: [] },
    });
    expect(data.needsDate[0]?.suggestionCount).toBe(0);
    /**
     * **No fan-out per row**, which is the property rather than a fixed call count: the stage
     * costs one hydration however many rows it holds, and a Query per row here is the shape
     * P6-40 would then have to unpick. Every hydration call carries a *batch*, never a single
     * id drawn from a loop.
     */
    const batched = vi.mocked(dependencies.batchActivities).mock.calls;
    expect(batched).toHaveLength(1);
    expect(batched[0]?.[0]).toEqual(['act_01J8XKQ2M4N5P6R7S8T9V0W1X2']);
  });

  it('drops malformed projected avatars while preserving valid neighbours', async () => {
    const row = {
      ...indexRow('act_01J8XKQ2M4N5P6R7S8T9V0W1X2'),
      participantAvatars: [
        { personId: 'psn_alice', displayName: 'Alice' },
        { personId: 'psn_missing_name' },
        { personId: 'psn_bad_url', displayName: 'Bad URL', avatarUrl: 'not-a-url' },
      ],
    } as StoredItem;
    const { dependencies, calls } = deps({
      listBucket: vi.fn(async (_u: string, bucket: string, options = {}) => {
        calls.push({ bucket, options: options as Record<string, unknown> });
        return bucket === 'P' ? { items: [row] } : { items: [] };
      }) as unknown as PlansDependencies['listBucket'],
      batchActivities: vi.fn(async () => [
        plan(),
      ]) as PlansDependencies['batchActivities'],
    });

    const data = await getPlans(USER, { mode: 'initial', tz: TZ }, NOW, dependencies);

    if (data.mode !== 'initial') throw new Error('expected the initial arm');
    expect(data.needsDate[0]?.participantAvatars).toEqual([
      { personId: 'psn_alice', displayName: 'Alice' },
    ]);
  });

  /** The count must not grow with the number of rows — that is what "no fan-out" means. */
  it('hydrates fifty rows in the same number of reads as one', async () => {
    const ids = Array.from(
      { length: 50 },
      (_v, index) => `act_01J8XKQ2M4N5P6R7S8T9V${String(index).padStart(4, '0')}`,
    );
    const { dependencies, calls } = deps({
      listBucket: vi.fn(async (_u: string, bucket: string, options = {}) => {
        calls.push({ bucket, options: options as Record<string, unknown> });
        return bucket === 'P' ? { items: ids.map(indexRow) } : { items: [] };
      }) as unknown as PlansDependencies['listBucket'],
      batchActivities: vi.fn(async () =>
        ids.map((activityId) => plan({ activityId })),
      ) as PlansDependencies['batchActivities'],
    });

    await getPlans(USER, { mode: 'initial', tz: TZ }, NOW, dependencies);

    expect(vi.mocked(dependencies.batchActivities).mock.calls).toHaveLength(1);
  });

  it('keeps the bucket’s order rather than re-sorting', async () => {
    const ids = [
      'act_01J8XKQ2M4N5P6R7S8T9V0W1X3',
      'act_01J8XKQ2M4N5P6R7S8T9V0W1X1',
      'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
    ];
    const { dependencies, calls } = deps({
      listBucket: vi.fn(async (_u: string, bucket: string, options = {}) => {
        calls.push({ bucket, options: options as Record<string, unknown> });
        return bucket === 'P' ? { items: ids.map(indexRow) } : { items: [] };
      }) as unknown as PlansDependencies['listBucket'],
      batchActivities: vi.fn(async () =>
        // Returned in a different order than requested, as a BatchGetItem may.
        [...ids].reverse().map((activityId) => plan({ activityId })),
      ) as PlansDependencies['batchActivities'],
    });

    const data = await getPlans(USER, { mode: 'initial', tz: TZ }, NOW, dependencies);

    if (data.mode !== 'initial') throw new Error('expected the initial arm');
    expect(data.needsDate.map((row) => row.activityId)).toEqual(ids);
  });

  it.each(['completed', 'cancelled'] as const)('drops a %s plan', async (status) => {
    const { dependencies, calls } = deps({
      listBucket: vi.fn(async (_u: string, bucket: string, options = {}) => {
        calls.push({ bucket, options: options as Record<string, unknown> });
        return bucket === 'P'
          ? { items: [indexRow('act_01J8XKQ2M4N5P6R7S8T9V0W1X2')] }
          : { items: [] };
      }) as unknown as PlansDependencies['listBucket'],
      batchActivities: vi.fn(async () => [
        plan({ status }),
      ]) as PlansDependencies['batchActivities'],
    });

    const data = await getPlans(USER, { mode: 'initial', tz: TZ }, NOW, dependencies);

    if (data.mode !== 'initial') throw new Error('expected the initial arm');
    expect(data.needsDate).toEqual([]);
  });

  /** Read one past the cap, so a full page and an overflowing one are distinguishable. */
  it('warns when the bucket has more than the model cap', async () => {
    const { dependencies, calls } = deps({
      listBucket: vi.fn(async (_u: string, bucket: string, options = {}) => {
        calls.push({ bucket, options: options as Record<string, unknown> });
        return bucket === 'P'
          ? { items: [indexRow('act_01J8XKQ2M4N5P6R7S8T9V0W1X2')], nextCursor: 'more' }
          : { items: [] };
      }) as unknown as PlansDependencies['listBucket'],
      batchActivities: vi.fn(async () => [
        plan(),
      ]) as PlansDependencies['batchActivities'],
    });

    const data = await getPlans(USER, { mode: 'initial', tz: TZ }, NOW, dependencies);

    expect(data.warnings).toContain('needs_date_limit_exceeded');
    expect(calls.find((c) => c.bucket === 'P')?.options.limit).toBe(201);
  });
});

describe('cursors are scoped to the request that issued them', () => {
  it.each([
    ['a foreign payload', Buffer.from('{"nope":true}').toString('base64url')],
    ['unparseable bytes', 'not-base64-json'],
  ])('refuses %s', async (_why, cursor) => {
    const { dependencies } = deps();

    await expect(
      getPlans(USER, { mode: 'past_cursor', tz: TZ, cursor }, NOW, dependencies),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('refuses a past_window cursor replayed against different bounds', async () => {
    const cursor = Buffer.from(
      JSON.stringify({
        mode: 'past_window',
        bounds: { from: '2026-08-01', before: '2026-09-01' },
        key: 'raw',
        userId: USER,
      }),
    ).toString('base64url');
    const { dependencies } = deps();

    await expect(
      getPlans(
        USER,
        {
          mode: 'past_window',
          tz: TZ,
          pastFrom: '2026-07-01',
          pastBefore: '2026-08-01',
          cursor,
        },
        NOW,
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('accepts a legacy past_window cursor for its original bounds without resuming #S', async () => {
    const cursor = Buffer.from(
      JSON.stringify({
        mode: 'past_window',
        bounds: { from: '2026-08-01', before: '2026-09-01' },
        key: 'legacy-row',
        userId: USER,
      }),
    ).toString('base64url');
    const { dependencies, calls } = deps();

    const data = await getPlans(
      USER,
      {
        mode: 'past_window',
        tz: TZ,
        pastFrom: '2026-08-01',
        pastBefore: '2026-09-01',
        cursor,
      },
      NOW,
      dependencies,
    );

    if (data.mode !== 'past_window') throw new Error('expected the past_window arm');
    expect(data.pastCoverage.complete).toBe(true);
    expect(calls).toEqual([]);
    expect(dependencies.assemble).toHaveBeenCalledOnce();
  });

  it('refuses another user’s cursor', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ mode: 'past_cursor', key: 'raw', userId: 'usr_someone_else' }),
    ).toString('base64url');
    const { dependencies } = deps();

    await expect(
      getPlans(USER, { mode: 'past_cursor', tz: TZ, cursor }, NOW, dependencies),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('refuses a past_window cursor on the open continuation', async () => {
    const cursor = Buffer.from(
      JSON.stringify({
        mode: 'past_window',
        bounds: { from: '2026-08-01', before: '2026-09-01' },
        key: 'raw',
        userId: USER,
      }),
    ).toString('base64url');
    const { dependencies } = deps();

    await expect(
      getPlans(USER, { mode: 'past_cursor', tz: TZ, cursor }, NOW, dependencies),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('past coverage is the interval exhausted', () => {
  it('returns completed and uncompleted recurring occurrences in the requested Past window', async () => {
    const series = plan({
      status: 'scheduled',
      schedule: { date: '2026-08-01', time: '09:00', timezone: TZ },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01', time: '09:00' }],
      },
    });
    const { dependencies } = deps({
      assemble: vi.fn(async () => ({
        days: [
          {
            date: '2026-08-30',
            schedule: [recurringCandidate(series, '2026-08-30', 'completed_occurrence')],
            anytime: [],
            earlier: [],
          },
          {
            date: '2026-08-31',
            schedule: [recurringCandidate(series, '2026-08-31', 'scheduled')],
            anytime: [],
            earlier: [],
          },
        ],
        warnings: [],
        projectionVersions: [],
      })) as unknown as PlansDependencies['assemble'],
    });

    const data = await getPlans(
      USER,
      { mode: 'past_window', tz: TZ, pastFrom: '2026-08-01', pastBefore: '2026-09-01' },
      NOW,
      dependencies,
    );

    if (data.mode !== 'past_window') throw new Error('expected the past_window arm');
    expect(data.past).toEqual([
      expect.objectContaining({
        date: '2026-08-31',
        items: [
          expect.objectContaining({
            activityId: series.activityId,
            occurrenceDate: '2026-08-31',
            status: 'scheduled',
          }),
        ],
      }),
      expect.objectContaining({
        date: '2026-08-30',
        items: [
          expect.objectContaining({
            activityId: series.activityId,
            occurrenceDate: '2026-08-30',
            status: 'completed_occurrence',
          }),
        ],
      }),
    ]);
  });

  it('reports the full requested range when the scan drains it', async () => {
    const { dependencies } = deps();

    const data = await getPlans(
      USER,
      { mode: 'past_window', tz: TZ, pastFrom: '2026-08-01', pastBefore: '2026-09-01' },
      NOW,
      dependencies,
    );

    if (data.mode !== 'past_window') throw new Error('expected the past_window arm');
    expect(data.pastCoverage).toMatchObject({
      requestedFrom: '2026-08-01',
      requestedThrough: '2026-08-31',
      coveredFrom: '2026-08-01',
      coveredThrough: '2026-08-31',
      complete: true,
    });
    expect(data.pastCoverage.nextCursor).toBeUndefined();
  });
});
