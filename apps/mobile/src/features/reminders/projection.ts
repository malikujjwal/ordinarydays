import { expandRecurrence } from '@od/shared/recurrence';
import type { WallDate } from '@od/shared/time';
import type { Recurrence } from '@od/shared/types';
import type { Intent } from '@/lib/intent';

/**
 * The bounded reminder projection (P2-57).
 *
 * ## Why a projection at all
 *
 * `refreshLocalNotifications` used to read the agenda over the network every time it ran, so
 * a device with no connectivity — the exact case local notifications exist for — could not
 * recompute what to arm. This is the persisted substitute: today → +7 days, reminder-relevant
 * fields only, small enough to keep on disk and re-read on a cold start.
 *
 * It is deliberately **not** a replica. This is a bounded derived projection for one device
 * capability. Nothing here is authoritative: native rebuilds it from committed SQLite rows
 * plus unresolved SQLite outbox creates, while web uses its persisted server projection and
 * passes no pending creates.
 *
 * ## The hybrid rule, which is the correctness core
 *
 * Two sources, and they are never mixed:
 *
 * 1. **Server-known activities come only from `include=reminders` responses.** They are never
 *    re-expanded locally, because an occurrence's real state depends on stored `OCC#`
 *    overrides — a completion, a skip, a moved day — that the device cannot see. Phase 2.5
 *    made the server's projection authoritative precisely so nothing downstream would guess,
 *    and locally re-expanding a series would arm a reminder for a day the user already
 *    skipped.
 * 2. **Pending native creates are expanded with the shared `expandRecurrence`.** Safe for
 *    exactly the reason the first case is not: the server has never seen these, so no
 *    override can exist for them. Web passes an empty set because it has no durable queue.
 *
 * Getting this backwards in either direction is a real defect — locally expanding a
 * server-known series arms skipped days, and refusing to expand a pending one means a
 * recurring task created offline never reminds at all.
 */

/** One armable reminder occurrence, flattened to what the scheduler needs and nothing else. */
export interface ProjectedReminder {
  /** Stable across recomputes, so re-arming does not orphan or duplicate a request. */
  key: string;
  activityId: string;
  reminderId: string;
  title: string;
  /** The occurrence's own wall date. */
  date: WallDate;
  /** The activity's wall time, absent for an all-day activity. */
  time: string | undefined;
  offsetMinutes: number;
  /** Whether this came from the log rather than the server, which changes nothing about
   * arming and everything about what may be re-expanded. Carried for tests and diagnostics. */
  source: 'server' | 'pending';
}

export interface ProjectionWindow {
  from: WallDate;
  to: WallDate;
}

/**
 * The shape the server's `include=reminders` agenda collapses to.
 *
 * Deliberately narrow. `AgendaItem` carries far more than a reminder needs, and persisting
 * the whole thing would make this projection a second cache of the agenda — which is what
 * the scope guard forbids.
 */
export interface ServerReminderSource {
  activityId: string;
  title: string;
  date: WallDate;
  time: string | undefined;
  status: string;
  occurrenceDate: string | undefined;
  reminders: readonly { reminderId: string; offsetMinutes: number }[];
}

const TERMINAL = new Set([
  'completed',
  'completed_occurrence',
  'skipped',
  'skipped_occurrence',
  'cancelled',
]);

/** One key per (activity, occurrence, reminder), so recompute replaces rather than appends. */
export function reminderKey(
  activityId: string,
  date: string,
  reminderId: string,
): string {
  return `${activityId}:${date}:${reminderId}`;
}

/**
 * Server-known reminders, taken verbatim from what the server projected.
 *
 * No expansion, no inference — the only judgement made here is dropping terminal occurrences,
 * and even that is reading a status the server computed rather than deciding one.
 */
export function fromServerAgenda(
  items: readonly ServerReminderSource[],
): ProjectedReminder[] {
  const projected: ProjectedReminder[] = [];
  for (const item of items) {
    if (TERMINAL.has(item.status)) continue;
    const date = (item.occurrenceDate ?? item.date) as WallDate;
    for (const reminder of item.reminders) {
      // An all-day activity has no instant to subtract minutes from; only whole days apply.
      if (item.time === undefined && reminder.offsetMinutes % 1440 !== 0) continue;
      projected.push({
        key: reminderKey(item.activityId, date, reminder.reminderId),
        activityId: item.activityId,
        reminderId: reminder.reminderId,
        title: item.title,
        date,
        time: item.time,
        offsetMinutes: reminder.offsetMinutes,
        source: 'server',
      });
    }
  }
  return projected;
}

