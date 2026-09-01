import {
  emptyPlansStore,
  getPlans,
  mergePlansResponse,
  type PlansDateStore,
} from '@od/shared/client';
import { addWallDays } from '@od/shared/recurrence';
import type { NeedsDateItem } from '@od/shared/schemas';
import type { WallDate } from '@od/shared/time';
import type { AgendaItem } from '@od/shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '@/lib/apiClient';
import { describeApiFailure } from '@/lib/apiFailure';
import { activityMutationKeys, listMutationKeys } from '@/lib/mutationKeys';
import { usePlanActivityFloor } from '@/stores/planActivityFloor';
import {
  applyPlansCreate,
  applyPlansRemove,
  createdActivityFrom,
} from '../model/plansApply';

/**
 * The three-stage Plans read (P3-36): one `GET /v1/plans?mode=initial` renders the screen,
 * and each stage continues through its own arm — `upcoming_window` from the returned
 * `nextFrom` sentinel, `past_cursor` for older history. A continuation response omits the
 * inactive stages, so merging one can never replace another stage with an empty array
 * (`api-contract.md` §2.2a); the shared date store owns that merge discipline.
 *
 * Pull-to-refresh is `refetch`: all three stages in the one request, per §P3-36. The store
 * is rebuilt from empty on refresh so a deleted plan cannot survive as a stale date entry.
 *
 * Platform note, recorded rather than hidden: this hook speaks HTTP on both worlds. The
 * endpoint's needs-date and past stages have no local SQLite projection (ADR-057 covers the
 * agenda, not `#P`), so the rebuilt Plans tab is online-first everywhere; offline it shows
 * its error state with Retry while Today's local agenda remains untouched.
 */

/** One bounded window request spans at most 62 inclusive dates (`MAX_AGENDA_DAYS`). */
const WINDOW_DAYS = 62;

/**
 * The needs-a-date row: an ordinary `AgendaItem` plus the stage's three extra fields.
 *
 * Structurally this is the wire schema's `NeedsDateItem`; it is restated over the domain
 * `AgendaItem` because Zod infers optionals as `?: T | undefined` while the domain types are
 * `exactOptionalPropertyTypes`-strict. {@link installNeedsDate} is the one place the wire
 * shape crosses into this one, and carries the boundary annotation §1.2 reserves for a
 * schema-validated response.
 */
export type NeedsDateRowData = AgendaItem & {
  readonly lastActivityAt: string;
  readonly suggestionCount: number;
  readonly rsvpSummary: NeedsDateItem['rsvpSummary'];
};

/** The §1.2 boundary: `getPlans` has already schema-validated these rows. */
const installNeedsDate = (rows: readonly NeedsDateItem[]) =>
  rows as readonly NeedsDateRowData[];

export interface UpcomingWindowState {
  readonly from: WallDate;
  readonly through: WallDate;
  readonly nextFrom: WallDate | null;
}

export interface PlansView {
  readonly status: 'pending' | 'success' | 'error';
  readonly needsDate: readonly NeedsDateRowData[];
  readonly store: PlansDateStore;
  readonly upcomingWindow: UpcomingWindowState | undefined;
  /** `undefined` once the ordinary older-history pagination is exhausted. */
  readonly pastCursor: string | undefined;
  readonly isLoadingMoreUpcoming: boolean;
  readonly isLoadingMorePast: boolean;
  readonly isRefreshing: boolean;
  readonly loadMoreUpcoming: () => void;
  readonly loadMorePast: () => void;
  readonly refetch: () => void;
  /**
   * Synchronous completion projection for the tap handler — the cross-platform channel
   * (native has no MutationCache for the subscription to ride). Call it only after the
   * action layer's guards accept the write; the web lifecycle events reconcile and revert.
   */
  readonly projectCompletion: (
    item: Pick<AgendaItem, 'activityId' | 'occurrenceDate'>,
    checked: boolean,
  ) => void;
  /** True while the upcoming arm's last window request failed; gates the auto-advance. */
  readonly upcomingStalled: boolean;
  readonly message?: string;
  readonly requestId?: string;
}

const describe = (error: unknown) => describeApiFailure(error, "Couldn't load this.");

