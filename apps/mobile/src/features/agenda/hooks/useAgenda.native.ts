import { addWallDays } from '@od/shared/recurrence';
import type { AgendaQuery } from '@od/shared/schemas';
import { type Instant, toWallDate } from '@od/shared/time';
import type { AgendaData } from '@od/shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useNavigation } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useClock } from '@/hooks/useClock';
import {
  agendaCoverageForQuery,
  nativeVisibleAgendaQuery,
} from '@/lib/sqlite/agendaCoverage';
import type { AgendaInvalidation } from '@/lib/sqlite/agendaRepository';
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
  /** Plans can reconcile local writes by changed day instead of rebuilding their full window. */
  incrementalLocalTargetReconciliation?: boolean;
}

interface NativeAgendaView {
  readonly status: 'pending' | 'success' | 'error';
  readonly data?: AgendaData;
  readonly error: Error | null;
}

interface CommittedAgendaView {
  readonly data: AgendaData;
  readonly covered: boolean;
}

function mergeAgendaDays(data: AgendaData, replacements: AgendaData['days']): AgendaData {
  if (replacements.length === 0) return data;
  const byDate = new Map(replacements.map((day) => [day.date, day]));
  const days = data.days.map((day) => byDate.get(day.date) ?? day);
  const knownDates = new Set(data.days.map((day) => day.date));
  for (const day of replacements) {
    if (!knownDates.has(day.date)) days.push(day);
  }
  days.sort((left, right) => left.date.localeCompare(right.date));
  return { ...data, days };
}

