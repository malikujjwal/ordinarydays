import type { PlansDateStore } from '@od/shared/client';
import { describeRecurrence } from '@od/shared/recurrence';
import type { WallDate } from '@od/shared/time';
import type { Activity, AgendaItem } from '@od/shared/types';
import type { NeedsDateRowData } from '../hooks/usePlans';

/**
 * Places a newly-created Activity into the Plans tab's local state (P3-36's regression,
 * caught by `create-activity.spec.ts` in the Phase B run).
 *
 * The tab reads `/v1/plans`, whose dated stages come back through GSI1 — eventually
 * consistent, so a refetch fired milliseconds after a create usually answers with pre-write
 * data (the P2-46 lesson, measured). The agenda cache solved this by projecting the **201
 * response** — the authoritative row — instead of refetching; this is the same decision for
 * the `/v1/plans` date store and the needs-a-date stage, which no longer read that cache.
 *
 * Only what the response states is projected: a dated create lands on its own date in
 * Upcoming order (time, then id, untimed first), an undated Plan heads Needs a date with the
 * server's own `lastActivityAt`. A recurring create projects its first occurrence only — the
 * expansion across every loaded day is reconciliation's job on the next natural refetch,
 * because this store spans windows the create response knows nothing about.
 */

const zeroRsvp = {
  interested: { count: 0, names: [] },
  maybe: { count: 0, names: [] },
  pass: { count: 0, names: [] },
  pending: { count: 0, names: [] },
} satisfies NeedsDateRowData['rsvpSummary'];

function itemFromActivity(activity: Activity, today: WallDate): AgendaItem {
  const date = activity.schedule?.date;
  const time = activity.schedule?.time;
  const endTime = activity.schedule?.endTime;
  return {
    activityId: activity.activityId,
    type: activity.type,
    title: activity.title,
    status:
      activity.status === 'saved' && date !== undefined ? 'scheduled' : activity.status,
    ...(time === undefined ? {} : { time }),
    ...(endTime === undefined ? {} : { endTime }),
    isRecurring: activity.recurrence !== undefined,
    ...(activity.recurrence === undefined || date === undefined
      ? {}
      : {
          occurrenceDate: date,
          recurrenceDescription: describeRecurrence(activity.recurrence, date),
        }),
    isSnoozed: false,
    hasCheckbox: activity.type === 'task',
    capabilities: {
      complete: true,
      skip: activity.recurrence !== undefined,
      snooze: true,
    },
    participantAvatars: [],
    participantCount: activity.participantCount,
    ...(activity.parentActivityId === undefined
      ? {}
      : { parentActivityId: activity.parentActivityId }),
    isPast: date !== undefined && date < today,
  };
}

export interface PlansProjectionState {
  readonly needsDate: readonly NeedsDateRowData[];
  readonly store: PlansDateStore;
}

/** Upcoming's in-day order: effective time then id, untimed rows first (§1.3). */
function byTimeThenId(
  a: { time?: string | undefined; activityId: string },
  b: { time?: string | undefined; activityId: string },
): number {
  const timeA = a.time ?? '';
  const timeB = b.time ?? '';
  if (timeA !== timeB) return timeA < timeB ? -1 : 1;
  return a.activityId < b.activityId ? -1 : a.activityId > b.activityId ? 1 : 0;
}

export function applyPlansCreate(
  current: PlansProjectionState,
  activity: Activity,
  today: WallDate,
): PlansProjectionState | undefined {
  const date = activity.schedule?.date;

  // Idempotent: a row this state already holds is left alone — a replayed success or a
  // response arriving after a converged refetch must not double it.
  const known =
    current.needsDate.some((row) => row.activityId === activity.activityId) ||
    [...current.store.byDate.values()].some((rows) =>
      rows.some((row) => row.activityId === activity.activityId),
    );
  if (known) return undefined;

  if (date === undefined) {
    // Undated Tasks belong to Today's Anytime, not to this tab.
    if (activity.objectKind !== 'plan') return undefined;
    const row: NeedsDateRowData = {
      ...itemFromActivity(activity, today),
      lastActivityAt: activity.lastActivityAt,
      suggestionCount: 0,
      rsvpSummary: zeroRsvp,
    };
    return { ...current, needsDate: [row, ...current.needsDate] };
  }

  const item = itemFromActivity(activity, today);
  const byDate = new Map(current.store.byDate);
  const day = [...(byDate.get(date as WallDate) ?? []), item].sort(byTimeThenId);
  byDate.set(date as WallDate, day);
  return { ...current, store: { ...current.store, byDate } };
}

/** The Activity inside a create/duplicate success payload, however the endpoint wraps it. */
export function createdActivityFrom(data: unknown): Activity | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const candidate = 'activity' in data ? (data as { activity: unknown }).activity : data;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  return typeof (candidate as { activityId?: unknown }).activityId === 'string'
    ? (candidate as Activity)
    : undefined;
}
