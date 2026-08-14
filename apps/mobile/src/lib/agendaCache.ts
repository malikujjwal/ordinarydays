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
import { applyDelete } from '@/features/agenda/model/applyDelete';
import { applyPatch } from '@/features/agenda/model/applyPatch';
import { applyReschedule } from '@/features/agenda/model/applyReschedule';
import { applySkip } from '@/features/agenda/model/applySkip';
import { type ActivityMutationTag, activityMutationKeys } from '@/lib/mutationKeys';
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
  const tag = activityMutationTag(mutationKey);
  if (tag === undefined) return false;
  const activity = activityFrom(data);
  if (activity === undefined) return false;

  const clock = agendaClock(client);

  if (tag === 'create' || tag === 'duplicate') {
    update(client, (agenda) => applyCreate(agenda, { activity, ...clock }));
    return true;
  }

  /**
   * A patch changes what the row *says* — its title, its type, whether it repeats — without
   * moving it. Unclaimed, it fell through to `refreshActivityLists`, which marks the agenda
   * stale with `refetchType: 'none'`; so nothing projected and nothing refetched, and Today
   * kept the pre-patch row for up to a minute. See `applyPatch` for what is and is not
   * derivable here.
   */
  if (tag === 'patch') {
    update(client, (agenda) => applyPatch(agenda, { activity, ...clock }));
    return true;
  }

  /**
   * A delete takes the row with it. The detail screen leaves on success, but the Today tab it
   * returns to is already mounted and refetches nothing — so the deleted row stayed visible.
   */
  if (tag === 'delete') {
    update(client, (agenda) =>
      applyDelete(agenda, { activityId: activity.activityId, ...clock }),
    );
    return true;
  }

  /**
   * **Deliberately unprojected**, and the exhaustiveness check below is what makes that a
   * decision rather than an omission.
   *
   * `snooze`/`unsnooze` are reachable only from the agenda screen, which projects them itself
   * through `applySnooze` before the request goes out — projecting again here would be a second
   * write of the same truth. Reminder writes change no list and no agenda window at all, which
   * is why `changesActivityLists` already excludes them.
   */
  if (
    tag === 'snooze' ||
    tag === 'unsnooze' ||
    tag === 'reminder-create' ||
    tag === 'reminder-delete'
  ) {
    return false;
  }

  /**
   * **An occurrence reschedule moves one day, and reads its target from the request.**
   *
   * `scheduleOccurrence` writes an `Occurrence` override and leaves `ACT#/META` alone, so the
   * response still carries the *series anchor* — projecting from it would move the row to the
   * wrong day at the wrong time. The new date and time exist only in what was sent.
   *
   * Scope also has to travel: `applyReschedule` matches `activityId` **and** `occurrenceDate`,
   * and passing none matched no row of a series at all. The write then fell through to the
   * `applyCreate` fallback below, which inserted a second row for an activity the window
   * already held — a duplicated task on Today, reachable as soon as the detail screen began
   * sending occurrence scope.
   */
  if (tag === 'schedule' && occurrenceDateFrom(variables) !== undefined) {
    const requested = scheduleRequestFrom(variables);
    const occurrenceDate = occurrenceDateFrom(variables);
    if (requested !== undefined && occurrenceDate !== undefined) {
      update(client, (agenda) =>
        applyReschedule(agenda, {
          activityId: activity.activityId,
          occurrenceDate,
          date: requested.date,
          ...(requested.time === undefined ? {} : { time: requested.time }),
          ...(requested.endTime === undefined ? {} : { endTime: requested.endTime }),
          ...clock,
        }),
      );
    }
    return true;
  }

  if (tag === 'schedule') {
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
  if (tag === 'complete' || tag === 'uncomplete' || tag === 'skip') {
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

    if (tag === 'skip') {
      update(client, (agenda) => applySkip(agenda, { ...target, skipped: true }));
      return true;
    }

    update(client, (agenda) =>
      applyCompletion(
        agenda,
        tag === 'complete'
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

  /**
   * **The guard that makes this list exhaustive.**
   *
   * Every branch above narrows `tag`, so by here it is `never` — and adding a key to
   * `activityMutationKeys` widens `ActivityMutationTag`, breaks that assignment, and fails
   * `pnpm typecheck` until the new write says what it does to the cached agenda. Before this,
   * an unhandled key fell silently to `return false` while `changesActivityLists` still opted
   * it into `refreshActivityLists` — stale-marked with `refetchType: 'none'` and nothing to
   * correct it. That is how `patch` and `delete` shipped unprojected, and why the failure was a
   * quiet wrong screen rather than an error.
   */
  const unhandled: never = tag;
  return unhandled;
}

/** Narrows a `MutationKey` to the activity tags this projector is required to be total over. */
function activityMutationTag(
  mutationKey: MutationKey | undefined,
): ActivityMutationTag | undefined {
  if (!Array.isArray(mutationKey)) return undefined;
  const [scope, tag] = mutationKey as readonly unknown[];
  if (scope !== 'activity' || typeof tag !== 'string') return undefined;
  return ACTIVITY_MUTATION_TAGS.has(tag) ? (tag as ActivityMutationTag) : undefined;
}

const ACTIVITY_MUTATION_TAGS: ReadonlySet<string> = new Set(
  Object.values(activityMutationKeys).map(([, tag]) => tag),
);

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
 * The occurrence of a series this client can honestly say the user is looking at.
 *
 * **Not the series anchor.** An earlier version of the detail screen fell back to
 * `activity.schedule.date`, which is where the series *starts* — completing from Plans then
 * wrote an override for a day months back while the row the user meant never moved. This reads
 * the agenda instead, which holds occurrences the **server** expanded, so nothing is invented:
 * today's if the cache has it, otherwise the next one, otherwise the most recent past one.
 *
 * Absent when no agenda window is cached — a cold deep link — and the caller then offers no
 * completion control at all, which is the honest answer until P2-47 says what a series screen
 * should do.
 */
export function readOccurrenceDate(
  client: QueryClient,
  activityId: string,
  today: string,
): string | undefined {
  const dates = new Set<string>();
  for (const [, agenda] of client.getQueriesData<AgendaData>({ queryKey: AGENDA_KEY })) {
    for (const day of agenda?.days ?? []) {
      for (const item of [...day.schedule, ...day.anytime, ...day.earlier]) {
        if (item.activityId === activityId && item.occurrenceDate !== undefined) {
          dates.add(item.occurrenceDate);
        }
      }
    }
  }

  if (dates.has(today)) return today;
  const sorted = [...dates].sort();
  return sorted.find((date) => date >= today) ?? sorted.at(-1);
}

/**
 * The schedule **one occurrence** is actually on, which is not the series' schedule.
 *
 * An `Occurrence` override never moves `ACT#/META` (`data-model.md` §4.5), so an activity
 * whose Thursday was retimed still reports the series time on its own record. The detail
 * screen read exactly that and showed the series value back to the user after they had
 * changed the day in front of them — an invitation to "correct" it again, which writes a
 * second override.
 *
 * The agenda holds the answer already: `mergeNominal` resolves an override into the row's
 * `time`, and the day bucket the row sits in is its effective date, including a cross-day
 * move where the row's own `occurrenceDate` is the *source* day. Absent when no window is
 * cached, and the caller falls back to the series schedule.
 */
export function readOccurrenceSchedule(
  client: QueryClient,
  target: AgendaMutationTarget,
): { date: string; time?: string; endTime?: string } | undefined {
  for (const [, agenda] of client.getQueriesData<AgendaData>({ queryKey: AGENDA_KEY })) {
    const found = agenda === undefined ? undefined : findAgendaItem(agenda, target);
    if (found === undefined) continue;
    return {
      date: found.sourceDate,
      ...(found.item.time === undefined ? {} : { time: found.item.time }),
      ...(found.item.endTime === undefined ? {} : { endTime: found.item.endTime }),
    };
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

/**
 * The date and time a schedule write asked for.
 *
 * Read from the request for the same reason occurrence scope is: an occurrence override never
 * moves `ACT#/META`, so the response describes the series, not the day that just moved.
 */
function scheduleRequestFrom(
  variables: unknown,
): { date: string | null; time?: string; endTime?: string } | undefined {
  const input = inputOf(variables);
  if (input === undefined) return undefined;
  const { date, time, endTime } = input as {
    date?: unknown;
    time?: unknown;
    endTime?: unknown;
  };
  if (date !== null && typeof date !== 'string') return undefined;
  return {
    date,
    ...(typeof time === 'string' ? { time } : {}),
    ...(typeof endTime === 'string' ? { endTime } : {}),
  };
}

/** Occurrence scope travels in the request, not the response. */
function occurrenceDateFrom(variables: unknown): string | undefined {
  const input = inputOf(variables);
  if (input === undefined) return undefined;
  const date = (input as { occurrenceDate?: unknown }).occurrenceDate;
  return typeof date === 'string' ? date : undefined;
}

/** The `input` of a mutation's variables, at the `unknown` boundary these callers sit on. */
function inputOf(variables: unknown): object | undefined {
  if (typeof variables !== 'object' || variables === null) return undefined;
  const input = (variables as { input?: unknown }).input;
  return typeof input === 'object' && input !== null ? input : undefined;
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
