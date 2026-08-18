import { fixedClock, type Instant, type WallDate } from '@od/shared/time';
import { describe, expect, it, vi } from 'vitest';
import type { LocalNotificationRequest } from '@/lib/push.types';
import { planArming } from './arming';
import {
  installLocalReminderScheduler,
  type LocalReminderSchedulerDependencies,
  refreshReminderProjection,
} from './localSchedule';
import { fromServerAgenda, type ServerReminderSource } from './projection';
import type { StoredProjection } from './projectionStore';

const ACTIVITY_ID = 'act_01J8SEED000000000000000001';
const REMINDER_ID = 'rem_01J8SEED000000000000000001';
const NOW = '2026-08-06T12:00:00.000Z' as Instant;

const source = (patch: Partial<ServerReminderSource> = {}): ServerReminderSource => ({
  activityId: ACTIVITY_ID,
  title: 'Gym',
  date: '2026-08-13' as WallDate,
  time: '18:00',
  status: 'scheduled',
  occurrenceDate: undefined,
  reminders: [{ reminderId: REMINDER_ID, offsetMinutes: -15 }],
  ...patch,
});

/**
 * The three computation cases below came from `computeLocalNotifications`, which P2-57
 * deleted along with the rest of the per-recompute network path. The behaviour they pin —
 * zone-aware timed offsets, whole-day all-day offsets at the profile hour, and dropping past
 * or terminal requests — is unchanged and now lives in `fromServerAgenda` + `planArming`, so
 * the assertions moved rather than the coverage going away.
 */
describe('computing reminder fire times', () => {
  it('subtracts a timed offset from the viewer-zone occurrence instant', () => {
    const plan = planArming(
      fromServerAgenda([source()]),
      { timezone: 'America/New_York' },
      NOW,
    );

    expect(plan.requests).toEqual([
      {
        identifier: `${ACTIVITY_ID}:2026-08-13:${REMINDER_ID}`,
        title: 'Gym',
        body: expect.stringContaining('In 15 minutes'),
        fireAt: '2026-08-13T21:45:00.000Z',
        route: `/activity/${ACTIVITY_ID}`,
      },
    ]);
  });

  it('applies an untimed offset in whole calendar days at the profile all-day hour', () => {
    const plan = planArming(
      fromServerAgenda([
        source({
          time: undefined,
          title: 'Submit insurance form',
          reminders: [{ reminderId: REMINDER_ID, offsetMinutes: -1440 }],
        }),
      ]),
      { timezone: 'America/New_York', allDayReminderHour: 7 },
      NOW,
    );

    expect(plan.requests[0]).toMatchObject({
      body: 'Tomorrow',
      fireAt: '2026-08-12T11:00:00.000Z',
    });
  });

  it('defaults untimed reminders to 09:00 local and drops past or terminal requests', () => {
    const plan = planArming(
      fromServerAgenda([
        // Past: 2026-08-06 18:00 New York is already gone at the clock below.
        source({ date: '2026-08-06' as WallDate }),
        source({
          date: '2026-08-07' as WallDate,
          time: undefined,
          reminders: [{ reminderId: REMINDER_ID, offsetMinutes: 0 }],
        }),
        source({ date: '2026-08-07' as WallDate, status: 'completed' }),
      ]),
      { timezone: 'America/New_York' },
      '2026-08-06T23:00:00.000Z' as Instant,
    );

    expect(plan.requests).toHaveLength(1);
    expect(plan.requests[0]).toMatchObject({
      body: 'Today',
      fireAt: '2026-08-07T13:00:00.000Z',
    });
  });
});

interface Harness {
  dependencies: LocalReminderSchedulerDependencies;
  urls: string[];
  replaced: LocalNotificationRequest[][];
  listeners: ((state: string) => void)[];
  saved: StoredProjection[];
}

function harness(overrides: Partial<LocalReminderSchedulerDependencies> = {}): Harness {
  const urls: string[] = [];
  const replaced: LocalNotificationRequest[][] = [];
  const listeners: ((state: string) => void)[] = [];
  const saved: StoredProjection[] = [];

  const fetchStub = vi.fn(async (url: string) => {
    urls.push(url);
    const body = url.includes('/v1/me')
      ? { data: { timezone: 'America/New_York', allDayReminderHour: 9 } }
      : {
          data: {
            days: [
              {
                date: '2026-08-13',
                schedule: [
                  {
                    activityId: ACTIVITY_ID,
                    type: 'task',
                    title: 'Gym',
                    status: 'scheduled',
                    time: '18:00',
                    isRecurring: false,
                    isSnoozed: false,
                    hasCheckbox: true,
                    capabilities: { complete: true, skip: false, snooze: true },
                    participantAvatars: [],
                    participantCount: 0,
                    isPast: false,
                    reminders: [{ reminderId: REMINDER_ID, offsetMinutes: -15 }],
                  },
                ],
                anytime: [],
                earlier: [],
              },
            ],
            warnings: [],
          },
        };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });

  return {
    urls,
    replaced,
    listeners,
    saved,
    dependencies: {
      client: { request: undefined } as never,
      clock: fixedClock(NOW),
      appState: {
        addEventListener: (_event, listener) => {
          listeners.push(listener);
          return { remove: () => undefined };
        },
      },
      supported: true,
      replace: async (requests) => {
        replaced.push([...requests]);
      },
      readScheduled: async () =>
        (replaced.at(-1) ?? []).map((request) => request.identifier),
      load: async () => undefined,
      save: async (projection) => {
        saved.push(projection);
      },
      isOnline: () => true,
      onError: () => undefined,
      ...overrides,
      // Kept last so an override cannot accidentally drop the stubbed transport.
      ...(overrides.client === undefined
        ? {
            client: {
              request: async (options: { path: string }) => {
                const response = await fetchStub(options.path);
                return (await response.json()) as never;
              },
            } as never,
          }
        : {}),
    },
  };
}

