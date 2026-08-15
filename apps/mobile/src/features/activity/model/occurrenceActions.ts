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
  /** The nominal occurrence date the screen is about, absent on a series-only view. */
  occurrenceDate: string | undefined;
  /** The date and time actually being shown, which an override can move off the series'. */
  shownSchedule: { date: string; time?: string } | undefined;
  /** Server-authored; the client never re-derives ownership. */
  capabilities: AgendaCapabilities | undefined;
}

/** Whether `Snooze` is offered: a timed occurrence in context that the server permits. */
export function canSnoozeOccurrence(context: OccurrenceContext): boolean {
  return (
    context.occurrenceDate !== undefined &&
    context.capabilities?.snooze === true &&
    context.shownSchedule?.time !== undefined
  );
}

/** Whether `Skip today` is offered. A skip needs no time, only a day and the capability. */
export function canSkipOccurrence(context: OccurrenceContext): boolean {
  return context.occurrenceDate !== undefined && context.capabilities?.skip === true;
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
  if (context.occurrenceDate === undefined || time === undefined) return undefined;

  return {
    activityId: activity.activityId,
    occurrenceDate: context.occurrenceDate,
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
