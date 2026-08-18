import type { CreateActivityInput } from '@od/shared/schemas';
import type { Activity, AgendaData, AgendaItem } from '@od/shared/types';
import {
  type AgendaProjectionClock,
  findAgendaItem,
  replaceAgendaItem,
} from './applyCompletion';

export interface CreateProjectionVariables extends AgendaProjectionClock {
  /** The window this cache entry covers, so a create outside it is left alone. */
  activity: Activity;
  /**
   * Replace a row this window already holds instead of leaving it (P2-49).
   *
   * The `201` path sets it. An offline create has already projected itself from local input,
   * so without this the server's answer — the only thing that can supply `createdAt`, the
   * derived status and every other server-owned field — would be dropped on the floor by the
   * idempotency guard below.
   */
  reconcile?: boolean;
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
  if (findAgendaItem(agenda, target) !== undefined && variables.reconcile !== true) {
    return agenda;
  }

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
    /**
     * **A series row names the day it is on, not just that it repeats.**
     *
     * Every surface that writes against an occurrence reads this field for its scope, and the
     * Today checkbox is the loudest: given a recurring row without one it sent an *unscoped*
     * `POST /complete`, which sets the status on the series row — and `agendaService`'s
     * `mergeNominal` renders every un-overridden occurrence with the series status. One tick
     * crossed off the whole series. The server identifies an expanded occurrence by its day,
     * and so does this.
     */
    ...(activity.recurrence === undefined || date === undefined
      ? {}
      : { occurrenceDate: date }),
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

/**
 * Projects a create the server has **not** seen yet, from the input the user typed.
 *
 * `applyCreate`'s second entry point (P2-49). An offline create carries its own permanent
 * `act_` ULID, so the row can render immediately under the id it will always have — no
 * temporary id, and nothing to rewrite when the `201` eventually lands.
 *
 * **It projects only what the client can compute correctly** (`tech-stack.md` §3.4,
 * invariant 4). Title, type, schedule and recurrence came from the user and no server state
 * can contradict them. Everything server-owned is a placeholder here and is replaced
 * wholesale by {@link applyCreate} with `reconcile` when the response arrives — which is why
 * `createdAt` below is the projection time and never claims to be authoritative.
 */
export function applyPendingCreate(
  agenda: AgendaData,
  variables: PendingCreateVariables,
): AgendaData {
  const { input, activityId, mintedAt } = variables;
  const provisional = {
    activityId,
    /** Placeholder. The `201` supplies the real one; nothing renders it meanwhile. */
    ownerId: '',
    objectKind: input.objectKind,
    type: input.type,
    status: input.schedule === undefined ? 'saved' : 'scheduled',
    title: input.title,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
    ...(input.recurrence === undefined ? {} : { recurrence: input.recurrence }),
    ...(input.location === undefined ? {} : { location: input.location }),
    ...(input.parentActivityId === undefined
      ? {}
      : { parentActivityId: input.parentActivityId }),
    details: input.details ?? { kind: input.type },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: mintedAt,
    lastActivityAt: mintedAt,
    updatedAt: mintedAt,
    schemaVersion: 1,
  } as Activity;

  return applyCreate(agenda, {
    activity: provisional,
    today: variables.today,
    currentMinute: variables.currentMinute,
  });
}

export interface PendingCreateVariables extends AgendaProjectionClock {
  input: CreateActivityInput;
  /** The client-minted `act_` ULID this row will keep for the rest of its life. */
  activityId: string;
  /** Projection time, standing in for the server's `createdAt` until the `201` lands. */
  mintedAt: string;
}
