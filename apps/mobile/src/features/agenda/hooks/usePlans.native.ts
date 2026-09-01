import { MAX_AGENDA_DAYS } from '@od/shared/constants';
import { addWallDays } from '@od/shared/recurrence';
import type { WallDate } from '@od/shared/time';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { describeApiFailure } from '@/lib/apiFailure';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import type { NativePlansProjection } from '@/lib/sqlite/plansRepository';
import type { PlansView } from './usePlans';

export type { NeedsDateRowData } from '../model/plansApply';

const WINDOW_DAYS = MAX_AGENDA_DAYS;
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
        if (!cancelled && isCurrent())
          setFailure(describeApiFailure(error, "Couldn't load this."));
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
        if (isCurrent()) setFailure(describeApiFailure(error, "Couldn't load this."));
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
      upcomingTo: addWallDays(from, WINDOW_DAYS - 1) as WallDate,
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
          setFailure(describeApiFailure(error, "Couldn't load this."));
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
        if (isCurrent()) setFailure(describeApiFailure(error, "Couldn't load this."));
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
    refetch,
    // Native completion already changes Agenda rows in the durable action transaction. The
    // repository joins those rows and publishes after commit; a second hook-local projection
    // would briefly become a competing state authority.
    projectCompletion: () => undefined,
    upcomingStalled,
    ...(failure === undefined ? {} : failure),
  };
}
