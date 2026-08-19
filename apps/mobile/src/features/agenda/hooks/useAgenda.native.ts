import { addWallDays } from '@od/shared/recurrence';
import type { AgendaQuery } from '@od/shared/schemas';
import { type Instant, toWallDate } from '@od/shared/time';
import type { AgendaData } from '@od/shared/types';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AppState } from 'react-native';
import { useClock } from '@/hooks/useClock';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import { TODAY_AGENDA_INCLUDE } from '../keys';
import { resolveAgendaTimezone } from '../timezone';

export interface AgendaWindow {
  from: AgendaQuery['from'];
  to: AgendaQuery['to'];
  include?: AgendaQuery['include'];
}

export interface UseAgendaOptions {
  window?: AgendaWindow;
  days?: number;
  now?: Instant;
}

interface NativeAgendaView {
  readonly status: 'pending' | 'success' | 'error';
  readonly data?: AgendaData;
  readonly error: Error | null;
}

export function useAgenda(options: UseAgendaOptions = {}) {
  const state = requireActiveNativeState();
  const queryClient = useQueryClient();
  const clock = useClock();
  const timezone = resolveAgendaTimezone(queryClient);
  const today =
    options.now === undefined
      ? clock.todayIn(timezone)
      : toWallDate(options.now, timezone);
  const windowFrom = options.window?.from;
  const windowTo = options.window?.to;
  const windowInclude = options.window?.include;
  const request = useMemo<AgendaQuery>(
    () =>
      windowFrom !== undefined && windowTo !== undefined
        ? {
            from: windowFrom,
            to: windowTo,
            tz: timezone,
            ...(windowInclude === undefined ? {} : { include: windowInclude }),
          }
        : options.days === undefined
          ? {
              from: today,
              to: addWallDays(today, 1),
              tz: timezone,
              include: TODAY_AGENDA_INCLUDE,
            }
          : {
              from: today,
              to: addWallDays(today, options.days - 1),
              tz: timezone,
            },
    [windowFrom, windowTo, windowInclude, options.days, today, timezone],
  );
  const coverage = useMemo(
    () => ({
      from: request.from,
      to: request.to,
      timezone: request.tz,
      ...(request.include === undefined ? {} : { include: request.include }),
    }),
    [request],
  );
  const version = useSyncExternalStore(
    (listener) => state.agenda.subscribe(coverage, listener),
    () => state.agenda.version(coverage),
    () => 0,
  );
  const [view, setView] = useState<NativeAgendaView>({
    status: 'pending',
    error: null,
  });
  const initialAttempted = useRef<string | undefined>(undefined);

  const loadCommitted = useCallback(async () => {
    const [data, covered] = await Promise.all([
      state.agenda.read(coverage),
      state.agenda.hasCoverage(coverage),
    ]);
    setView((current) => ({
      status:
        covered ||
        data.days.some(
          (day) => day.schedule.length + day.anytime.length + day.earlier.length > 0,
        )
          ? 'success'
          : current.status,
      data,
      error: current.error,
    }));
    return { data, covered };
  }, [state, coverage]);

  const refetch = useCallback(async () => {
    const committed = await loadCommitted();
    try {
      const data = await state.sync.pullAgenda(request);
      setView({
        status: 'success',
        data,
        error: null,
      });
      return { data };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      await state.account.transactions.run((transaction) =>
        state.agenda.recordSyncError(transaction, coverage, failure.message),
      );
      const hasRows = committed.data.days.some(
        (day) => day.schedule.length + day.anytime.length + day.earlier.length > 0,
      );
      setView({
        status: committed.covered || hasRows ? 'success' : 'error',
        data: committed.data,
        error: failure,
      });
      return { data: committed.data, error: failure };
    }
  }, [state, loadCommitted, request, coverage]);

  useEffect(() => {
    void version;
    void loadCommitted();
  }, [loadCommitted, version]);

  useEffect(() => {
    const key = state.agenda.scope(coverage);
    if (initialAttempted.current === key) return;
    initialAttempted.current = key;
    void state.agenda.hasCoverage(coverage).then((covered) => {
      if (!covered) void refetch();
    });
  }, [coverage, refetch, state]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refetch();
    });
    return () => subscription.remove();
  }, [refetch]);

  return { ...view, refetch, timezone };
}
