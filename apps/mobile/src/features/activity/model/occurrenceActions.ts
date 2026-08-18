import type {
  Activity,
  AgendaCapabilities,
  AgendaItem,
  OccurrenceDetailProjection,
} from '@od/shared/types';
import type { PendingActivity } from '@/lib/pendingActivity';

type DisplayActivity = Activity | PendingActivity;

/**
 * The occurrence-scoped actions a detail screen may offer, and the row shape the shared snooze
 * sheet needs to render them (P2-47).
 *
 * ## Why a projection rather than a second sheet
 *
 * `SnoozeSheet` is P2-25's option table, its pruning of times already past, and the deliberate
 * absence of `Tomorrow` on a recurring occurrence. None of that is agenda-specific, and a
 * second snooze surface built from an `Activity` would be a second copy of a table that must
 * agree with the first. The sheet keeps the `AgendaItem` shape it was written against — which
 * is what let it move from `features/agenda` with its tests passing unmodified — and this turns
 * the detail screen's Activity into that shape.
 *
 * ## Which occurrence the buttons act on
 *
 * The one in context, and no other. P2-47 left three readings open — today's occurrence
 * whenever the series has one, the next upcoming one, or only when an occurrence is actually in
 * scope. The third needs no new product decision and is already how the completion button
 * behaves, so a series reached without a day offers neither button rather than guessing at one.
 */

export interface OccurrenceContext {
  /** The nominal occurrence date the screen is about, absent on a one-off or a series view. */
  occurrenceDate: string | undefined;
  /** The date and time actually being shown, which an override can move off the series'. */
  shownSchedule: { date: string; time?: string } | undefined;
  /** Server-authored authorisation; the client never re-derives ownership. */
  capabilities: AgendaCapabilities | undefined;
  /** The explicit object choice. Tasks are what snooze and skip are defined on. */
  objectKind: Activity['objectKind'] | undefined;
  /** Whether the Activity carries a recurrence at all. */
  recurring: boolean;
}

/**
 * Whether the actions have a day to act on.
 *
 * A one-off is its own scope; a series needs an occurrence in context. Only the middle case is
 * ambiguous, and it is the one P2-47 left open — so a series reached without a day offers
 * neither action rather than guessing which of its occurrences was meant.
 */
function hasScope(context: OccurrenceContext): boolean {
  return !context.recurring || context.occurrenceDate !== undefined;
}

/**
 * Whether `Snooze` is offered.
 *
 * `today-and-tasks.md` §5.3's table gives snooze to a **timed task**, recurring or not — the
 * first row of it is "Non-recurring task, today, timed", and the last says an untimed one is
 * never offered it because there is no time to move. Requiring an occurrence, as this first
 * did, silently dropped the whole non-recurring row of that table.
 *
 * `objectKind`, not `type`: the object the user explicitly chose is what §5.3 is about, and a
 * presentation type deciding a gesture is the defect class this codebase greps for.
 */
export function canSnoozeOccurrence(context: OccurrenceContext): boolean {
  return (
    hasScope(context) &&
    context.objectKind === 'task' &&
    context.capabilities?.snooze === true &&
    context.shownSchedule?.time !== undefined
  );
}

/**
 * Whether `Skip today` is offered.
 *
 * §5.4: "available on any task and on any recurring occurrence" — so a one-off task qualifies
 * without a time, and a recurring plan's occurrence qualifies without being a task. A
 * non-recurring plan is neither; a passed one is resolved through its own prompt instead.
 */
export function canSkipOccurrence(context: OccurrenceContext): boolean {
  return (
    hasScope(context) &&
    context.capabilities?.skip === true &&
    (context.objectKind === 'task' || context.occurrenceDate !== undefined)
  );
}

/**
 * The occurrence as the shared snooze sheet reads it.
 *
 * Only the fields that sheet consults are filled from real data; the rest carry the empty
 * values an unshared, unresolved row has. `isRecurring` decides `Tomorrow`'s absence and the
 * blast-radius line, so it comes from the Activity's own recurrence rather than from whether a
 * date happens to be present.
 */
export function occurrenceAgendaItem(
  activity: DisplayActivity,
  context: OccurrenceContext,
): AgendaItem | undefined {
  const time = context.shownSchedule?.time;
  if (!hasScope(context) || time === undefined) return undefined;

  return {
    activityId: activity.activityId,
    ...(context.occurrenceDate === undefined
      ? {}
      : { occurrenceDate: context.occurrenceDate }),
    type: activity.type,
    title: activity.title,
    status: 'scheduled',
    time,
    isRecurring: activity.recurrence !== undefined,
    isSnoozed: false,
    hasCheckbox: false,
    capabilities: context.capabilities ?? { complete: false, skip: false, snooze: false },
    participantAvatars: [],
    participantCount: activity.participantCount,
    isPast: false,
  };
}

/**
 * The schedule a detail screen is **about**, with every override that moves it applied.
 *
 * ## One function, because a snooze is stored two ways and means one thing
 *
 * A series stores it as an `OCC#` row and a one-off as `snoozedUntil` on the Activity itself
 * (`data-model.md` §4.5, and `snoozeActivity`'s two branches). The agenda service already reads
 * both and hands the client one effective `time`; the detail screen read only the occurrence
 * shape, so a snoozed one-off went on showing its *scheduled* time indefinitely — not stale
 * cache, but a field no client surface consulted.
 *
 * That asymmetry is also why repeating a snooze behaved differently per kind. The sheet computes
 * its options from the time it is shown, so a series compounded — 6:00 to 6:15 to 6:30 — while a
 * one-off recomputed from a 6:00 that never moved and returned 6:15 every time. One storage
 * detail, two visible behaviours, from a contract that describes one.
 *
 * Everything that needs "what time is this actually at" goes through here, so a third storage
 * shape cannot quietly reach only some of them.
 */
export function effectiveSchedule(
  activity: DisplayActivity | undefined,
  occurrence: OccurrenceDetailProjection | undefined,
): { date: string; time?: string; endTime?: string } | undefined {
  if (occurrence !== undefined) {
    return {
      date: occurrence.date,
      ...(occurrence.time === undefined ? {} : { time: occurrence.time }),
      ...(occurrence.endTime === undefined ? {} : { endTime: occurrence.endTime }),
    };
  }
  const schedule = activity?.schedule;
  if (schedule === undefined) return undefined;

  /**
   * `snoozedUntil` is `HH:mm` on the same day for a one-off — the server rejects anything else
   * with `ONE_OFF_SAME_DAY`. The instant form the type also allows belongs to a cross-day
   * occurrence move, which never reaches this branch; it is ignored rather than parsed here, so
   * this stays a pure wall-clock read with no zone conversion in it.
   */
  const snoozed = activity?.snoozedUntil;
  /**
   * A snooze only means anything against a time. `Remove time` leaves the activity with none, so
   * a `snoozedUntil` that outlived it — as one did before the server learned to clear it — must
   * not put a time back on a row the user just made untimed.
   */
  const time =
    schedule.time !== undefined && snoozed !== undefined && /^\d{2}:\d{2}$/.test(snoozed)
      ? snoozed
      : schedule.time;

  return {
    date: schedule.date,
    ...(time === undefined ? {} : { time }),
    ...(schedule.endTime === undefined ? {} : { endTime: schedule.endTime }),
  };
}