/**
 * The mutation keys whose success creates an Activity this tab must project: ordinary
 * creates, duplicates, and the `Plan this item` bridge — a `list`-scoped key that creates a
 * Plan (`changesActivityLists` admits it for the same reason). Compared against the exported
 * constants, never literals: `mutationKeys.ts` owns these wire tags.
 */
const CREATE_KEYS: readonly (readonly string[])[] = [
  activityMutationKeys.create,
  activityMutationKeys.duplicate,
  listMutationKeys.itemSchedule,
];

const keyMatches = (key: readonly unknown[], candidate: readonly string[]) =>
  key.length === candidate.length && candidate.every((part, i) => key[i] === part);

/**
 * The write kinds this store projects, and the boundary of the list. It deliberately covers
 * fewer keys than `lib/agendaCache.ts`'s `projectActivityWrite`: skip/snooze/patch touch
 * fields the next natural refetch reconciles harmlessly, while creates, schedules, deletes
 * and completions change **which row is where** — the states a user stares at while the GSI
 * is still behind. A new write kind that moves rows must be added in both places.
 */
interface CompletionSnapshot {
  readonly activityId: string;
  readonly occurrenceDate: string | undefined;
  readonly prior: AgendaItem['status'];
}

const NEGATIVE_OUTCOMES = new Set(['didnt_happen', 'didnt_go']);

interface PlansState {
  readonly status: 'pending' | 'success' | 'error';
  readonly needsDate: readonly NeedsDateRowData[];
  readonly store: PlansDateStore;
  readonly upcomingWindow: UpcomingWindowState | undefined;
  readonly pastCursor: string | undefined;
  /** Cleared by any later successful load, so a banner never outlives its cause. */
  readonly failure: { message: string; requestId?: string } | undefined;
  /**
   * Whether the **upcoming** arm specifically has failed. Kept apart from `failure` because
   * a Past-page failure must not suppress Upcoming's auto-advance or its advancing state —
   * one shared flag turned a Past 500 into a false `No upcoming plans`.
   */
  readonly upcomingStalled: boolean;
}

const EMPTY: PlansState = {
  status: 'pending',
  needsDate: [],
  store: emptyPlansStore,
  upcomingWindow: undefined,
  pastCursor: undefined,
  failure: undefined,
  upcomingStalled: false,
};

