import type { AgendaData } from '@od/shared/types';
import { type AgendaProjectionClock, projectDay, uniqueItems } from './applyCompletion';

export interface DeleteProjectionVariables extends AgendaProjectionClock {
  activityId: string;
}

/**
 * Removes every cached agenda row belonging to a deleted Activity (P2-46).
 *
 * **Why this exists.** `projectActivityWrite` did not claim `delete`, while
 * `changesActivityLists` did — so a delete marked the agenda stale with `refetchType: 'none'`
 * and projected nothing. The detail screen navigates away on success, but the Today tab it
 * returns to is already mounted and has nothing to trigger a refetch, so the deleted row sat
 * there until a remount, a foreground, or the 60-second `staleTime` expired.
 *
 * **Every occurrence, not one.** `replaceAgendaItem` matches on `activityId` *and*
 * `occurrenceDate`, so a bare-id target would have removed only the undated row and left every
 * expanded occurrence of a deleted series on screen. `DELETE` takes the series and its
 * occurrences with it, so this matches on `activityId` alone.
 */
export function applyDelete(
  agenda: AgendaData,
  variables: DeleteProjectionVariables,
): AgendaData {
  let changed = false;

  const days = agenda.days.map((day) => {
    const items = uniqueItems(day).filter((item) => {
      if (item.activityId !== variables.activityId) return true;
      changed = true;
      return false;
    });
    return projectDay(day, items, variables);
  });

  return changed ? { ...agenda, days } : agenda;
}
