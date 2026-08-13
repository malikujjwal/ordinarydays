import type { Activity, AgendaData, AgendaItem } from '@od/shared/types';
import {
  type AgendaProjectionClock,
  findAgendaItem,
  replaceAgendaItem,
} from './applyCompletion';

export interface CreateProjectionVariables extends AgendaProjectionClock {
  /** The window this cache entry covers, so a create outside it is left alone. */
  activity: Activity;
}

/**
 * Places a **server-confirmed** new Activity into an agenda window.
 *
 * **Why this exists (P2-46).** The agenda is served from `GSI1`, and a global secondary index
 * is eventually consistent — there is no such thing as a consistent read on one. Invalidating
 * the agenda on create fires a refetch within tens of milliseconds of the write, which races
 * the index and frequently loses: the server answers `200` with pre-write data, the client
 * caches that, and nothing retries. Today then shows a stale day until something else
 * invalidates it. Every layer is individually correct, which is why no unit test caught it and
 * why `create-activity.spec.ts` had been failing since Phase 1.
 *
 * The row is projected from the **201 response**, not from the draft the user typed. The
 * server has already accepted the write, so there is nothing to roll back and no invented
 * `activityId` to reconcile later — this is the "keep local state and reconcile" branch, and
 * the invalidation that follows it is reconciliation rather than the only source of truth.
 *
 * Idempotent: an activity the window already holds is left untouched, so arriving here after
 * a refetch that *did* win the race cannot double the row.
 */
export function applyCreate(
  agenda: AgendaData,
  variables: CreateProjectionVariables,
): AgendaData {
  const { activity } = variables;
  const date = activity.schedule?.date;

  // An undated Task belongs to the ANYTIME bucket of the window's first day; a dated one
  // belongs to its own date. Either way, a create outside this window is not ours to place.
  const destinationDate = date ?? agenda.days[0]?.date;
  if (destinationDate === undefined) return agenda;
  if (!agenda.days.some((day) => day.date === destinationDate)) return agenda;

  const target = { activityId: activity.activityId };
  if (findAgendaItem(agenda, target) !== undefined) return agenda;

  const time = activity.schedule?.time;
  const endTime = activity.schedule?.endTime;
  const next: AgendaItem = {
    activityId: activity.activityId,
    type: activity.type,
    title: activity.title,
    status: date === undefined ? 'saved' : 'scheduled',
    ...(time === undefined ? {} : { time }),
    ...(endTime === undefined ? {} : { endTime }),
    isRecurring: activity.recurrence !== undefined,
    isSnoozed: false,
    hasCheckbox: activity.type === 'task',
    capabilities: {
      complete: true,
      skip: activity.recurrence !== undefined,
      snooze: true,
    },
    participantAvatars: [],
    participantCount: 0,
    ...(activity.parentActivityId === undefined
      ? {}
      : { parentActivityId: activity.parentActivityId }),
    isPast:
      date !== undefined &&
      (date < variables.today ||
        (date === variables.today &&
          time !== undefined &&
          (endTime ?? time) <= variables.currentMinute)),
  };

  return replaceAgendaItem(agenda, target, next, destinationDate, variables);
}
