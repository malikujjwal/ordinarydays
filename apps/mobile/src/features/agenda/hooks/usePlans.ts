import {
  emptyPlansStore,
  getPlans,
  mergePlansResponse,
  type PlansDateStore,
} from '@od/shared/client';
import { addWallDays } from '@od/shared/recurrence';
import type { WallDate } from '@od/shared/time';
import type { AgendaItem } from '@od/shared/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/apiClient';
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
  /**
   * Projects a row's completion toggle onto the local store, so the checkbox the user just
   * tapped reflects immediately. Deliberately **not** followed by a refetch: the write lands
   * in an eventually consistent GSI, and a refetch issued milliseconds later usually answers
   * with pre-write data (the `refreshActivityLists` lesson). The next natural refresh
   * reconciles.
   */
  readonly applyCompletion: (
    item: Pick<AgendaItem, 'activityId' | 'occurrenceDate'>,
    checked: boolean,
  ) => void;
  readonly message?: string;
  readonly requestId?: string;
}

function describe(error: unknown): { message: string; requestId?: string } {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  ) {
    const api = error as { status: number; message: string; requestId?: string };
    return {
      message: api.status >= 500 ? 'Something went wrong.' : api.message,
      ...(api.requestId === undefined ? {} : { requestId: api.requestId }),
    };
  }
  return { message: "Couldn't load this." };
}

interface PlansState {
  readonly status: 'pending' | 'success' | 'error';
  readonly needsDate: readonly NeedsDateRowData[];
  readonly store: PlansDateStore;
  readonly upcomingWindow: UpcomingWindowState | undefined;
  readonly pastCursor: string | undefined;
  readonly failure?: { message: string; requestId?: string };
}

const EMPTY: PlansState = {
  status: 'pending',
  needsDate: [],
  store: emptyPlansStore,
  upcomingWindow: undefined,
  pastCursor: undefined,
};

export function usePlans(timezone: string): PlansView {
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

  const applyCompletion = useCallback(
    (item: Pick<AgendaItem, 'activityId' | 'occurrenceDate'>, checked: boolean) => {
      setState((current) => {
        const byDate = new Map(current.store.byDate);
        let changed = false;
        for (const [date, rows] of byDate) {
          const next = rows.map((row) => {
            if (
              row.activityId !== item.activityId ||
              row.occurrenceDate !== item.occurrenceDate
            ) {
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

  return {
    status: state.status,
    needsDate: state.needsDate,
    store: state.store,
    upcomingWindow: state.upcomingWindow,
    pastCursor: state.pastCursor,
    isLoadingMoreUpcoming: loadingUpcoming,
    isLoadingMorePast: loadingPast,
    isRefreshing: refreshing,
    loadMoreUpcoming,
    loadMorePast,
    refetch,
    applyCompletion,
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
