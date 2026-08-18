import type { Instant, WallDate } from '@od/shared/time';
import { describe, expect, it, vi } from 'vitest';
import type { Intent } from '@/lib/intentLog';
import { armingVerified, MAX_ARMED_LOCAL_NOTIFICATIONS, planArming } from './arming';
import { DirtySchedule, type DirtyScheduleDependencies } from './dirtySchedule';
import {
  buildProjection,
  fromPendingIntents,
  fromServerAgenda,
  type ServerReminderSource,
} from './projection';

const ACTIVITY = 'act_01J0000000000000000000000A';
const REMINDER = 'rem_01J0000000000000000000000B';
const WINDOW = { from: '2026-08-17' as WallDate, to: '2026-08-24' as WallDate };
const PROFILE = { timezone: 'UTC', allDayReminderHour: 9 };

function serverItem(patch: Partial<ServerReminderSource> = {}): ServerReminderSource {
  return {
    activityId: ACTIVITY,
    title: 'Gym',
    date: '2026-08-17' as WallDate,
    time: '18:00',
    status: 'scheduled',
    occurrenceDate: undefined,
    reminders: [{ reminderId: REMINDER, offsetMinutes: -15 }],
    ...patch,
  };
}

function pendingIntent(input: Record<string, unknown>, entityId = ACTIVITY): Intent {
  return {
    intentId: `intent-${entityId}`,
    ownerUserId: 'usr_01J0000000000000000000000Z',
    mutationKey: ['activity', 'create'],
    variables: { input },
    entityId,
    status: 'queued',
    createdAt: Date.now(),
    seq: 1,
    attempts: 0,
  };
}

