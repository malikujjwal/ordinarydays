import { describeRecurrence, expandRecurrence } from '@od/shared/recurrence';
import type { CreateActivityInput } from '@od/shared/schemas';
import type { Activity, AgendaData, AgendaItem } from '@od/shared/types';
import { pendingActivityFromInput } from '@/lib/pendingActivity';
import {
  type AgendaProjectionClock,
  findAgendaItem,
  projectDay,
  replaceAgendaItem,
  uniqueItems,
} from './applyCompletion';

export interface CreateProjectionVariables extends AgendaProjectionClock {
  /** The window this cache entry covers, so a create outside it is left alone. */
  activity: Pick<
    Activity,
    'activityId' | 'type' | 'title' | 'schedule' | 'recurrence' | 'parentActivityId'
  >;
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
 * Places a newly-created Activity into an agenda window.
 *
 * **Why this exists (P2-46).** The agenda is served from `GSI1`, and a global secondary index
 * is eventually consistent — there is no such thing as a consistent read on one. Invalidating
 * the agenda on create fires a refetch within tens of milliseconds of the write, which races
 * the index and frequently loses: the server answers `200` with pre-write data, the client
 * caches that, and nothing retries. Today then shows a stale day until something else
 * invalidates it. Every layer is individually correct, which is why no unit test caught it and
 * why `create-activity.spec.ts` had been failing since Phase 1.
 *
 * A server-confirmed call projects the **201 response**. The pending entry point below first
 * builds an Activity from durable local input and calls the same projection, under the
 * permanent client-minted id. In either case the invalidation that follows is reconciliation
 * rather than the only source of truth.
 *
 * Idempotent: an activity the window already holds is left untouched unless `reconcile` asks
 * the canonical `201` to replace the provisional set, so neither path can double a row.
 */
export function applyCreate(
  agenda: AgendaData,
  variables: CreateProjectionVariables,
): AgendaData {
  const { activity } = variables;
  const date = activity.schedule?.date;

  if (activity.recurrence !== undefined && activity.schedule !== undefined) {
    return applyRecurringCreate(agenda, variables);
  }

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
 * Expands a newly-created series across this cache window.
 *
 * This is deliberately limited to **creates**. The user just supplied the only recurrence
 * segment, so the shared expansion engine has every input needed to project it exactly. An
 * edit to a server-known series may have occurrence history and overrides that are absent
 * from the create response; that path remains server-owned in `agendaCache.ts`.
 */
function applyRecurringCreate(
  agenda: AgendaData,
  variables: CreateProjectionVariables,
): AgendaData {
  const { activity } = variables;
  const recurrence = activity.recurrence;
  const schedule = activity.schedule;
  const dates = agenda.days.map((day) => day.date).sort();
  const from = dates[0];
  const to = dates.at(-1);
  if (
    recurrence === undefined ||
    schedule === undefined ||
    from === undefined ||
    to === undefined
  ) {
    return agenda;
  }

  if (
    findAgendaItem(agenda, { activityId: activity.activityId }) !== undefined &&
    variables.reconcile !== true
  ) {
    return agenda;
  }

  const occurrences = new Set(expandRecurrence(recurrence, from, to, schedule.timezone));
  const recurrenceDescription = describeRecurrence(recurrence, from);

  return {
    ...agenda,
    days: agenda.days.map((day) => {
      const items = uniqueItems(day).filter(
        (item) => item.activityId !== activity.activityId,
      );
      if (occurrences.has(day.date)) {
        const segment = [...recurrence.segments]
          .reverse()
          .find((candidate) => candidate.effectiveFrom <= day.date);
        const time = segment?.time ?? schedule.time;
        const endTime = segment?.endTime ?? schedule.endTime;
        items.unshift({
          activityId: activity.activityId,
          type: activity.type,
          title: activity.title,
          status: 'scheduled',
          ...(time === undefined ? {} : { time }),
          ...(endTime === undefined ? {} : { endTime }),
          isRecurring: true,
          recurrenceDescription,
          occurrenceDate: day.date,
          isSnoozed: false,
          hasCheckbox: activity.type === 'task',
          capabilities: { complete: true, skip: true, snooze: true },
          participantAvatars: [],
          participantCount: 0,
          ...(activity.parentActivityId === undefined
            ? {}
            : { parentActivityId: activity.parentActivityId }),
          isPast:
            day.date < variables.today ||
            (day.date === variables.today &&
              time !== undefined &&
              (endTime ?? time) <= variables.currentMinute),
        });
      }
      return projectDay(day, items, variables);
    }),
  };
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
  const provisional = pendingActivityFromInput(input, activityId, mintedAt);

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
