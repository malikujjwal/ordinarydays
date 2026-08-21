import { addWallDays } from '@od/shared/recurrence';
import type { TimeZone, WallDate } from '@od/shared/time';
import { systemClock } from '@od/shared/time';
import type { QuietHours } from '@od/shared/types';
import { onlineManager } from '@tanstack/react-query';
import { AppState } from 'react-native';
import type { Intent } from '@/lib/intent';
import {
  localNotificationsSupported,
  readScheduledLocalNotifications,
  replaceLocalNotifications,
} from '@/lib/push';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import { planArming } from './arming';
import { type DirtyReason, DirtySchedule } from './dirtySchedule';
import { buildProjection, type ServerReminderSource } from './projection';

const PROJECTION_DAYS = 7;
const MIN_REFRESH_INTERVAL_MS = 60_000;

function text(row: Record<string, unknown>, key: string): string | undefined {
  return typeof row[key] === 'string' ? (row[key] as string) : undefined;
}

function number(row: Record<string, unknown>, key: string): number | undefined {
  return typeof row[key] === 'number' ? (row[key] as number) : undefined;
}

async function profile(): Promise<{
  timezone: string;
  allDayReminderHour?: number;
  quietHours?: QuietHours;
}> {
  const state = requireActiveNativeState();
  const row = await state.account.database.first(
    'SELECT timezone, all_day_reminder_hour, quiet_hours_json FROM native_reminder_profile WHERE singleton = 1;',
  );
  if (row === undefined) return { timezone: 'UTC' };
  const quiet = text(row, 'quiet_hours_json');
  const allDayReminderHour = number(row, 'all_day_reminder_hour');
  return {
    timezone: text(row, 'timezone') ?? 'UTC',
    ...(allDayReminderHour === undefined ? {} : { allDayReminderHour }),
    ...(quiet === undefined ? {} : { quietHours: JSON.parse(quiet) as QuietHours }),
  };
}

async function serverSources(from: string, to: string): Promise<ServerReminderSource[]> {
  const state = requireActiveNativeState();
  const rows = await state.account.database.all(
    `SELECT a.activity_id, a.viewer_date, a.occurrence_date, a.title, a.time, a.status,
            r.reminder_id, r.offset_minutes
     FROM agenda_rows a
     JOIN activity_reminders r ON r.activity_id = a.activity_id
     WHERE a.viewer_date BETWEEN ? AND ?
     ORDER BY a.viewer_date, a.activity_id, r.reminder_id;`,
    [from, to],
  );
  const sources = new Map<string, ServerReminderSource>();
  for (const row of rows) {
    const activityId = text(row, 'activity_id');
    const date = text(row, 'viewer_date');
    const reminderId = text(row, 'reminder_id');
    const offsetMinutes = number(row, 'offset_minutes');
    if (
      activityId === undefined ||
      date === undefined ||
      reminderId === undefined ||
      offsetMinutes === undefined
    )
      continue;
    const key = `${activityId}:${text(row, 'occurrence_date') ?? date}`;
    const previous = sources.get(key);
    const reminder = { reminderId, offsetMinutes };
    if (previous !== undefined) {
      sources.set(key, { ...previous, reminders: [...previous.reminders, reminder] });
      continue;
    }
    sources.set(key, {
      activityId,
      title: text(row, 'title') ?? 'Reminder',
      date: date as WallDate,
      time: text(row, 'time'),
      status: text(row, 'status') ?? 'scheduled',
      occurrenceDate: text(row, 'occurrence_date'),
      reminders: [reminder],
    });
  }
  return [...sources.values()];
}

async function pendingCreates(): Promise<Intent[]> {
  const state = requireActiveNativeState();
  return (await state.outbox.all())
    .filter(
      (intent) =>
        intent.mutationKey[0] === 'activity' &&
        intent.mutationKey[1] === 'create' &&
        intent.status !== 'needs_attention',
    )
    .map((intent) => ({ ...intent, ownerUserId: state.coordinator.ownerUserId }));
}

async function refreshProjection(): Promise<void> {
  if (!onlineManager.isOnline()) return;
  await requireActiveNativeState().sync.pullReminderCoverage();
}

export async function planFromCommittedRows() {
  const storedProfile = await profile();
  const today = systemClock.todayIn(storedProfile.timezone as TimeZone) as WallDate;
  const to = addWallDays(today, PROJECTION_DAYS) as WallDate;
  const projection = buildProjection(
    await serverSources(today, to),
    await pendingCreates(),
    { from: today, to },
  );
  const plan = planArming(projection, storedProfile, systemClock.now());
  return { requests: plan.requests, scheduledThrough: plan.scheduledThrough };
}

/** Native reminders are a consumer of committed SQLite rows; neither cache nor overlay is read. */
export function installLocalReminderScheduler(): () => void {
  if (!localNotificationsSupported) return () => undefined;
  const state = requireActiveNativeState();
  let stopped = false;
  let lastRefreshAt = 0;
  let pending = Promise.resolve();
  const schedule = new DirtySchedule({
    plan: planFromCommittedRows,
    replace: replaceLocalNotifications,
    readScheduled: readScheduledLocalNotifications,
    onError: () => console.warn('local_notification_refresh_failed'),
  });
  const tick = (reason: DirtyReason, refresh: boolean) => {
    schedule.mark(reason);
    pending = pending.then(async () => {
      if (stopped) return;
      const now = Date.parse(systemClock.now());
      if (refresh && now - lastRefreshAt >= MIN_REFRESH_INTERVAL_MS) {
        try {
          await refreshProjection();
          if (onlineManager.isOnline()) lastRefreshAt = now;
        } catch {
          // Existing committed rows remain armable; a failed refresh cancels nothing.
        }
      }
      await schedule.run();
    });
  };
  tick('startup', true);
  const appState = AppState.addEventListener('change', (next) => {
    if (next === 'background') tick('background', true);
  });
  const stopOnline = onlineManager.subscribe((online) => {
    if (online) tick('activity-changed', true);
  });
  const stops = ['agenda', 'reminders', 'outbox'].map((scope) =>
    state.account.subscriptions.subscribe(scope, () => tick('reminder-changed', false)),
  );
  return () => {
    stopped = true;
    appState.remove();
    stopOnline();
    for (const stop of stops) stop();
  };
}
