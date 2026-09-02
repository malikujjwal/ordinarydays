import { addWallDays } from '@od/shared/recurrence';
import type { WallDate } from '@od/shared/time';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import type { NativePlansProjection } from '@/lib/sqlite/plansRepository';
import { describePlansFailure, PLANS_WINDOW_DAYS } from '../model/plansFeed';
import { fetchStageRange } from '../model/plansRangeFetch';
import type { PlansView } from './usePlans';

export type { NeedsDateRowData } from '../model/plansApply';

const EMPTY_STORE = { byDate: new Map(), covered: [] } as const;

/** Native Plans reads only the account-scoped SQLite projection installed by sync. */
export function usePlans(
  timezone: string,
  _today: WallDate,
  _currentMinute: string,
): PlansView {
  const state = requireActiveNativeState();
  const plans = state.plans;
  const pullPlans = state.sync.pullPlans;
  if (plans === undefined || pullPlans === undefined) {
    throw new Error('Native Plans state is not ready.');
  }
  const version = useSyncExternalStore(
    (listener) => plans.subscribe(listener),
    () => plans.version(),
    () => 0,
  );
  const [projection, setProjection] = useState<NativePlansProjection>();
  const [failure, setFailure] = useState<{
    message: string;
    requestId?: string;
  }>();
  const [initialSettled, setInitialSettled] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingUpcoming, setLoadingUpcoming] = useState(false);
  const [loadingPast, setLoadingPast] = useState(false);
  const [upcomingStalled, setUpcomingStalled] = useState(false);
  const live = useRef({ state, timezone });
  live.current = { state, timezone };

  const isCurrent = useCallback(
    () => live.current.state === state && live.current.timezone === timezone,
    [state, timezone],
  );
  const readCommitted = useCallback(async () => {
    const current = await plans.read(timezone);
    if (isCurrent()) setProjection(current);
    return current;
  }, [isCurrent, plans, timezone]);

  useEffect(() => {
    void version;
    void readCommitted();
  }, [readCommitted, version]);

  useEffect(() => {
    let cancelled = false;
    void plans
      .read(timezone)
      .then(async (cached) => {
        if (cancelled || !isCurrent()) return;
        setProjection(cached);
        setRefreshing(cached !== undefined);
        await pullPlans.call(state.sync, { mode: 'initial', tz: timezone });
        if (cancelled || !isCurrent()) return;
        await readCommitted();
        setFailure(undefined);
        setUpcomingStalled(false);
      })
      .catch((error: unknown) => {
        if (!cancelled && isCurrent()) setFailure(describePlansFailure(error));
      })
      .finally(() => {
        if (!cancelled && isCurrent()) {
          setInitialSettled(true);
          setRefreshing(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isCurrent, plans, pullPlans, readCommitted, state.sync, timezone]);

  const refetch = useCallback(() => {
    setRefreshing(true);
    void pullPlans
      .call(state.sync, { mode: 'initial', tz: timezone })
      .then(async () => {
        await readCommitted();
        if (isCurrent()) {
          setFailure(undefined);
          setUpcomingStalled(false);
        }
      })
      .catch((error: unknown) => {
        if (isCurrent()) setFailure(describePlansFailure(error));
      })
      .finally(() => {
        if (isCurrent()) setRefreshing(false);
      });
  }, [isCurrent, pullPlans, readCommitted, state.sync, timezone]);

  const loadMoreUpcoming = useCallback(() => {
    const from = projection?.upcomingWindow.nextFrom;
    if (from == null || loadingUpcoming) return;
    const request = {
      mode: 'upcoming_window' as const,
      tz: timezone,
      upcomingFrom: from,
      upcomingTo: addWallDays(from, PLANS_WINDOW_DAYS - 1) as WallDate,
    };
    setLoadingUpcoming(true);
    void pullPlans
      .call(state.sync, request)
      .then(async () => {
        await readCommitted();
        if (isCurrent()) {
          setFailure(undefined);
          setUpcomingStalled(false);
        }
      })
      .catch((error: unknown) => {
        if (isCurrent()) {
          setFailure(describePlansFailure(error));
          setUpcomingStalled(true);
        }
      })
      .finally(() => {
        if (isCurrent()) setLoadingUpcoming(false);
      });
  }, [
    isCurrent,
    loadingUpcoming,
    projection?.upcomingWindow.nextFrom,
    pullPlans,
    readCommitted,
    state.sync,
    timezone,
  ]);

  const loadMorePast = useCallback(() => {
    const cursor = projection?.pastCursor;
    if (cursor === undefined || loadingPast) return;
    setLoadingPast(true);
    void pullPlans
      .call(state.sync, { mode: 'past_cursor', tz: timezone, cursor })
      .then(async () => {
        await readCommitted();
        if (isCurrent()) setFailure(undefined);
      })
      .catch((error: unknown) => {
        if (isCurrent()) setFailure(describePlansFailure(error));
      })
      .finally(() => {
        if (isCurrent()) setLoadingPast(false);
      });
  }, [
    isCurrent,
    loadingPast,
    projection?.pastCursor,
    pullPlans,
    readCommitted,
    state.sync,
    timezone,
  ]);

  /**
   * The navigator's window fetch through the serialized sync pull (P3-48). The engine owns
   * the network and its own deadline, so the caller's `signal` cannot cancel a pull already
   * in flight; it only stops this loop from issuing the next one — recorded, device-matrix
   * gate. Coverage lands in the repository projection the list reads, so the calendar and
   * the list still derive from one state.
   */
  /**
   * Read through a ref so `loadRange` keeps one identity across the pages it lands: every
   * page publishes a fresh projection, and a `loadRange` that changed with it would make the
   * navigator abort and re-arm its walk after each page.
   */
  const projectionRef = useRef(projection);
  projectionRef.current = projection;
  const loadRange = useCallback(
    async (
      stage: 'upcoming' | 'past',
      range: { from: WallDate; through: WallDate },
      signal: AbortSignal,
    ) => {
      const current = projectionRef.current;
      await fetchStageRange({
        stage,
        range,
        tz: timezone,
        store: current?.store ?? EMPTY_STORE,
        upcomingThrough: current?.upcomingWindow.through,
        signal,
        pull: (request) => pullPlans.call(state.sync, request),
        onResponse: async () => {
          await readCommitted();
        },
      });
    },
    [pullPlans, readCommitted, state.sync, timezone],
  );

  return {
    status:
      projection !== undefined
        ? 'success'
        : initialSettled && failure !== undefined
          ? 'error'
          : 'pending',
    needsDate: projection?.needsDate ?? [],
    store: projection?.store ?? EMPTY_STORE,
    upcomingWindow: projection?.upcomingWindow,
    pastCursor: projection?.pastCursor,
    isLoadingMoreUpcoming: loadingUpcoming,
    isLoadingMorePast: loadingPast,
    isRefreshing: refreshing,
    loadMoreUpcoming,
    loadMorePast,
    loadRange,
    refetch,
    // Native completion already changes Agenda rows in the durable action transaction. The
    // repository joins those rows and publishes after commit; a second hook-local projection
    // would briefly become a competing state authority.
    projectCompletion: () => undefined,
    upcomingStalled,
    ...(failure === undefined ? {} : failure),
  };
}