export function usePlans(
  timezone: string,
  today: WallDate,
  /** `HH:mm` in the viewer's zone, for the projected rows' `isPast` (§4.3-injected). */
  currentMinute: string,
): PlansView {
  const [state, setState] = useState<PlansState>(EMPTY);
  /** Mirror for callbacks that must read current rows synchronously (snapshot capture). */
  const stateRef = useRef(state);
  stateRef.current = state;
  const [refreshing, setRefreshing] = useState(false);
  const [loadingUpcoming, setLoadingUpcoming] = useState(false);
  const [loadingPast, setLoadingPast] = useState(false);
  /** Drops a stale response after a newer refresh restarted the store. */
  const generation = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const initial = useCallback(async () => {
    const attempt = ++generation.current;
    try {
      const data = await getPlans(apiClient, { mode: 'initial', tz: timezone });
      if (!mounted.current || generation.current !== attempt) return;
      setState({
        status: 'success',
        needsDate: installNeedsDate(data.needsDate),
        // From empty, not from the previous store: the initial arm is the whole screen, and
        // rebuilding is what lets a deleted plan disappear from a date the arm covers.
        store: mergePlansResponse(emptyPlansStore, data),
        upcomingWindow: {
          from: data.upcomingWindow.from as WallDate,
          through: data.upcomingWindow.through as WallDate,
          nextFrom: data.upcomingWindow.nextFrom as WallDate | null,
        },
        pastCursor: data.pastPage.nextCursor,
        failure: undefined,
        upcomingStalled: false,
      });
    } catch (error) {
      if (!mounted.current || generation.current !== attempt) return;
      setState((current) => ({
        ...current,
        status: current.status === 'success' ? 'success' : 'error',
        failure: describe(error),
      }));
    }
  }, [timezone]);

  useEffect(() => {
    setState(EMPTY);
    void initial();
  }, [initial]);

  const refetch = useCallback(() => {
    setRefreshing(true);
    void initial().finally(() => {
      if (mounted.current) setRefreshing(false);
    });
  }, [initial]);

  /**
   * Creates land here by **projection of the 201 response**, not by refetch — `/v1/plans`'
   * dated stages read GSI1, and a refetch fired milliseconds after the write usually answers
   * with pre-write data (the P2-46 lesson the agenda cache already encodes). Compose closes
   * itself on save, so this listens on the process-wide mutation cache the way the agenda's
   * projection does, rather than on any component that is about to unmount.
   */
  const queryClient = useQueryClient();
  /** The caller's injected clock (§4.3), read through refs so a tick is not a resubscribe. */
  const clockRef = useRef({ today, currentMinute });
  clockRef.current = { today, currentMinute };
  /**
   * Snapshots taken when a completion-family mutation projects, keyed by the mutation's own
   * id, so `error` restores the **exact** prior statuses — a skipped occurrence goes back to
   * skipped, never to a fabricated `scheduled`.
   */
  const completionSnapshots = useRef(new Map<number, CompletionSnapshot[]>());

  /**
   * Sets one row's status, returning the prior statuses it changed. Locate-first: the
   * common case is a tick for a row this store does not hold (Today's checkbox with Plans
   * mounted behind it), and that case allocates nothing.
   */
  const patchStatus = useCallback(
    (
      activityId: string,
      occurrenceDate: string | undefined,
      status: AgendaItem['status'],
    ): CompletionSnapshot[] => {
      /**
       * Snapshots come from the mirror, synchronously — a `setState` updater runs at
       * render time, after this function has already returned. The mirror can lag one
       * queued update, which is exactly right for the web double-projection: the direct
       * tap projection queues first, and the `pending` event's snapshot still captures the
       * row's true pre-tap status.
       */
      const taken: CompletionSnapshot[] = [];
      for (const rows of stateRef.current.store.byDate.values()) {
        for (const row of rows) {
          if (
            row.activityId === activityId &&
            row.occurrenceDate === occurrenceDate &&
            row.status !== status
          ) {
            taken.push({ activityId, occurrenceDate, prior: row.status });
          }
        }
      }
      setState((current) => {
        const hits: WallDate[] = [];
        for (const [date, rows] of current.store.byDate) {
          if (
            rows.some(
              (row) =>
                row.activityId === activityId &&
                row.occurrenceDate === occurrenceDate &&
                row.status !== status,
            )
          ) {
            hits.push(date);
          }
        }
        if (hits.length === 0) return current;
        const byDate = new Map(current.store.byDate);
        for (const date of hits) {
          const rows = byDate.get(date) ?? [];
          byDate.set(
            date,
            rows.map((row) =>
              row.activityId === activityId && row.occurrenceDate === occurrenceDate
                ? { ...row, status }
                : row,
            ),
          );
        }
        return { ...current, store: { ...current.store, byDate } };
      });
      return taken;
    },
    [],
  );

  /**
   * The synchronous, cross-platform completion projection. `PlansScreen` calls it from the
   * tap handler after the action layer's guards accept the write — native has no
   * `MutationCache`, so the subscription below cannot be the only channel; on web the
   * subsequent `pending` event patches the same value and no-ops.
   */
  const projectCompletion = useCallback(
    (item: Pick<AgendaItem, 'activityId' | 'occurrenceDate'>, checked: boolean) => {
      const status: AgendaItem['status'] =
        item.occurrenceDate === undefined
          ? checked
            ? 'completed'
            : 'scheduled'
          : checked
            ? 'completed_occurrence'
            : 'scheduled';
      patchStatus(item.activityId, item.occurrenceDate, status);
    },
    [patchStatus],
  );

  useEffect(() => {
    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== 'updated') return;
      const key = event.mutation.options.mutationKey;
      if (!Array.isArray(key)) return;

      // Creates: project the 201's authoritative Activity into the stages. A date beyond
      // the loaded window also extends the render window to reach it — otherwise the row
      // is invisible, the tab still claims emptiness, and an auto-advance can replace the
      // projection with a pre-write GSI answer.
      if (
        event.action.type === 'success' &&
        CREATE_KEYS.some((candidate) => keyMatches(key, candidate))
      ) {
        const activity = createdActivityFrom(event.action.data);
        if (activity === undefined) return;
        setState((current) => {
          if (current.status !== 'success') return current;
          const projected = applyPlansCreate(current, activity, clockRef.current);
          if (projected === undefined) return current;
          const date = activity.schedule?.date;
          const window = current.upcomingWindow;
          /**
           * A date beyond the loaded window extends `through` so the row renders at once
           * and the tab cannot claim an emptiness it disproved itself. Known trade-off,
           * recorded: dates between the old and new `through` are not exhausted, so a gap
           * line drawn across them over-claims until the windows walk forward — accepted
           * against the alternative of the user's own create being invisible.
           */
          const upcomingWindow =
            date !== undefined && window !== undefined && date > window.through
              ? { ...window, through: date as WallDate }
              : window;
          return { ...current, ...projected, upcomingWindow };
        });
        return;
      }

      // Reschedules and deletes move rows between dates and stages: remove every trace,
      // then (for a schedule) re-insert from the authoritative response. Occurrence-scoped
      // reschedules of a series are left to reconciliation — the response cannot say which
      // expanded occurrences a window holds.
      if (event.action.type === 'success') {
        const isSchedule = keyMatches(key, activityMutationKeys.schedule);
        const isDelete = keyMatches(key, activityMutationKeys.delete);
        if (isSchedule || isDelete) {
          const variables = event.mutation.state.variables as
            | { activityId?: unknown }
            | undefined;
          const activityId = variables?.activityId;
          if (typeof activityId !== 'string') return;
          const activity = isSchedule
            ? createdActivityFrom(event.action.data)
            : undefined;
          setState((current) => {
            if (current.status !== 'success') return current;
            if (
              isSchedule &&
              (activity === undefined || activity.recurrence !== undefined)
            ) {
              return current;
            }
            const removed = applyPlansRemove(current, activityId) ?? current;
            if (activity === undefined) {
              return removed === current ? current : { ...current, ...removed };
            }
            const inserted = applyPlansCreate(removed, activity, clockRef.current);
            const next = inserted ?? removed;
            if (next === current) return current;
            const date = activity.schedule?.date;
            const window = current.upcomingWindow;
            const upcomingWindow =
              date !== undefined && window !== undefined && date > window.through
                ? { ...window, through: date as WallDate }
                : window;
            return { ...current, ...next, upcomingWindow };
          });
          return;
        }
      }

      /**
       * Completions: the same seam projects the lifecycle. `pending` projects the target
       * status (a negative passed-plan outcome rides the complete key and projects
       * **skipped**, not completed), `error` restores the exact snapshots, and a successful
       * `uncomplete` — the toast's Undo — is itself the un-projection. Guarded rows never
       * reach a mutation, so a refused tick projects nothing through this channel.
       */
      const isComplete = keyMatches(key, activityMutationKeys.complete);
      const isUncomplete = keyMatches(key, activityMutationKeys.uncomplete);
      if (!isComplete && !isUncomplete) return;
      const variables = event.mutation.state.variables as
        | {
            activityId?: unknown;
            input?: { occurrenceDate?: unknown; outcome?: unknown };
          }
        | undefined;
      const activityId = variables?.activityId;
      if (typeof activityId !== 'string') return;
      const occurrenceDate =
        typeof variables?.input?.occurrenceDate === 'string'
          ? variables.input.occurrenceDate
          : undefined;
      if (event.action.type === 'pending') {
        const negative =
          isComplete &&
          typeof variables?.input?.outcome === 'string' &&
          NEGATIVE_OUTCOMES.has(variables.input.outcome);
        const status: AgendaItem['status'] = isUncomplete
          ? 'scheduled'
          : occurrenceDate === undefined
            ? negative
              ? 'skipped'
              : 'completed'
            : negative
              ? 'skipped_occurrence'
              : 'completed_occurrence';
        const taken = patchStatus(activityId, occurrenceDate, status);
        if (taken.length > 0) {
          completionSnapshots.current.set(event.mutation.mutationId, taken);
        }
      } else if (event.action.type === 'error') {
        const taken = completionSnapshots.current.get(event.mutation.mutationId);
        completionSnapshots.current.delete(event.mutation.mutationId);
        for (const snapshot of taken ?? []) {
          patchStatus(snapshot.activityId, snapshot.occurrenceDate, snapshot.prior);
        }
      } else if (event.action.type === 'success') {
        completionSnapshots.current.delete(event.mutation.mutationId);
      }
    });
  }, [queryClient, patchStatus]);

  const loadMoreUpcoming = useCallback(() => {
    const window = state.upcomingWindow;
    if (window === undefined || window.nextFrom === null || loadingUpcoming) return;
    const from = window.nextFrom;
    const attempt = generation.current;
    setLoadingUpcoming(true);
    void getPlans(apiClient, {
      mode: 'upcoming_window',
      tz: timezone,
      upcomingFrom: from,
      upcomingTo: addWallDays(from, WINDOW_DAYS - 1) as WallDate,
    })
      .then((data) => {
        if (!mounted.current || generation.current !== attempt) return;
        setState((current) => {
          /**
           * Monotonic: a projection may have extended `through` past this response's window
           * (a create landing months out); letting the response walk it backwards would
           * filter the just-created row out of the stage it was shown in seconds ago.
           */
          const responseThrough = data.upcomingWindow.through as WallDate;
          const held = current.upcomingWindow?.through;
          return {
            ...current,
            store: mergePlansResponse(current.store, data),
            upcomingWindow: {
              from:
                current.upcomingWindow?.from ?? (data.upcomingWindow.from as WallDate),
              through:
                held !== undefined && held > responseThrough ? held : responseThrough,
              nextFrom: data.upcomingWindow.nextFrom as WallDate | null,
            },
            failure: undefined,
            upcomingStalled: false,
          };
        });
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        setState((current) => ({
          ...current,
          failure: describe(error),
          upcomingStalled: true,
        }));
      })
      .finally(() => {
        if (mounted.current) setLoadingUpcoming(false);
      });
  }, [state.upcomingWindow, loadingUpcoming, timezone]);

  const loadMorePast = useCallback(() => {
    const cursor = state.pastCursor;
    if (cursor === undefined || loadingPast) return;
    const attempt = generation.current;
    setLoadingPast(true);
    void getPlans(apiClient, { mode: 'past_cursor', tz: timezone, cursor })
      .then((data) => {
        if (!mounted.current || generation.current !== attempt) return;
        setState((current) =>
          // The cursor may have been rebuilt by a refresh while this page was in flight.
          current.pastCursor !== cursor
            ? current
            : {
                ...current,
                store: mergePlansResponse(current.store, data),
                pastCursor: data.pastPage.nextCursor,
                failure: undefined,
              },
        );
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        setState((current) => ({ ...current, failure: describe(error) }));
      })
      .finally(() => {
        if (mounted.current) setLoadingPast(false);
      });
  }, [state.pastCursor, loadingPast, timezone]);

  /**
   * The §P3-40 monotonic merge: `#P` sorts on `lastActivityAt` and is read back through an
   * eventually consistent GSI, so a refetch right after posting an update can answer with a
   * projection older than the write. Each row's value is clamped to the newest authoritative
   * one the client has seen (the floor the POST response raised) and the stage re-sorted, so
   * a stale page cannot move a just-touched row back down. A converged page simply matches.
   *
   * When no floor changes anything, the stage is **exactly the server's order, untouched** —
   * §1.3.2's prohibition on client-side reordering, which P3-36 pins in a test. The sort runs
   * only while the client holds an authoritative value newer than the projection, because
   * that is the one moment the server's order is provably behind the order it defines.
   */
  const floors = usePlanActivityFloor((s) => s.floors);
  const needsDate = useMemo(() => {
    let changed = false;
    const clamped = state.needsDate.map((row) => {
      const floor = floors[row.activityId];
      if (floor === undefined || floor <= row.lastActivityAt) return row;
      changed = true;
      return { ...row, lastActivityAt: floor };
    });
    if (!changed) return state.needsDate;
    return clamped.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }, [state.needsDate, floors]);

  return {
    status: state.status,
    needsDate,
    store: state.store,
    upcomingWindow: state.upcomingWindow,
    pastCursor: state.pastCursor,
    isLoadingMoreUpcoming: loadingUpcoming,
    isLoadingMorePast: loadingPast,
    isRefreshing: refreshing,
    loadMoreUpcoming,
    loadMorePast,
    refetch,
    projectCompletion,
    upcomingStalled: state.upcomingStalled,
    ...(state.failure === undefined
      ? {}
      : {
          message: state.failure.message,
          ...(state.failure.requestId === undefined
            ? {}
            : { requestId: state.failure.requestId }),
        }),
  };
}
