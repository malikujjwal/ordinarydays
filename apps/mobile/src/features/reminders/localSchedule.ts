import { getAgenda, getMe, type HttpClient } from '@od/shared/client';
import { addWallDays } from '@od/shared/recurrence';
import type { Clock, TimeZone, WallDate } from '@od/shared/time';
import { systemClock } from '@od/shared/time';
import { onlineManager } from '@tanstack/react-query';
import { AppState } from 'react-native';
import { apiClient } from '@/lib/apiClient';
import type { Intent } from '@/lib/intent';
import {
  localNotificationsSupported,
  readScheduledLocalNotifications,
  replaceLocalNotifications,
} from '@/lib/push';
import type { LocalNotificationRequest } from '@/lib/push.types';
import { planArming } from './arming';
import { type DirtyReason, DirtySchedule } from './dirtySchedule';
import { buildProjection, type ServerReminderSource } from './projection';
import { loadProjection, type StoredProjection, saveProjection } from './projectionStore';

/**
 * Local reminder scheduling (P2-57).
 *
 * ## What changed
 *
 * This used to read `getMe` and `getAgenda` on **every** recompute, and recompute on exactly
 * two events: app start and entering the background. Both halves were wrong for the case the
 * feature exists to serve. A device with no connectivity could not recompute at all, and a
 * reminder added at 9 AM was armed correctly only if the user happened to background the app
 * before it was due.
 *
 * Now the network and the arming are separate concerns:
 *
 * - **`refreshReminderProjection`** is the only thing that touches the network. When online it
 *   stores the server's answer and marks the schedule dirty. When offline it does nothing, and
 *   nothing breaks.
 * - **Arming** reads the stored web projection and never the network. Native resolves the
 *   SQLite-backed platform adapter, including pending local creates.
 *   It runs whenever the schedule is dirty, which is after any reminder-relevant change.
 */

const REMINDER_INCLUDE = 'reminders' as const;
const PROJECTION_DAYS = 7;
/**
 * The shortest gap between two network refreshes (fixed 2026-08-18).
 *
 * Reconnecting triggers a refresh, and on a local dev build `onlineManager` is driven by a
 * one-second health probe that flaps on ordinary LAN jitter. Each flap was costing a `getMe`
 * plus an eight-day `include=reminders` agenda read, which competed with whatever the user
 * had actually asked for — a detail screen opening while the reminder refresh held the
 * connection. Reminder data does not change on a one-second timescale, so coalescing costs
 * nothing: arming still runs on every trigger, from the store.
 */
const MIN_REFRESH_INTERVAL_MS = 60_000;

type AppStateListener = (state: string) => void;

interface SchedulerAppState {
  addEventListener(event: 'change', listener: AppStateListener): { remove(): void };
}

export interface LocalReminderSchedulerDependencies {
  client: HttpClient;
  clock: Clock;
  appState: SchedulerAppState;
  supported: boolean;
  replace: (requests: readonly LocalNotificationRequest[]) => Promise<void>;
  readScheduled: () => Promise<string[]>;
  load: typeof loadProjection;
  save: typeof saveProjection;
  isOnline: () => boolean;
  onError: (error?: unknown) => void;
}

const defaultDependencies: LocalReminderSchedulerDependencies = {
  client: apiClient,
  clock: systemClock,
  appState: AppState,
  supported: localNotificationsSupported,
  replace: replaceLocalNotifications,
  readScheduled: readScheduledLocalNotifications,
  load: loadProjection,
  save: saveProjection,
  isOnline: () => onlineManager.isOnline(),
  onError: () => console.warn('local_notification_refresh_failed'),
};

/**
 * Collapses one `include=reminders` agenda response to the fields arming needs.
 *
 * The narrowing is the point: persisting whole `AgendaItem`s would make this a second copy of
 * the agenda cache, which ADR-055's scope guard forbids.
 */
