import { getAgenda } from '@od/shared/client';
import type { AgendaQuery } from '@od/shared/schemas';
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
import { apiClient } from '@/lib/apiClient';
import { type ActivityMutationTag, activityMutationKeys } from '@/lib/mutationKeys';
import { activityKey } from '@/lib/queryKeys';

const AGENDA_KEY = ['agenda'] as const;
const RECONCILE_DELAYS_MS = [0, 150, 400, 900, 1_800, 3_200] as const;
const pendingByClient = new WeakMap<QueryClient, Map<string, Map<string, string>>>();

type AgendaQueryKey = readonly [
  'agenda',
  AgendaQuery['from'],
  AgendaQuery['to'],
  AgendaQuery['tz'],
  AgendaQuery['include'] | null,
];

function keyId(key: readonly unknown[]): string {
  return JSON.stringify(key);
}

function observed(data: AgendaData, activityId: string, version: string): boolean {
  return (
    data.projectionVersions?.some(
      (entry) => entry.activityId === activityId && entry.version >= version,
    ) === true
  );
}

/** A deleted Activity can never emit the projection version an older reconciliation awaits. */
function clearPendingActivity(client: QueryClient, activityId: string): void {
  const windows = pendingByClient.get(client);
  if (windows === undefined) return;
  for (const [windowId, pending] of windows) {
    pending.delete(activityId);
    if (pending.size === 0) windows.delete(windowId);
  }
  if (windows.size === 0) pendingByClient.delete(client);
}

/** Prevents a stale GSI body from replacing a projection a successful write already proved. */
export function guardAgendaResponse(
  client: QueryClient,
  queryKey: readonly unknown[],
  incoming: AgendaData,
): AgendaData {
  const windows = pendingByClient.get(client);
  const pending = windows?.get(keyId(queryKey));
  if (pending === undefined) return incoming;

  for (const [activityId, version] of pending) {
    if (!observed(incoming, activityId, version)) {
      return client.getQueryData<AgendaData>(queryKey) ?? incoming;
    }
  }
  windows?.delete(keyId(queryKey));
  return incoming;
}

export interface AgendaReconciliationVersion {
  readonly activityId: string;
  readonly version: string;
  /** A one-off outside a cached window is authoritatively absent and needs no GSI proof. */
  readonly relevantDate?: string;
}

type AgendaLoader = (query: AgendaQuery) => Promise<AgendaData>;

/** Bounded, version-aware reconciliation for every mounted/cached agenda window. */
export async function reconcileAgendaProjection(
  client: QueryClient,
  expected: AgendaReconciliationVersion,
  load: AgendaLoader = (query) => getAgenda(apiClient, query, undefined, true),
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  const keys = client
    .getQueriesData<AgendaData>({ queryKey: AGENDA_KEY })
    .map(([key]) => key as AgendaQueryKey)
    .filter(
      ([, from, to]) =>
        expected.relevantDate === undefined ||
        (expected.relevantDate >= from && expected.relevantDate <= to),
    );
  if (keys.length === 0) return true;

  let windows = pendingByClient.get(client);
  if (windows === undefined) {
    windows = new Map();
    pendingByClient.set(client, windows);
  }
  for (const key of keys) {
    const pending = windows.get(keyId(key)) ?? new Map<string, string>();
    const current = pending.get(expected.activityId);
    if (current === undefined || current < expected.version) {
      pending.set(expected.activityId, expected.version);
    }
    windows.set(keyId(key), pending);
  }

  const remaining = new Set(keys.map(keyId));
  for (const delay of RECONCILE_DELAYS_MS) {
    if (delay > 0) await wait(delay);
    await Promise.all(
      keys
        .filter((key) => remaining.has(keyId(key)))
        .map(async (key) => {
          try {
            const [, from, to, tz, include] = key;
            const incoming = await load({
              from,
              to,
              tz,
              ...(include === null ? {} : { include }),
            });
            const guarded = guardAgendaResponse(client, key, incoming);
            if (guarded === incoming) {
              client.setQueryData(key, incoming);
              remaining.delete(keyId(key));
            }
          } catch {
            // A bounded retry remains; ordinary query error handling owns the eventual UI.
          }
        }),
    );
    if (remaining.size === 0) return true;
  }
  return false;
}

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
    if (isRecurrenceWrite(variables)) {
      if (typeof activity.updatedAt === 'string') {
        /**
         * The server has accepted a new recurrence rule, so every cached expansion of the
         * previous rule is now known to be stale. Remove those rows immediately instead of
         * displaying the old frequency during GSI convergence. We deliberately do not invent
         * replacement occurrences here; the versioned reconciler below installs only the
         * canonical expansion returned by the agenda endpoint.
         */
        update(client, (agenda) =>
          applyDelete(agenda, { activityId: activity.activityId, ...clock }),
        );
        void reconcileAgendaProjection(client, {
          activityId: activity.activityId,
          version: activity.updatedAt,
        });
      }
      return true;
    }
    update(client, (agenda) => applyPatch(agenda, { activity, ...clock }));
    return true;
  }

  /**
   * Conversion has a complete server answer: remove every generated occurrence, then place
   * the surviving one-off from the Activity schedule returned by the atomic operation.
   */
  if (tag === 'convert-recurrence') {
    update(client, (agenda) =>
      applyCreate(applyDelete(agenda, { activityId: activity.activityId, ...clock }), {
        activity,
        ...clock,
      }),
    );
    if (typeof activity.updatedAt === 'string') {
      void reconcileAgendaProjection(client, {
        activityId: activity.activityId,
        version: activity.updatedAt,
        ...(activity.schedule?.date === undefined
          ? {}
          : { relevantDate: activity.schedule.date }),
      });
    }
    return true;
  }

  /**
   * A delete takes the row with it. The detail screen leaves on success, but the Today tab it
   * returns to is already mounted and refetches nothing — so the deleted row stayed visible.
   */
  if (tag === 'delete') {
    clearPendingActivity(client, activity.activityId);
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

/** Whether this PATCH changes series projection rather than ordinary row text. */
function isRecurrenceWrite(variables: unknown): boolean {
  const input = inputOf(variables);
  return input !== undefined && Object.hasOwn(input, 'recurrence');
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
