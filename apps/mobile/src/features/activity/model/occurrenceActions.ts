import type { Activity, AgendaCapabilities, AgendaItem } from '@od/shared/types';

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
  activity: Activity,
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
