import type { Activity, AgendaData, AgendaItem } from '@od/shared/types';
import { type AgendaProjectionClock, projectDay, uniqueItems } from './applyCompletion';

export interface PatchProjectionVariables extends AgendaProjectionClock {
  /** The server's post-patch copy. Every field below is derived from it, never invented. */
  activity: Activity;
}

/**
 * Refreshes non-recurrence fields on cached agenda rows after an Activity `PATCH` (P2-46).
 *
 * Recurrence is deliberately absent. A rule change can add, remove, move, or preserve rows
 * based on segments, count/date endings, and occurrence history. The client cannot derive that
 * set from one cached window, so `projectActivityWrite` sends recurrence PATCHes through the
 * versioned agenda reconciler instead. Keeping that boundary here prevents a stale partial
 * projection from flashing before the canonical expansion arrives.
 */
export function applyPatch(
  agenda: AgendaData,
  variables: PatchProjectionVariables,
): AgendaData {
  const { activity } = variables;
  let changed = false;

  const days = agenda.days.map((day) => {
    const items = uniqueItems(day).map((item) => {
      if (item.activityId !== activity.activityId) return item;
      const next = refreshed(item, activity);
      if (next !== item) changed = true;
      return next;
    });
    return projectDay(day, items, variables);
  });

  return changed ? { ...agenda, days } : agenda;
}

/** The row fields an ordinary Activity patch can update without re-expanding a series. */
function refreshed(item: AgendaItem, activity: Activity): AgendaItem {
  const hasCheckbox = activity.type === 'task';
  if (
    item.title === activity.title &&
    item.type === activity.type &&
    item.hasCheckbox === hasCheckbox
  ) {
    return item;
  }

  return {
    ...item,
    type: activity.type,
    title: activity.title,
    hasCheckbox,
  };
}