/**
 * What one pending create describes, reconstructed from the intent's own variables.
 *
 * **Read-only against the log.** This takes `Intent`s the caller already has and never asks
 * the log for anything beyond `pending()`. P2-57's acceptance test is that the log needs no
 * change to serve reminders — if this file had to reach into it, the primitive would have
 * been activity-specific and Phase 3 could not reuse it either.
 */
interface PendingActivity {
  activityId: string;
  title: string;
  date: WallDate | undefined;
  time: string | undefined;
  timezone: string | undefined;
  recurrence: Recurrence | undefined;
  reminders: { reminderId: string; offsetMinutes: number }[];
}

function pendingActivityFrom(intent: Intent): PendingActivity | undefined {
  const variables = intent.variables as { input?: Record<string, unknown> } | undefined;
  const input = variables?.input;
  if (input === undefined) return undefined;
  const schedule = input.schedule as
    | { date?: string; time?: string; timezone?: string }
    | undefined;
  const reminders = Array.isArray(input.reminders)
    ? (input.reminders as { reminderId?: string; offsetMinutes: number }[])
    : [];
  return {
    activityId: intent.entityId,
    title: typeof input.title === 'string' ? input.title : 'Reminder',
    date: schedule?.date as WallDate | undefined,
    time: schedule?.time,
    timezone: schedule?.timezone,
    recurrence: input.recurrence as Recurrence | undefined,
    reminders: reminders.flatMap((reminder) =>
      /**
       * A reminder with no client id cannot be armed: its key would change on every
       * recompute, so each pass would orphan the previous request and arm a duplicate. This
       * is why P2-57 needed the optional `reminderId` on the shared schema.
       */
      typeof reminder.reminderId === 'string'
        ? [{ reminderId: reminder.reminderId, offsetMinutes: reminder.offsetMinutes }]
        : [],
    ),
  };
}

/**
 * Pending-create reminders, expanded locally.
 *
 * Recurring pending activities go through the **shared** `expandRecurrence`, not a second
 * implementation — the engine whose property and boundary tests are already green, and whose
 * behaviour the server matches by construction.
 */
export function fromPendingIntents(
  intents: readonly Intent[],
  window: ProjectionWindow,
): ProjectedReminder[] {
  const projected: ProjectedReminder[] = [];
  for (const intent of intents) {
    if (intent.mutationKey[1] !== 'create') continue;
    const activity = pendingActivityFrom(intent);
    if (activity === undefined || activity.date === undefined) continue;
    if (activity.reminders.length === 0) continue;

    const dates =
      activity.recurrence === undefined
        ? inWindow(activity.date, window)
          ? [activity.date]
          : []
        : (expandRecurrence(
            activity.recurrence,
            window.from,
            window.to,
            activity.timezone ?? 'UTC',
          ) as WallDate[]);

    for (const date of dates) {
      for (const reminder of activity.reminders) {
        if (activity.time === undefined && reminder.offsetMinutes % 1440 !== 0) continue;
        projected.push({
          key: reminderKey(activity.activityId, date, reminder.reminderId),
          activityId: activity.activityId,
          reminderId: reminder.reminderId,
          title: activity.title,
          date,
          time: activity.time,
          offsetMinutes: reminder.offsetMinutes,
          source: 'pending',
        });
      }
    }
  }
  return projected;
}

function inWindow(date: WallDate, window: ProjectionWindow): boolean {
  return date >= window.from && date <= window.to;
}

/**
 * The whole projection: server rows plus pending ones, de-duplicated by key.
 *
 * The server wins a collision, which is the moment an intent is acknowledged and the same
 * reminder arrives from both sides. Because the client minted the id, the two rows carry the
 * **same key** — so acknowledgement re-keys nothing, orphans nothing and duplicates nothing.
 * That property is the entire reason for the client-minted `rem_`.
 */
export function buildProjection(
  server: readonly ServerReminderSource[],
  pending: readonly Intent[],
  window: ProjectionWindow,
): ProjectedReminder[] {
  const byKey = new Map<string, ProjectedReminder>();
  for (const entry of fromPendingIntents(pending, window)) byKey.set(entry.key, entry);
  for (const entry of fromServerAgenda(server)) byKey.set(entry.key, entry);
  return [...byKey.values()];
}
