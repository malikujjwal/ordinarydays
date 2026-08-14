import { type Instant, type TimeZone, toWallDate, toWallTime } from '@od/shared/time';
import type { Activity, AgendaData, User } from '@od/shared/types';
import type { MutationKey, QueryClient } from '@tanstack/react-query';
import {
  type AgendaMutationTarget,
  type AgendaProjectionClock,
  applyCompletion,
  findAgendaItem,
  replaceAgendaItem,
} from '@/features/agenda/model/applyCompletion';
import { applyCreate } from '@/features/agenda/model/applyCreate';
import { applyReschedule } from '@/features/agenda/model/applyReschedule';
import { applySkip } from '@/features/agenda/model/applySkip';
import { activityKey } from '@/lib/queryKeys';

const AGENDA_KEY = ['agenda'] as const;

/**
 * Writes a server-confirmed activity into the cached agenda windows (P2-46).
 *
 * **The problem this solves.** The agenda is served from `GSI1`, and a global secondary index
 * is eventually consistent — a consistent read on one does not exist. Invalidating the agenda
 * after a write fires a refetch within tens of milliseconds, which races the index write and
 * frequently loses. The server answers `200` with pre-write data, the client caches it, and
 * nothing retries, so Today shows a stale day until something else invalidates. Measured on a
 * local create: `201` at +1922 ms, refetch issued at +1967 ms, and the row absent from a
 * response the API served correctly six seconds later.
 *
 * Invalidation alone therefore cannot be the mechanism that makes a write reach Today; it can
 * only be the reconciliation behind one. Completing and snoozing never had this bug precisely
 * because they project into the cache first and treat the refetch as confirmation.
 *
 * Everything here is projected from the **server's response**, so there is no rollback path
 * and no invented identifier: by the time this runs the write is durable and its canonical
 * shape is known. Each projection is idempotent, so a refetch that did win the race cannot
 * produce a duplicate row.
 */
export function projectActivityWrite(
  client: QueryClient,
  mutationKey: MutationKey | undefined,
  data: unknown,
  variables?: unknown,
): boolean {
  const name = Array.isArray(mutationKey) ? mutationKey[1] : undefined;
  const activity = activityFrom(data);
  if (activity === undefined) return false;

  const clock = agendaClock(client);

  if (name === 'create' || name === 'duplicate') {
    update(client, (agenda) => applyCreate(agenda, { activity, ...clock }));
    return true;
  }

  if (name === 'schedule') {
    const date = activity.schedule?.date ?? null;
    update(client, (agenda) => {
      const moved = applyReschedule(agenda, {
        activityId: activity.activityId,
        date,
        ...(activity.schedule?.time === undefined
          ? {}
          : { time: activity.schedule.time }),
        ...(activity.schedule?.endTime === undefined
          ? {}
          : { endTime: activity.schedule.endTime }),
        ...clock,
      });
      if (moved !== agenda) return moved;

      /**
       * **A row can also be rescheduled *into* a window it was never in.**
       *
       * `applyReschedule` moves a row the cached agenda already holds; asked about one it does
       * not, it correctly does nothing. But moving a plan from next Friday to today is exactly
       * that case — Today's cached window has never seen it — so the projection was a no-op and
       * Today only gained the row when something else happened to refetch. Reported as "it takes
       * some time to show up".
       *
       * `applyCreate` is the right fallback rather than a second insert path: it places a
       * server-confirmed Activity only when the destination date is inside this window, and it
       * is idempotent, so a refetch that won the race cannot double the row.
       */
      return applyCreate(agenda, { activity, ...clock });
    });
    return true;
  }

  /**
   * Completion, and its compensating undo, from **anywhere**.
   *
   * The agenda screen projects these itself before the request goes out, so Today has always
   * felt instant. The detail screen does not — and once the agenda stopped refetching on
   * invalidation, a completion recorded from a detail screen reached the server and never
   * reached Today, because a mounted tab has nothing to trigger a refetch. Plans looked
   * correct only because navigating to it remounts and refetches.
   *
   * Projecting here rather than in either screen means one behaviour for the row checkbox, the
   * swipe action, the passed-plan sheet, the detail button, and a mutation replayed from the
   * offline queue after a restart.
   */
  if (name === 'complete' || name === 'uncomplete' || name === 'skip') {
    /**
     * The **detail cache** as well as the agenda.
     *
     * Completing or undoing from a Today row never touched `['activity', id]`, and that query
     * has a 60-second stale time — so opening the detail screen after an undo showed the
     * activity still completed, sometimes for a full minute, and the completion button showed
     * the resolved state long after the row had gone back to normal. The server's response is
     * the activity, so there is nothing to derive.
     */
    client.setQueryData<{ activity: Activity }>(
      activityKey(activity.activityId),
      (previous) => (previous === undefined ? previous : { ...previous, activity }),
    );

    const occurrenceDate = occurrenceDateFrom(variables);
    const target = {
      activityId: activity.activityId,
      ...(occurrenceDate === undefined ? {} : { occurrenceDate }),
      ...clock,
    };

    if (name === 'skip') {
      update(client, (agenda) => applySkip(agenda, { ...target, skipped: true }));
      return true;
    }

    update(client, (agenda) =>
      applyCompletion(
        agenda,
        name === 'complete'
          ? { ...target, completed: true }
          : {
              ...target,
              completed: false,
              // The server's own word for where the row goes back to.
              restoredStatus:
                activity.schedule?.date === undefined ? 'saved' : 'scheduled',
            },
      ),
    );
    return true;
  }

  return false;
}

