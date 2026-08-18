import { reminderDelivery } from '@od/shared/notifications';
import { addWallDays, toUtcInstant } from '@od/shared/recurrence';
import type { Instant, TimeZone, WallDate } from '@od/shared/time';
import type { QuietHours } from '@od/shared/types';
import type { LocalNotificationRequest } from '@/lib/push.types';
import type { ProjectedReminder } from './projection';

/**
 * Turning a projection into an armed notification set (P2-57).
 *
 * ## The cap nobody had written down
 *
 * **iOS keeps at most 64 pending local notifications.** Past that, `scheduleNotificationAsync`
 * stops taking them — quietly, from the app's point of view. No earlier document in this
 * repository recorded the limit, and a heavy user with eight days of reminders passes it
 * easily.
 *
 * The response is to arm **nearest-first with headroom**, and to be honest about the horizon
 * rather than pretending to full coverage. Whatever the last armed request fires at becomes
 * `scheduledThrough`: the device is saying "I have this covered up to here, and no further".
 * A heavy user gets a shorter local horizon — never silently dropped reminders — and Phase 5's
 * push backstop covers beyond it, which is exactly what P5-16's acknowledgement is for.
 *
 * Headroom below 64 leaves room for anything else the app arms later without evicting a
 * reminder the user is relying on.
 */

/** Below iOS's 64, so the cap is reached before the OS starts refusing silently. */
export const MAX_ARMED_LOCAL_NOTIFICATIONS = 60;

const MINUTE_MS = 60_000;
const DEFAULT_ALL_DAY_HOUR = 9;
const TITLE_LIMIT = 40;
const BODY_LIMIT = 110;

export interface ArmingProfile {
  timezone: string;
  allDayReminderHour?: number | undefined;
  quietHours?: QuietHours | undefined;
}

export interface ArmingPlan {
  requests: LocalNotificationRequest[];
  /**
   * The fire time of the last armed request, or `undefined` when nothing was armed.
   *
   * The device's honest local horizon. Phase 5 acknowledges it so the server can suppress a
   * push inside it and send one beyond it.
   */
  scheduledThrough: Instant | undefined;
  /** How many projected reminders the cap left unarmed. Non-zero is not an error. */
  dropped: number;
}

/**
 * The instant a reminder fires, and the activity's own local time for the quiet-hours rule.
 *
 * An all-day activity has no start instant, so its reminder is anchored to the user's
 * all-day hour and reports no activity time — which is what makes `reminderDelivery` judge it
 * on its own fire time instead.
 */
function fireInstant(
  reminder: ProjectedReminder,
  profile: ArmingProfile,
): { fireAt: Instant; activityTime: string | undefined } {
  const timezone = profile.timezone as TimeZone;
  if (reminder.time !== undefined) {
    const startsAt = toUtcInstant(reminder.date, reminder.time, timezone);
    return {
      fireAt: new Date(
        Date.parse(startsAt) + reminder.offsetMinutes * MINUTE_MS,
      ).toISOString() as Instant,
      activityTime: reminder.time,
    };
  }
  const hour = profile.allDayReminderHour ?? DEFAULT_ALL_DAY_HOUR;
  const fireDate = addWallDays(reminder.date, reminder.offsetMinutes / 1440);
  return {
    fireAt: toUtcInstant(
      fireDate,
      `${String(hour).padStart(2, '0')}:00`,
      timezone,
    ) as Instant,
    activityTime: undefined,
  };
}

/** `HH:mm` in the user's zone, which is the form the quiet-hours policy compares. */
function wallTimeIn(instant: Instant, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date(instant));
}

/**
 * Builds the armable set from a projection.
 *
 * Quiet hours are applied through the **shared** policy module rather than restated here —
 * `notifications.md` §4 is the single definition, and the device and the Phase 5 Lambda have
 * to reach the same verdict or the local-first model produces duplicates. A held reminder is
 * moved to the window's end rather than dropped: the user still hears about it, in the
 * morning, which is what "held" means in §4.
 */
export function planArming(
  projection: readonly ProjectedReminder[],
  profile: ArmingProfile,
  now: Instant,
): ArmingPlan {
  const candidates: { request: LocalNotificationRequest; fireAt: number }[] = [];

  for (const reminder of projection) {
    const { fireAt, activityTime } = fireInstant(reminder, profile);
    let effectiveFireAt = fireAt;

    const verdict = reminderDelivery({
      fireAt: wallTimeIn(fireAt, profile.timezone),
      activityAt: activityTime,
      window: profile.quietHours,
    });
    if (verdict.kind === 'hold') {
      /**
       * Held to the window's end. The date is the fire time's own local date, so a reminder
       * held at 03:00 surfaces at 07:00 the same morning rather than a day later.
       */
      const localDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: profile.timezone,
      }).format(new Date(fireAt)) as WallDate;
      effectiveFireAt = toUtcInstant(
        localDate,
        verdict.until,
        profile.timezone as TimeZone,
      ) as Instant;
    }

    const fireMs = Date.parse(effectiveFireAt);
    // A reminder whose moment has passed is not armed; the OS would fire it immediately.
    if (fireMs <= Date.parse(now)) continue;

    candidates.push({
      request: {
        identifier: reminder.key,
        title: truncateAtWord(reminder.title, TITLE_LIMIT),
        body: truncateAtWord(bodyFor(reminder), BODY_LIMIT),
        fireAt: effectiveFireAt,
        route: `/activity/${reminder.activityId}`,
      },
      fireAt: fireMs,
    });
  }

  // Nearest first, so the cap costs the furthest-away reminders rather than the next one.
  candidates.sort((left, right) => left.fireAt - right.fireAt);
  const armed = candidates.slice(0, MAX_ARMED_LOCAL_NOTIFICATIONS);
  const last = armed.at(-1);

  return {
    requests: armed.map((candidate) => candidate.request),
    scheduledThrough: last === undefined ? undefined : (last.request.fireAt as Instant),
    dropped: candidates.length - armed.length,
  };
}

function bodyFor(reminder: ProjectedReminder): string {
  if (reminder.time === undefined) return allDayBody(reminder.offsetMinutes);
  return `${relativeLead(reminder.offsetMinutes)} · ${formatWallTime(reminder.time)}`;
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

/**
 * Whether the OS ended up holding exactly what was asked for.
 *
 * All-or-nothing on purpose: a partial arming leaves the schedule **dirty** so the next
 * trigger retries it, rather than marking clean over a set that is missing reminders. The
 * comparison is by identifier, because that is what a later pass has to match to avoid
 * orphaning or duplicating.
 */
export function armingVerified(
  intended: readonly LocalNotificationRequest[],
  actual: readonly string[],
): boolean {
  if (intended.length !== actual.length) return false;
  const held = new Set(actual);
  return intended.every((request) => held.has(request.identifier));
}
