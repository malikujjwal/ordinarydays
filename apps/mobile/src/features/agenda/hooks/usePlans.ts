import {
  emptyPlansStore,
  getPlans,
  mergePlansResponse,
  type PlansDateStore,
} from '@od/shared/client';
import { addWallDays } from '@od/shared/recurrence';
import type { WallDate } from '@od/shared/time';
import type { AgendaItem } from '@od/shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '@/lib/apiClient';
import { describeApiFailure } from '@/lib/apiFailure';
import { activityMutationKeys, listMutationKeys } from '@/lib/mutationKeys';
import { usePlanActivityFloor } from '@/stores/planActivityFloor';
import { applyPlansCreate, createdActivityFrom } from '../model/plansApply';
import type { RsvpSummaryGroups } from '../model/rsvpSummary';

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

/** The needs-a-date row: an ordinary `AgendaItem` plus the stage's three extra fields. */
export type NeedsDateRowData = AgendaItem & {
  readonly lastActivityAt: string;
  readonly suggestionCount: number;
  readonly rsvpSummary: RsvpSummaryGroups;
};

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

interface PlansState {
  readonly status: 'pending' | 'success' | 'error';
  readonly needsDate: readonly NeedsDateRowData[];
  readonly store: PlansDateStore;
  readonly upcomingWindow: UpcomingWindowState | undefined;
  readonly pastCursor: string | undefined;
  /** Cleared by any later successful load, so a banner never outlives its cause. */
  readonly failure: { message: string; requestId?: string } | undefined;
}

const EMPTY: PlansState = {
  status: 'pending',
  needsDate: [],
  store: emptyPlansStore,
  upcomingWindow: undefined,
  pastCursor: undefined,
  failure: undefined,
};

export function usePlans(timezone: string, today: WallDate): PlansView {
  const [state, setState] = useState<PlansState>(EMPTY);
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
        needsDate: data.needsDate as unknown as readonly NeedsDateRowData[],
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
  /** The caller's injected clock (§4.3), read through a ref so midnight is not a resubscribe. */
  const todayRef = useRef(today);
  todayRef.current = today;
  /**
   * Patches one row's completion status in place. `changed` short-circuits so an event for a
   * row this tab does not hold (or a date it has not loaded) leaves every identity stable.
   */
  const patchCompletion = useCallback(
    (activityId: string, occurrenceDate: string | undefined, checked: boolean) => {
      setState((current) => {
        const byDate = new Map(current.store.byDate);
        let changed = false;
        for (const [date, rows] of byDate) {
          const next = rows.map((row) => {
            if (row.activityId !== activityId || row.occurrenceDate !== occurrenceDate) {
              return row;
            }
            changed = true;
            const status: AgendaItem['status'] =
              row.occurrenceDate === undefined
                ? checked
                  ? 'completed'
                  : 'scheduled'
                : checked
                  ? 'completed_occurrence'
                  : 'scheduled';
            return { ...row, status };
          });
          if (next.some((row, index) => row !== rows[index])) byDate.set(date, next);
        }
        if (!changed) return current;
        return { ...current, store: { ...current.store, byDate } };
      });
    },
    [],
  );

  useEffect(() => {
    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== 'updated') return;
      const key = event.mutation.options.mutationKey;
      if (!Array.isArray(key)) return;

      // Creates: project the 201's authoritative Activity into the stages.
      if (
        event.action.type === 'success' &&
        CREATE_KEYS.some((candidate) => keyMatches(key, candidate))
      ) {
        const activity = createdActivityFrom(event.action.data);
        if (activity === undefined) return;
        setState((current) => {
          if (current.status !== 'success') return current;
          const projected = applyPlansCreate(current, activity, todayRef.current);
          return projected === undefined ? current : { ...current, ...projected };
        });
        return;
      }

      /**
       * Completions: the same seam projects the toggle and, crucially, **reverts** it. The
       * agenda action's own rollback rewrites only TanStack caches, so this store listens to
       * the mutation lifecycle instead: `pending` projects (guarded rows never reach a
       * mutation, so a refused tick projects nothing), `error` restores, and a successful
       * `uncomplete` — the toast's Undo — is itself the un-projection.
       */
      const isComplete = keyMatches(key, activityMutationKeys.complete);
      const isUncomplete = keyMatches(key, activityMutationKeys.uncomplete);
      if (!isComplete && !isUncomplete) return;
      const variables = event.mutation.state.variables as
        | { activityId?: unknown; input?: { occurrenceDate?: unknown } }
        | undefined;
      const activityId = variables?.activityId;
      if (typeof activityId !== 'string') return;
      const occurrenceDate =
        typeof variables?.input?.occurrenceDate === 'string'
          ? variables.input.occurrenceDate
          : undefined;
      if (event.action.type === 'pending') {
        patchCompletion(activityId, occurrenceDate, isComplete);
      } else if (event.action.type === 'error') {
        patchCompletion(activityId, occurrenceDate, !isComplete);
      }
    });
  }, [queryClient, patchCompletion]);

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
        setState((current) => ({
          ...current,
          store: mergePlansResponse(current.store, data),
          upcomingWindow: {
            from: current.upcomingWindow?.from ?? (data.upcomingWindow.from as WallDate),
            through: data.upcomingWindow.through as WallDate,
            nextFrom: data.upcomingWindow.nextFrom as WallDate | null,
          },
          failure: undefined,
        }));
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        setState((current) => ({ ...current, failure: describe(error) }));
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
