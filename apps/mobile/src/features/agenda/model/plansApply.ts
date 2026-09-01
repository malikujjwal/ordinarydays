import type { PlansDateStore } from '@od/shared/client';
import { describeRecurrence } from '@od/shared/recurrence';
import { activity as activitySchema, type NeedsDateItem } from '@od/shared/schemas';
import type { WallDate } from '@od/shared/time';
import type { AgendaItem } from '@od/shared/types';

/** The schema-owned wire shape; callers need no assertion into an independently named type. */
type ParsedActivity = ReturnType<typeof activitySchema.parse>;

/** The schema-validated needs-a-date row shape consumed by the Plans hook and projections. */
export type NeedsDateRowData = AgendaItem & {
  readonly lastActivityAt: string;
  readonly suggestionCount: number;
  readonly rsvpSummary: NeedsDateItem['rsvpSummary'];
};

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

/** The clock a projection reads instead of a `Date` (§4.3) — `applyCreate`'s own shape. */
export interface PlansProjectionClock {
  readonly today: WallDate;
  /** `HH:mm`; lets a today-dated timed row compute `isPast` the way the agenda cache does. */
  readonly currentMinute: string;
}

/**
 * The row an Activity projects as. **Deliberately parallel to `applyCreate.ts`'s literal**
 * (same directory) rather than extracted: that builder interleaves the agenda's
 * overdue/Anytime special cases this store has no concept of, and the two encode their own
 * boundary. Kept field-compatible on the load-bearing pieces — `occurrenceDate` scoping,
 * `capabilities`, and the `isPast` clock rule — with cross-reference comments both sides;
 * server-only enrichments (subtitle, location, note excerpt) arrive on reconciliation.
 */
function itemFromActivity(
  activity: ParsedActivity,
  clock: PlansProjectionClock,
): AgendaItem {
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
    // The same rule as `applyCreate`: past by date, or past by time once today's slot ends.
    isPast:
      date !== undefined &&
      (date < clock.today ||
        (date === clock.today &&
          time !== undefined &&
          (endTime ?? time) <= clock.currentMinute)),
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
  activity: ParsedActivity,
  clock: PlansProjectionClock,
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
      ...itemFromActivity(activity, clock),
      lastActivityAt: activity.lastActivityAt,
      suggestionCount: 0,
      rsvpSummary: zeroRsvp,
    };
    return { ...current, needsDate: [row, ...current.needsDate] };
  }

  const item = itemFromActivity(activity, clock);
  const byDate = new Map(current.store.byDate);
  const day = [...(byDate.get(date as WallDate) ?? []), item].sort(byTimeThenId);
  byDate.set(date as WallDate, day);
  return { ...current, store: { ...current.store, byDate } };
}

/**
 * Strips every trace of one Activity from both stages — the delete projection, and the
 * removal half of a reschedule (the insert half is {@link applyPlansCreate} again). Returns
 * `undefined` when nothing held the row, so callers keep every identity stable.
 */
export function applyPlansRemove(
  current: PlansProjectionState,
  activityId: string,
): PlansProjectionState | undefined {
  let changed = false;
  const needsDate = current.needsDate.filter((row) => {
    if (row.activityId !== activityId) return true;
    changed = true;
    return false;
  });
  const byDate = new Map(current.store.byDate);
  for (const [date, rows] of byDate) {
    const next = rows.filter((row) => row.activityId !== activityId);
    if (next.length !== rows.length) {
      changed = true;
      // The emptied key stays: inside a covered interval, empty means loaded-and-empty.
      byDate.set(date, next);
    }
  }
  if (!changed) return undefined;
  return { needsDate, store: { ...current.store, byDate } };
}

/** The Activity inside a create/duplicate success payload, however the endpoint wraps it. */
export function createdActivityFrom(data: unknown): ParsedActivity | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const candidate = 'activity' in data ? Reflect.get(data, 'activity') : data;
  const parsed = activitySchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}