function toSources(
  agenda: Awaited<ReturnType<typeof getAgenda>>,
): ServerReminderSource[] {
  const sources: ServerReminderSource[] = [];
  const seen = new Set<string>();

  for (const day of agenda.days) {
    const items = [
      ...(day.upNext === undefined ? [] : [day.upNext]),
      ...day.schedule,
      ...day.anytime,
      ...day.earlier,
    ];
    for (const item of items) {
      const key = `${item.activityId}:${item.occurrenceDate ?? day.date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const reminders = (item.reminders ?? []).map((reminder) => ({
        reminderId: reminder.reminderId,
        offsetMinutes: reminder.offsetMinutes,
      }));
      if (reminders.length === 0) continue;
      sources.push({
        activityId: item.activityId,
        title: item.title,
        date: day.date as WallDate,
        time: item.time,
        status: item.status,
        occurrenceDate: item.occurrenceDate,
        reminders,
      });
    }
  }
  return sources;
}

/**
 * The one network read, and the only thing that fills the store.
 *
 * Offline is not a failure here: there is simply nothing new to learn, and the stored web
 * projection remains available for arming. Native resolves its SQLite-backed adapter.
 */
export async function refreshReminderProjection(
  dependencies: LocalReminderSchedulerDependencies = defaultDependencies,
): Promise<StoredProjection | undefined> {
  if (!dependencies.supported || !dependencies.isOnline()) return undefined;

  const profile = await getMe(dependencies.client);
  const today = dependencies.clock.todayIn(profile.timezone as TimeZone);
  const to = addWallDays(today, PROJECTION_DAYS);
  const agenda = await getAgenda(dependencies.client, {
    from: today,
    to,
    tz: profile.timezone,
    include: REMINDER_INCLUDE,
  });

  const stored: StoredProjection = {
    profile: {
      timezone: profile.timezone,
      ...(profile.allDayReminderHour === undefined
        ? {}
        : { allDayReminderHour: profile.allDayReminderHour }),
      ...(profile.quietHours === undefined ? {} : { quietHours: profile.quietHours }),
    },
    items: toSources(agenda),
    from: today as WallDate,
    to: to as WallDate,
    updatedAt: dependencies.clock.now(),
  };
  await dependencies.save(stored);
  return stored;
}

/**
 * Builds the armable set from stored data alone — no network, by construction.
 *
 * Web has no durable mutation queue, so only the persisted server projection participates.
 * Native resolves `localSchedule.native.ts`, which reads committed SQLite rows and outbox
 * creates instead.
 */
async function planFromStore(dependencies: LocalReminderSchedulerDependencies): Promise<{
  requests: LocalNotificationRequest[];
  scheduledThrough: ReturnType<typeof planArming>['scheduledThrough'];
}> {
  const stored = await dependencies.load();
  const pending: readonly Intent[] = [];

  /** With no stored web projection, retain a deterministic empty planning window. */
  const timezone = stored?.profile.timezone ?? 'UTC';
  const today = dependencies.clock.todayIn(timezone as TimeZone) as WallDate;
  const window = {
    from: stored?.from ?? today,
    to: stored?.to ?? (addWallDays(today, PROJECTION_DAYS) as WallDate),
  };

  const projection = buildProjection(stored?.items ?? [], pending, window);
  const plan = planArming(
    projection,
    stored?.profile ?? { timezone },
    dependencies.clock.now(),
  );
  return { requests: plan.requests, scheduledThrough: plan.scheduledThrough };
}

/**
 * Installs the scheduler.
 *
 * The two old moments — startup and entering the background — are now two of several reasons
 * to mark dirty rather than the only two times anything happens. Reconnecting refreshes the
 * server-backed web projection; native outbox changes are handled by the native adapter.
 */
export function installLocalReminderScheduler(
  overrides: Partial<LocalReminderSchedulerDependencies> = {},
): () => void {
  const dependencies = { ...defaultDependencies, ...overrides };
  let stopped = false;
  let lastRefreshAt = 0;

  const schedule = new DirtySchedule({
    plan: () => planFromStore(dependencies),
    replace: dependencies.replace,
    readScheduled: dependencies.readScheduled,
    onError: dependencies.onError,
  });

  let pending = Promise.resolve();
  const tick = (reason: DirtyReason, refresh: boolean) => {
    schedule.mark(reason);
    pending = pending
      .then(async () => {
        if (stopped || !dependencies.supported) return;
        /**
         * The refresh is best-effort and deliberately does not gate arming: an offline device
         * still arms from what it already has. A network failure marks nothing clean and
         * cancels nothing.
         */
        const elapsed = Date.parse(dependencies.clock.now()) - lastRefreshAt;
        if (refresh && elapsed >= MIN_REFRESH_INTERVAL_MS) {
          try {
            const refreshed = await refreshReminderProjection(dependencies);
            // Only a real read counts; an offline no-op must not start the cooldown.
            if (refreshed !== undefined) {
              lastRefreshAt = Date.parse(dependencies.clock.now());
            }
          } catch (error) {
            dependencies.onError(error);
          }
        }
        await schedule.run();
      })
      .catch((error: unknown) => dependencies.onError(error));
  };

  tick('startup', true);

  const subscription = dependencies.appState.addEventListener('change', (state) => {
    if (state === 'background') tick('background', true);
  });
  /** Reconnecting is when the server may have something the device could not know. */
  const stopOnline = onlineManager.subscribe((online) => {
    if (online) tick('activity-changed', true);
  });
  return () => {
    stopped = true;
    subscription.remove();
    stopOnline();
  };
}