export function useAgenda(options: UseAgendaOptions = {}) {
  const state = requireActiveNativeState();
  const navigation = useNavigation();
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
  const incrementalLocalTargetReconciliation =
    options.incrementalLocalTargetReconciliation === true;
  const request = useMemo<AgendaQuery>(() => {
    const requested =
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
            };
    return nativeVisibleAgendaQuery(requested);
  }, [windowFrom, windowTo, windowInclude, options.days, today, timezone]);
  const coverage = useMemo(() => agendaCoverageForQuery(request), [request]);
  const [view, setView] = useState<NativeAgendaView>({
    status: 'pending',
    error: null,
  });
  const latestData = useRef<AgendaData | undefined>(view.data);
  latestData.current = view.data;
  const reconciliationGeneration = useRef(0);
  const initialAttempted = useRef<string | undefined>(undefined);
  const committedRead = useRef<
    | {
        readonly reader: () => Promise<CommittedAgendaView>;
        readonly promise: Promise<CommittedAgendaView>;
      }
    | undefined
  >(undefined);

  const readCommitted = useCallback(async (): Promise<CommittedAgendaView> => {
    const startedAt = Date.now();
    const shared = state.agenda.readSnapshot?.(coverage);
    const { data, covered } =
      shared === undefined
        ? await Promise.all([
            state.agenda.read(coverage),
            state.agenda.hasCoverage(coverage),
          ]).then(([data, covered]) => ({ data, covered }))
        : await shared;
    if (__DEV__) {
      console.info('native_agenda_read_completed', {
        from: coverage.from,
        to: coverage.to,
        include: coverage.include,
        dayCount: data.days.length,
        itemCount: data.days.reduce(
          (count, day) =>
            count + day.schedule.length + day.anytime.length + day.earlier.length,
          0,
        ),
        covered,
        durationMs: Date.now() - startedAt,
      });
    }
    return { data, covered };
  }, [state, coverage]);

  const readCommittedOnce = useCallback((): Promise<CommittedAgendaView> => {
    const current = committedRead.current;
    if (current?.reader === readCommitted) return current.promise;

    const promise = readCommitted().finally(() => {
      if (committedRead.current?.promise === promise) committedRead.current = undefined;
    });
    committedRead.current = { reader: readCommitted, promise };
    return promise;
  }, [readCommitted]);

  const applyCommitted = useCallback(({ data, covered }: CommittedAgendaView) => {
    latestData.current = data;
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
  }, []);

  const loadCommitted = useCallback(async () => {
    const committed = await readCommittedOnce();
    applyCommitted(committed);
    return committed;
  }, [applyCommitted, readCommittedOnce]);

  const pullRemote = useCallback(async () => {
    try {
      const data = await state.sync.pullAgenda(request);
      latestData.current = data;
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
      /**
       * A serialized cycle can install this coverage and still reject because another known
       * coverage failed. Re-read after settlement: using the pre-sync snapshot here lets the
       * late error overwrite the committed publish and strand Today on a blocking error.
       */
      const committed = await loadCommitted();
      const hasRows = committed.data.days.some(
        (day) => day.schedule.length + day.anytime.length + day.earlier.length > 0,
      );
      latestData.current = committed.data;
      setView({
        status: committed.covered || hasRows ? 'success' : 'error',
        data: committed.data,
        error: failure,
      });
      return { data: committed.data, error: failure };
    }
  }, [state, loadCommitted, request, coverage]);

  const refetch = useCallback(async () => {
    reconciliationGeneration.current += 1;
    await loadCommitted();
    return pullRemote();
  }, [loadCommitted, pullRemote]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      let reloadRunning = false;
      let reloadRequested = false;
      let localReadRunning = false;
      const pendingLocalDates = new Set<string>();
      /**
       * `freezeOnBlur` can suspend the component before React finishes an effect cleanup. The
       * navigation object remains live, so every invalidation also checks actual route focus.
       * A retained listener is therefore inert instead of reading Today behind an open Plans tab.
       */
      const isFocused = () => navigation.isFocused();

      /**
       * Repository publications are invalidations, not an event stream the UI must replay.
       * Keep one SQLite read in flight and collapse any burst during it into one trailing read.
       * The loop cannot lose the final publication: every reload marks the view dirty before it
       * checks the runner, and the runner checks that mark again after each committed snapshot.
       */
      const drainReloads = async (): Promise<void> => {
        if (reloadRunning) return;
        reloadRunning = true;
        try {
          while (active && isFocused() && reloadRequested) {
            reloadRequested = false;
            const committed = await readCommittedOnce();
            if (!active || !isFocused()) return;
            applyCommitted(committed);
          }
        } catch (error) {
          /* Keep the last committed view; a later publication starts a fresh trailing read. */
          if (__DEV__) {
            console.warn('native_agenda_reload_failed', {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        } finally {
          reloadRunning = false;
          /* Covers a publication arriving after the loop condition but before `finally`. */
          if (active && isFocused() && reloadRequested) void drainReloads();
        }
      };
      const requestReload = () => {
        if (!active || !isFocused()) return;
        reloadRequested = true;
        void drainReloads();
      };

      /**
       * A Plans checkbox changes one materialized date. Re-read and replace that date only;
       * publications that arrive during the read collapse into one trailing date batch.
       */
      const drainLocalDates = async (): Promise<void> => {
        if (localReadRunning) return;
        localReadRunning = true;
        try {
          while (active && isFocused() && pendingLocalDates.size > 0) {
            const dates = [...pendingLocalDates];
            pendingLocalDates.clear();
            const generation = reconciliationGeneration.current;
            const startedAt = Date.now();
            const days = await state.agenda.readDays(coverage, dates);
            if (__DEV__) {
              console.info('native_agenda_local_days_read_completed', {
                dates,
                itemCount: days.reduce(
                  (count, day) =>
                    count + day.schedule.length + day.anytime.length + day.earlier.length,
                  0,
                ),
                durationMs: Date.now() - startedAt,
              });
            }
            if (!active || !isFocused()) return;
            if (generation !== reconciliationGeneration.current) continue;
            const current = latestData.current;
            if (current === undefined) {
              requestReload();
              continue;
            }
            const data = mergeAgendaDays(current, days);
            latestData.current = data;
            setView((visible) => ({
              status: 'success',
              data,
              error: visible.error,
            }));
          }
        } catch (error) {
          /* A narrow-read failure falls back to the established full committed snapshot. */
          if (__DEV__) {
            console.warn('native_agenda_local_day_read_failed', {
              message: error instanceof Error ? error.message : String(error),
            });
          }
          requestReload();
        } finally {
          localReadRunning = false;
          if (active && isFocused() && pendingLocalDates.size > 0) {
            void drainLocalDates();
          }
        }
      };
      const reload = (invalidation: AgendaInvalidation = { kind: 'immediate' }) => {
        if (!active || !isFocused()) return;
        if (invalidation.kind !== 'local-day' || !incrementalLocalTargetReconciliation) {
          reconciliationGeneration.current += 1;
          pendingLocalDates.clear();
          requestReload();
          return;
        }
        pendingLocalDates.add(invalidation.date);
        void drainLocalDates();
      };
      const stopAgenda = state.agenda.subscribe(coverage, reload);
      const appState = AppState.addEventListener('change', (next) => {
        if (next === 'active' && isFocused()) {
          pendingLocalDates.clear();
          void refetch();
        }
      });
      requestReload();

      const key = state.agenda.scope(coverage);
      if (initialAttempted.current !== key) {
        initialAttempted.current = key;
        /* The focused snapshot already reads exact coverage metadata; do not race it with a
         * second, unscheduled SQLite lookup solely to make the same refetch decision. */
        void readCommittedOnce().then(
          ({ covered }) => {
            if (active && isFocused() && !covered) void pullRemote();
          },
          () => undefined,
        );
      }

      return () => {
        active = false;
        reconciliationGeneration.current += 1;
        pendingLocalDates.clear();
        /* A later focus must read afresh rather than share a snapshot started before blur. */
        committedRead.current = undefined;
        stopAgenda();
        appState.remove();
      };
    }, [
      applyCommitted,
      coverage,
      incrementalLocalTargetReconciliation,
      navigation,
      pullRemote,
      readCommittedOnce,
      refetch,
      state,
    ]),
  );

  return { ...view, refetch, timezone };
}
