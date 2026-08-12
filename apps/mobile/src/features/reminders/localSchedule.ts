import { getAgenda, getMe, type HttpClient } from '@od/shared/client';
import { addWallDays, toUtcInstant } from '@od/shared/recurrence';
import type { Clock, Instant, TimeZone, WallDate } from '@od/shared/time';
import { systemClock } from '@od/shared/time';
import type { User } from '@od/shared/types';
import { AppState } from 'react-native';
import { apiClient } from '@/lib/apiClient';
import { localNotificationsSupported, replaceLocalNotifications } from '@/lib/push';
import type { LocalNotificationRequest } from '@/lib/push.types';

const REMINDER_INCLUDE = 'reminders' as const;
const DEFAULT_ALL_DAY_HOUR = 9;
const MINUTE_MS = 60_000;
const TITLE_LIMIT = 40;
const BODY_LIMIT = 110;

type AgendaProjection = Awaited<ReturnType<typeof getAgenda>>;
type AgendaProjectionItem = AgendaProjection['days'][number]['schedule'][number];

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
  onError: () => void;
}

const defaultDependencies: LocalReminderSchedulerDependencies = {
  client: apiClient,
  clock: systemClock,
  appState: AppState,
  supported: localNotificationsSupported,
  replace: replaceLocalNotifications,
  onError: () => console.warn('local_notification_refresh_failed'),
};

/**
 * Computes every local request from the caller-scoped agenda projection.
 *
 * The API already removed every other user's reminders. Filtering by user id here would
 * hide an upstream privacy defect, so this function deliberately has no user-id argument.
 */
export function computeLocalNotifications(
  agenda: AgendaProjection,
  profile: Pick<User, 'timezone' | 'allDayReminderHour'>,
  now: Instant,
  formatTime: (time: string) => string = formatWallTime,
): LocalNotificationRequest[] {
  const requests: LocalNotificationRequest[] = [];
  const identifiers = new Set<string>();

  for (const day of agenda.days) {
    for (const item of itemsForNotification(day)) {
      if (isTerminal(item.status)) continue;

      for (const reminder of item.reminders ?? []) {
        if (item.time === undefined && reminder.offsetMinutes % 1440 !== 0) continue;
        const fireAt = reminderInstant(
          day.date as WallDate,
          item,
          reminder.offsetMinutes,
          profile.timezone as TimeZone,
          profile.allDayReminderHour ?? DEFAULT_ALL_DAY_HOUR,
        );
        if (Date.parse(fireAt) <= Date.parse(now)) continue;

        const identifier = [
          item.activityId,
          reminder.reminderId,
          item.occurrenceDate ?? day.date,
        ].join(':');
        if (identifiers.has(identifier)) continue;
        identifiers.add(identifier);

        requests.push({
          identifier,
          title: truncateAtWord(item.title, TITLE_LIMIT),
          body: truncateAtWord(
            notificationBody(item, reminder.offsetMinutes, formatTime),
            BODY_LIMIT,
          ),
          fireAt,
          route: `/activity/${item.activityId}`,
        });
      }
    }
  }

  return requests;
}

/** One independent eight-day agenda refresh. Today never calls or awaits this function. */
export async function refreshLocalNotifications(
  dependencies: Pick<
    LocalReminderSchedulerDependencies,
    'client' | 'clock' | 'supported' | 'replace'
  > = defaultDependencies,
): Promise<void> {
  if (!dependencies.supported) return;

  const profile = await getMe(dependencies.client);
  const today = dependencies.clock.todayIn(profile.timezone as TimeZone);
  const agenda = await getAgenda(dependencies.client, {
    from: today,
    to: addWallDays(today, 7),
    tz: profile.timezone,
    include: REMINDER_INCLUDE,
  });

  await dependencies.replace(
    computeLocalNotifications(agenda, profile, dependencies.clock.now()),
  );
}

/** Installs the scheduler's startup and enter-background cadence at the app root. */
export function installLocalReminderScheduler(
  overrides: Partial<LocalReminderSchedulerDependencies> = {},
): () => void {
  const dependencies = { ...defaultDependencies, ...overrides };
  let stopped = false;
  let pending = Promise.resolve();

  const tick = () => {
    pending = pending
      .then(async () => {
        if (!stopped) await refreshLocalNotifications(dependencies);
      })
      .catch(() => dependencies.onError());
  };

  tick();
  const subscription = dependencies.appState.addEventListener('change', (state) => {
    if (state === 'background') tick();
  });

  return () => {
    stopped = true;
    subscription.remove();
  };
}

function itemsForNotification(
  day: AgendaProjection['days'][number],
): AgendaProjectionItem[] {
  const items = [
    ...(day.upNext === undefined ? [] : [day.upNext]),
    ...day.schedule,
    ...day.anytime,
    ...day.earlier,
  ];
  const unique = new Map<string, AgendaProjectionItem>();
  for (const item of items) {
    const key = `${item.activityId}:${item.occurrenceDate ?? day.date}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

function isTerminal(status: AgendaProjectionItem['status']): boolean {
  return (
    status === 'completed' ||
    status === 'completed_occurrence' ||
    status === 'skipped' ||
    status === 'skipped_occurrence' ||
    status === 'cancelled'
  );
}

function reminderInstant(
  date: WallDate,
  item: AgendaProjectionItem,
  offsetMinutes: number,
  timezone: TimeZone,
  allDayHour: number,
): Instant {
  if (item.time !== undefined) {
    const activityInstant = toUtcInstant(date, item.time, timezone);
    return new Date(
      Date.parse(activityInstant) + offsetMinutes * MINUTE_MS,
    ).toISOString() as Instant;
  }

  const fireDate = addWallDays(date, offsetMinutes / 1440);
  const fireTime = `${String(allDayHour).padStart(2, '0')}:00`;
  return toUtcInstant(fireDate, fireTime, timezone) as Instant;
}

function notificationBody(
  item: AgendaProjectionItem,
  offsetMinutes: number,
  formatTime: (time: string) => string,
): string {
  if (item.time === undefined) return allDayBody(offsetMinutes);
  return `${relativeLead(offsetMinutes)} · ${formatTime(item.time)}`;
}

function relativeLead(offsetMinutes: number): string {
  const minutes = Math.abs(offsetMinutes);
  if (minutes === 0) return 'Now';
  if (minutes % 1440 === 0) return `In ${quantity(minutes / 1440, 'day')}`;
  if (minutes % 60 === 0) return `In ${quantity(minutes / 60, 'hour')}`;
  return `In ${quantity(minutes, 'minute')}`;
}

function allDayBody(offsetMinutes: number): string {
  const days = Math.abs(offsetMinutes / 1440);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${quantity(days, 'day')}`;
}

function quantity(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

function formatWallTime(time: string): string {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2000, 0, 1, hour, minute)));
}

function truncateAtWord(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const available = value.slice(0, limit - 1);
  const boundary = available.lastIndexOf(' ');
  return `${available.slice(0, boundary > 0 ? boundary : available.length).trimEnd()}…`;
}