describe('the hybrid rule', () => {
  it('takes server-known reminders verbatim, never re-expanding a series', () => {
    /**
     * The server sends the two occurrences it decided on. A daily series over an eight-day
     * window would expand to eight — and expanding it here is exactly the defect: the server
     * omitted the others because the user skipped or completed them, and the device cannot
     * see the `OCC#` overrides that say so.
     */
    const projected = fromServerAgenda([
      serverItem({ date: '2026-08-17' as WallDate, occurrenceDate: '2026-08-17' }),
      serverItem({ date: '2026-08-19' as WallDate, occurrenceDate: '2026-08-19' }),
    ]);

    expect(projected).toHaveLength(2);
    expect(projected.map((entry) => entry.date)).toEqual(['2026-08-17', '2026-08-19']);
    expect(projected.every((entry) => entry.source === 'server')).toBe(true);
  });

  it('drops a skipped occurrence rather than arming it', () => {
    expect(fromServerAgenda([serverItem({ status: 'skipped_occurrence' })])).toEqual([]);
    expect(fromServerAgenda([serverItem({ status: 'completed' })])).toEqual([]);
  });

  it('expands a pending recurring create locally, which is safe because no override can exist', () => {
    const projected = fromPendingIntents(
      [
        pendingIntent({
          title: 'Stretch',
          schedule: { date: '2026-08-17', time: '07:00', timezone: 'UTC' },
          recurrence: {
            mode: 'fixed',
            segments: [{ freq: 'daily', effectiveFrom: '2026-08-17' }],
          },
          reminders: [{ reminderId: REMINDER, offsetMinutes: -10 }],
        }),
      ],
      WINDOW,
    );

    // Eight days in the window, every one of them armable: the server has never seen this.
    expect(projected).toHaveLength(8);
    expect(projected.every((entry) => entry.source === 'pending')).toBe(true);
  });

  it('ignores a pending reminder with no client id, which could not be re-keyed', () => {
    const projected = fromPendingIntents(
      [
        pendingIntent({
          title: 'No id',
          schedule: { date: '2026-08-17', time: '07:00', timezone: 'UTC' },
          reminders: [{ offsetMinutes: -10 }],
        }),
      ],
      WINDOW,
    );

    expect(projected).toEqual([]);
  });

  it('re-keys nothing when an intent is acknowledged, because the id was the client’s', () => {
    /**
     * The acknowledgement case, and the whole reason for the client-minted `rem_`. Before the
     * 201 the reminder comes from the log; after it, from the server. Same activity, same
     * date, same reminder id — therefore the same key, so the armed set is identical and
     * nothing is orphaned or doubled.
     */
    const pending = fromPendingIntents(
      [
        pendingIntent({
          title: 'Gym',
          schedule: { date: '2026-08-17', time: '18:00', timezone: 'UTC' },
          reminders: [{ reminderId: REMINDER, offsetMinutes: -15 }],
        }),
      ],
      WINDOW,
    );
    const acknowledged = fromServerAgenda([serverItem()]);

    expect(pending[0]?.key).toBe(acknowledged[0]?.key);

    const merged = buildProjection([serverItem()], [], WINDOW);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe('server');
  });

  it('prefers the server row while both exist, without duplicating', () => {
    const merged = buildProjection(
      [serverItem()],
      [
        pendingIntent({
          title: 'Gym',
          schedule: { date: '2026-08-17', time: '18:00', timezone: 'UTC' },
          reminders: [{ reminderId: REMINDER, offsetMinutes: -15 }],
        }),
      ],
      WINDOW,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe('server');
  });
});

describe('arming', () => {
  const NOW = '2026-08-17T00:00:00.000Z' as Instant;

  it('arms nearest-first and caps with headroom below the iOS limit', () => {
    // 90 reminders across the window, comfortably past iOS's 64.
    const projection = Array.from({ length: 90 }, (_, index) => ({
      key: `k${index}`,
      activityId: ACTIVITY,
      reminderId: `rem${index}`,
      title: `Reminder ${index}`,
      date: '2026-08-17' as WallDate,
      time: '12:00',
      // Increasingly far out, so nearest-first has something to prefer.
      offsetMinutes: -(index + 1),
      source: 'pending' as const,
    }));

    const plan = planArming(projection, PROFILE, NOW);

    expect(plan.requests).toHaveLength(MAX_ARMED_LOCAL_NOTIFICATIONS);
    expect(plan.dropped).toBe(90 - MAX_ARMED_LOCAL_NOTIFICATIONS);
    // Nearest-first: the reminder furthest in the future is the one that goes.
    const fireTimes = plan.requests.map((request) => Date.parse(request.fireAt));
    expect([...fireTimes].sort((a, b) => a - b)).toEqual(fireTimes);
  });

  it('reports the last armed fire time as the honest horizon', () => {
    const plan = planArming(
      [
        {
          key: 'a',
          activityId: ACTIVITY,
          reminderId: REMINDER,
          title: 'Gym',
          date: '2026-08-18' as WallDate,
          time: '18:00',
          offsetMinutes: -15,
          source: 'server',
        },
      ],
      PROFILE,
      NOW,
    );

    expect(plan.scheduledThrough).toBe('2026-08-18T17:45:00.000Z');
  });

  it('never arms a reminder whose moment has already passed', () => {
    const plan = planArming(
      [
        {
          key: 'past',
          activityId: ACTIVITY,
          reminderId: REMINDER,
          title: 'Gone',
          date: '2026-08-16' as WallDate,
          time: '09:00',
          offsetMinutes: 0,
          source: 'server',
        },
      ],
      PROFILE,
      NOW,
    );

    expect(plan.requests).toEqual([]);
    expect(plan.scheduledThrough).toBeUndefined();
  });

  it('delivers a reminder for an activity inside quiet hours, and holds an early one', () => {
    const quietHours = { enabled: true, start: '22:00', end: '07:00' };

    // A 06:00 flight: fires at 05:45, inside the window, and must not be held.
    const flight = planArming(
      [
        {
          key: 'flight',
          activityId: ACTIVITY,
          reminderId: REMINDER,
          title: 'Flight',
          date: '2026-08-18' as WallDate,
          time: '06:00',
          offsetMinutes: -15,
          source: 'server',
        },
      ],
      { ...PROFILE, quietHours },
      NOW,
    );
    expect(flight.requests[0]?.fireAt).toBe('2026-08-18T05:45:00.000Z');

    // A 14:00 meeting reminded eight hours early lands at 06:00 and is held to 07:00.
    const meeting = planArming(
      [
        {
          key: 'meeting',
          activityId: ACTIVITY,
          reminderId: REMINDER,
          title: 'Meeting',
          date: '2026-08-18' as WallDate,
          time: '14:00',
          offsetMinutes: -480,
          source: 'server',
        },
      ],
      { ...PROFILE, quietHours },
      NOW,
    );
    expect(meeting.requests[0]?.fireAt).toBe('2026-08-18T07:00:00.000Z');
  });
});

describe('the dirty schedule', () => {
  function deps(
    overrides: Partial<DirtyScheduleDependencies> = {},
  ): DirtyScheduleDependencies {
    const requests = [
      {
        identifier: 'a',
        title: 'A',
        body: 'b',
        fireAt: '2026-08-18T09:00:00.000Z',
        route: '/',
      },
    ];
    return {
      plan: vi.fn(async () => ({
        requests,
        scheduledThrough: '2026-08-18T09:00:00.000Z' as Instant,
      })),
      replace: vi.fn(async () => undefined),
      readScheduled: vi.fn(async () => ['a']),
      ...overrides,
    };
  }

  it('recomputes when dirty and marks clean only after verification', async () => {
    const dependencies = deps();
    const schedule = new DirtySchedule(dependencies);

    const result = await schedule.run();

    expect(result).toMatchObject({ armed: 1, verified: true });
    expect(schedule.snapshot().dirty).toBe(false);
    expect(schedule.snapshot().scheduledThrough).toBe('2026-08-18T09:00:00.000Z');
  });

  it('does nothing when clean, so a burst of triggers is one arming pass', async () => {
    const dependencies = deps();
    const schedule = new DirtySchedule(dependencies);
    await schedule.run();

    expect(await schedule.run()).toBeUndefined();
    expect(dependencies.plan).toHaveBeenCalledTimes(1);
  });

  it('stays dirty when the OS held less than was asked for', async () => {
    // Partial arming: two intended, one actually held. All-or-nothing, so this is not clean.
    const dependencies = deps({
      plan: vi.fn(async () => ({
        requests: [
          {
            identifier: 'a',
            title: 'A',
            body: 'b',
            fireAt: '2026-08-18T09:00:00.000Z',
            route: '/',
          },
          {
            identifier: 'b',
            title: 'B',
            body: 'b',
            fireAt: '2026-08-18T10:00:00.000Z',
            route: '/',
          },
        ],
        scheduledThrough: '2026-08-18T10:00:00.000Z' as Instant,
      })),
    });
    const schedule = new DirtySchedule(dependencies);

    const result = await schedule.run();

    expect(result?.verified).toBe(false);
    expect(schedule.snapshot().dirty).toBe(true);
    // No horizon is claimed for a set that could not be proven.
    expect(schedule.snapshot().scheduledThrough).toBeUndefined();
  });

  it('cancels nothing and stays dirty when a recompute fails', async () => {
    const onError = vi.fn();
    const dependencies = deps({
      plan: vi.fn(async () => {
        throw new Error('offline');
      }),
      onError,
    });
    const schedule = new DirtySchedule(dependencies);

    expect(await schedule.run()).toBeUndefined();
    expect(dependencies.replace).not.toHaveBeenCalled();
    expect(schedule.snapshot().dirty).toBe(true);
    expect(onError).toHaveBeenCalled();
  });

  it('recomputes again after any reminder-relevant change, including acknowledgement', async () => {
    const dependencies = deps();
    const schedule = new DirtySchedule(dependencies);
    await schedule.run();
    expect(schedule.snapshot().dirty).toBe(false);

    /**
     * The trigger the two old moments missed entirely. An intent acknowledged mid-session
     * changes which source a reminder comes from, and used to change nothing about what was
     * armed until the user happened to background the app.
     */
    schedule.mark('intent-acknowledged');
    expect(schedule.snapshot().dirty).toBe(true);

    await schedule.run();
    expect(dependencies.plan).toHaveBeenCalledTimes(2);
  });
});

describe('armingVerified', () => {
  it('is true only for an exact identifier match', () => {
    const requests = [
      {
        identifier: 'a',
        title: 'A',
        body: 'b',
        fireAt: '2026-08-18T09:00:00.000Z',
        route: '/',
      },
    ];
    expect(armingVerified(requests, ['a'])).toBe(true);
    expect(armingVerified(requests, [])).toBe(false);
    expect(armingVerified(requests, ['b'])).toBe(false);
    expect(armingVerified(requests, ['a', 'b'])).toBe(false);
  });
});
