import type { Activity, AgendaData, AgendaItem } from '@od/shared/types';
import { type AgendaProjectionClock, projectDay, uniqueItems } from './applyCompletion';

export interface PatchProjectionVariables extends AgendaProjectionClock {
  /** The server's post-patch copy. Every field below is derived from it, never invented. */
  activity: Activity;
}

/**
 * An occurrence's status is meaningless once the activity is no longer a series.
 * `AgendaItemStatus` is `ActivityStatus` plus these two, so the server's own status replaces
 * them cleanly.
 */
const OCCURRENCE_STATUSES: ReadonlySet<string> = new Set([
  'completed_occurrence',
  'skipped_occurrence',
]);

/**
 * Refreshes the cached agenda rows for an Activity a `PATCH` has just changed (P2-46).
 *
 * **Why a patch needed its own projection.** `projectActivityWrite` claimed `create`,
 * `duplicate`, `schedule`, `complete`, `uncomplete` and `skip`, and returned `false` for
 * everything else — while `changesActivityLists` returned `true` for every `['activity', *]`
 * key, so `refreshActivityLists` still ran and marked the agenda stale with
 * `refetchType: 'none'`. A patch therefore projected nothing *and* triggered no refetch: the
 * row on Today kept its pre-patch shape until a remount, a foreground, or the 60-second
 * `staleTime` expired.
 *
 * `refetchType: 'none'` is correct and stays: the agenda is read from an eventually-consistent
 * `GSI1` and an immediate refetch loses that race.
 *
 * **Recurrence is not one flag.** Turning it on or off changes three things about a row, and an
 * earlier pass moved only the first — which broke the flow it was meant to fix:
 *
 * 1. `isRecurring`, and the `skip` capability that goes with it.
 * 2. **`occurrenceDate`.** An expanded occurrence is identified by the day it falls on, and the
 *    detail screen will not offer a completion control without one. Marking a row recurring and
 *    leaving it without an occurrence date made the completion button vanish until a real
 *    refetch arrived — reported as "a big delay before the complete button shows up".
 * 3. **`status`.** A completed occurrence carries `completed_occurrence`; drop the recurrence
 *    and that status describes an occurrence that no longer exists. The row stayed crossed off
 *    with an `Undo` that targeted a missing occurrence — reported as "the task gets stuck as
 *    completed, then it won't switch back".
 *
 * **The limit, and it is narrow.** This adjusts rows the window already holds. It does not
 * expand a newly added recurrence into occurrences on *other* days — that needs the recurrence
 * engine, and inventing an occurrence set client-side is the one thing worse than waiting for
 * the next refetch. Removing a recurrence is fully derivable in the other direction: a one-off
 * exists on exactly one date, so surplus occurrence rows are dropped here.
 */
export function applyPatch(
  agenda: AgendaData,
  variables: PatchProjectionVariables,
): AgendaData {
  const { activity } = variables;
  const isRecurring = activity.recurrence !== undefined;
  /** One surviving row per day bucket, so flattening can never empty a window. */
  const kept = new Set<string>();
  let changed = false;

  const days = agenda.days.map((day) => {
    const items: AgendaItem[] = [];
    for (const item of uniqueItems(day)) {
      if (item.activityId !== activity.activityId) {
        items.push(item);
        continue;
      }

      /**
       * A one-off lives on exactly one date, so the surplus occurrences of a former series go.
       * Clearing `occurrenceDate` collapses rows into one identity, so keeping them all would
       * leave duplicates behind.
       *
       * **Which one survives is decided per day bucket, not against the series anchor.**
       * Comparing the row's day to `activity.schedule.date` dropped every row in a window that
       * did not contain the anchor — so stopping a repeat while looking at today made the task
       * vanish, against the confirmation's own promise that it "keeps the activity". The
       * anchor is where the series *started*; it is not the occurrence anyone is looking at,
       * and this projection has no business relocating a row the user is watching.
       */
      if (!isRecurring) {
        if (kept.has(day.date)) {
          changed = true;
          continue;
        }
        kept.add(day.date);
      }

      const next = refreshed(item, activity, day.date, isRecurring);
      if (next !== item) changed = true;
      items.push(next);
    }
    return projectDay(day, items, variables);
  });

  return changed ? { ...agenda, days } : agenda;
}

/** The row's Activity-derived fields, left identical when the patch touched none of them. */
function refreshed(
  item: AgendaItem,
  activity: Activity,
  dayDate: string,
  isRecurring: boolean,
): AgendaItem {
  const hasCheckbox = activity.type === 'task';
  // The server identifies an expanded occurrence by its day, and so does this.
  const occurrenceDate = isRecurring ? (item.occurrenceDate ?? dayDate) : undefined;
  const status =
    !isRecurring && OCCURRENCE_STATUSES.has(item.status) ? activity.status : item.status;

  if (
    item.title === activity.title &&
    item.type === activity.type &&
    item.isRecurring === isRecurring &&
    item.hasCheckbox === hasCheckbox &&
    item.capabilities.skip === isRecurring &&
    item.occurrenceDate === occurrenceDate &&
    item.status === status
  ) {
    return item;
  }

  const { occurrenceDate: _dropped, ...rest } = item;
  return {
    ...rest,
    type: activity.type,
    title: activity.title,
    status,
    isRecurring,
    hasCheckbox,
    capabilities: { ...item.capabilities, skip: isRecurring },
    ...(occurrenceDate === undefined ? {} : { occurrenceDate }),
  };
}