/**
 * The cached status of one occurrence, for a screen that cannot read it from the Activity.
 *
 * An `Occurrence` override never moves `ACT#/META` (`data-model.md` §4.5), so opening a
 * recurring activity's detail tells you the series is `scheduled` and nothing about the day you
 * are looking at. The agenda already carries the expanded occurrence and is already reconciled
 * by every completion path, so it is the one place the answer exists client-side. Absent when
 * no agenda window is cached — a cold deep link — and the caller falls back to unresolved.
 */
export function readOccurrenceStatus(
  client: QueryClient,
  target: AgendaMutationTarget,
): string | undefined {
  for (const [, agenda] of client.getQueriesData<AgendaData>({ queryKey: AGENDA_KEY })) {
    const found = agenda === undefined ? undefined : findAgendaItem(agenda, target);
    if (found !== undefined) return found.item.status;
  }
  return undefined;
}

/**
 * Projects a detail-screen completion before its request settles and returns a targeted
 * rollback. The rollback restores only the affected row in each cached agenda window, so an
 * unrelated agenda write made while the completion is in flight is never overwritten.
 */
export function projectOptimisticCompletion(
  client: QueryClient,
  variables: AgendaMutationTarget &
    ({ completed: true } | { completed: false; restoredStatus: 'saved' | 'scheduled' }),
): () => void {
  const clock = agendaClock(client);
  const snapshots = client
    .getQueriesData<AgendaData>({ queryKey: AGENDA_KEY })
    .map(([queryKey, agenda]) => ({
      queryKey,
      found: agenda === undefined ? undefined : findAgendaItem(agenda, variables),
    }));

  update(client, (agenda) => applyCompletion(agenda, { ...variables, ...clock }));

  return () => {
    for (const { queryKey, found } of snapshots) {
      client.setQueryData<AgendaData>(queryKey, (agenda) => {
        if (agenda === undefined || found === undefined) return agenda;
        return replaceAgendaItem(agenda, variables, found.item, found.sourceDate, clock);
      });
    }
  };
}

/** Occurrence scope travels in the request, not the response. */
function occurrenceDateFrom(variables: unknown): string | undefined {
  if (typeof variables !== 'object' || variables === null) return undefined;
  const input = (variables as { input?: unknown }).input;
  if (typeof input !== 'object' || input === null) return undefined;
  const date = (input as { occurrenceDate?: unknown }).occurrenceDate;
  return typeof date === 'string' ? date : undefined;
}

/** Both a bare Activity and a `{ activity }` envelope reach this from different endpoints. */
function activityFrom(data: unknown): Activity | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const candidate = 'activity' in data ? (data as { activity: unknown }).activity : data;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  return 'activityId' in candidate ? (candidate as Activity) : undefined;
}

function agendaClock(client: QueryClient): AgendaProjectionClock {
  const timezone = (client.getQueryData<User>(['me'])?.timezone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone) as TimeZone;
  const now = new Date().toISOString() as Instant;
  return {
    today: toWallDate(now, timezone),
    currentMinute: toWallTime(now, timezone),
  };
}

function update(client: QueryClient, project: (agenda: AgendaData) => AgendaData): void {
  client.setQueriesData<AgendaData>({ queryKey: AGENDA_KEY }, (agenda) =>
    agenda === undefined ? agenda : project(agenda),
  );
}