describe('the reminder projection refresh', () => {
  it('makes one eight-day reminder agenda request and no per-activity reminder request', async () => {
    const { dependencies, urls, saved } = harness();

    await refreshReminderProjection(dependencies);

    const agendaCalls = urls.filter((url) => url.includes('/v1/agenda'));
    expect(agendaCalls).toHaveLength(1);
    expect(agendaCalls[0]).toContain('include=reminders');
    expect(agendaCalls[0]).toContain('from=2026-08-06');
    expect(agendaCalls[0]).toContain('to=2026-08-13');
    // The per-Activity reminder endpoint is never touched; the agenda already carries them.
    expect(urls.some((url) => url.includes('/reminders'))).toBe(false);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.items).toHaveLength(1);
  });

  it('does no network work at all while offline, and does not fail', async () => {
    /**
     * The case the old implementation could not survive: with no connectivity it threw, and
     * nothing was armed. Now there is simply nothing new to learn, and arming proceeds from
     * what is already stored.
     */
    const { dependencies, urls } = harness({ isOnline: () => false });

    await expect(refreshReminderProjection(dependencies)).resolves.toBeUndefined();
    expect(urls).toEqual([]);
  });
});

describe('the scheduler installation', () => {
  /** The refresh-then-arm chain is several awaits deep, so settle on the effect. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('arms on startup and again on each transition into the background', async () => {
    const { dependencies, listeners, replaced } = harness();

    const stop = installLocalReminderScheduler(dependencies);
    await vi.waitFor(() => expect(replaced).toHaveLength(1));

    for (const listener of listeners) listener('background');
    await vi.waitFor(() => expect(replaced).toHaveLength(2));

    // A foreground transition is not a reminder-relevant change and arms nothing.
    for (const listener of listeners) listener('active');
    await settle();
    expect(replaced).toHaveLength(2);

    stop();
  });

  it('coalesces refreshes, so connectivity flapping does not re-read the agenda', async () => {
    /**
     * The regression this replaced: a local dev build probes reachability every second, so an
     * ordinary LAN hiccup produced a burst of online transitions — and each one cost a full
     * `getMe` plus eight-day agenda read that competed with the screen the user had just
     * opened. Arming still runs every time; only the network read is coalesced.
     */
    const { dependencies, urls, replaced, listeners } = harness();

    const stop = installLocalReminderScheduler(dependencies);
    await vi.waitFor(() => expect(replaced).toHaveLength(1));
    const afterStartup = urls.length;

    for (let index = 0; index < 5; index += 1) listeners[0]?.('background');
    await vi.waitFor(() => expect(replaced.length).toBeGreaterThan(1));

    // Armed again from the store, but the clock has not moved, so nothing was re-read.
    expect(urls).toHaveLength(afterStartup);
    stop();
  });

  it('does no network or device work on web', async () => {
    const { dependencies, urls, replaced } = harness({ supported: false });

    const stop = installLocalReminderScheduler(dependencies);
    await settle();

    expect(urls).toEqual([]);
    expect(replaced).toEqual([]);
    stop();
  });

  it('arms from the stored projection when the refresh fails, cancelling nothing', async () => {
    const onError = vi.fn();
    const stored: StoredProjection = {
      profile: { timezone: 'America/New_York' },
      items: [source()],
      from: '2026-08-06' as WallDate,
      to: '2026-08-13' as WallDate,
      updatedAt: NOW,
    };
    const { dependencies, replaced } = harness({
      load: async () => stored,
      onError,
      client: {
        request: async () => {
          throw new Error('offline');
        },
      } as never,
    });

    const stop = installLocalReminderScheduler(dependencies);
    await vi.waitFor(() => expect(replaced).toHaveLength(1));

    /**
     * The refresh threw and was reported, but arming still happened from what was already on
     * disk — a failed refresh must never leave the user with no reminders.
     */
    expect(onError).toHaveBeenCalled();
    expect(replaced[0]).toHaveLength(1);
    stop();
  });
});
