import { addWallDays } from '@od/shared/recurrence';
import type { AgendaQuery } from '@od/shared/schemas';
import { type Instant, toWallDate } from '@od/shared/time';
import type { AgendaData } from '@od/shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useNavigation } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { completionCommitGateFor } from '@/features/agenda/completionCommitGate';
import { useClock } from '@/hooks/useClock';
import {
  agendaCoverageForQuery,
  nativeVisibleAgendaQuery,
} from '@/lib/sqlite/agendaCoverage';
import type { AgendaInvalidation } from '@/lib/sqlite/agendaRepository';
import { getActiveNativeState, requireActiveNativeState } from '@/lib/sqlite/nativeState';
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
  /** Native Agenda screens can reconcile local writes by day instead of rebuilding their window. */
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
  readonly commitRevision: number;
  readonly source: 'reader' | 'writer-fallback';
  readonly metrics?: {
    readonly callCount: number;
    readonly durationMs: number;
    readonly decodeMs: number;
  };
}

const INVALIDATION_IDLE_MS = 90;
const INVALIDATION_MAX_MS = 250;

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
  const completionGate = completionCommitGateFor(state.coordinator);
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
    const { data, covered, metrics, commitRevision, source } =
      shared === undefined
        ? await Promise.all([
            state.agenda.read(coverage),
            state.agenda.hasCoverage(coverage),
          ]).then(([data, covered]) => ({
            data,
            covered,
            metrics: undefined,
            commitRevision: 0,
            source: 'writer-fallback' as const,
          }))
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
        commitRevision: commitRevision ?? 0,
        source: source ?? 'writer-fallback',
        sqliteCalls: metrics?.callCount,
        sqliteCallMs: metrics?.durationMs,
        decodeMs: metrics?.decodeMs,
        durationMs: Date.now() - startedAt,
      });
    }
    return {
      data,
      covered,
      commitRevision: commitRevision ?? 0,
      source: source ?? 'writer-fallback',
      ...(metrics === undefined ? {} : { metrics }),
    };
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

  const applyCommitted = useCallback(
    ({ data, covered, commitRevision }: CommittedAgendaView) => {
      const startedAt = Date.now();
      completionGate.reconcile(data, commitRevision);
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
      if (__DEV__) {
        console.info('native_agenda_result_applied', {
          kind: 'full',
          from: coverage.from,
          to: coverage.to,
          resultApplicationMs: Date.now() - startedAt,
        });
      }
    },
    [completionGate, coverage.from, coverage.to],
  );

  const loadCommitted = useCallback(async () => {
    const generation = reconciliationGeneration.current;
    const committed = await readCommittedOnce();
    const applies =
      getActiveNativeState() === state && generation === reconciliationGeneration.current;
    if (applies) applyCommitted(committed);
    return { ...committed, applies };
  }, [applyCommitted, readCommittedOnce, state]);

  const pullRemote = useCallback(async () => {
    try {
      await state.sync.pullAgenda(request);
      committedRead.current = undefined;
      const committed = await loadCommitted();
      if (committed.applies) setView((current) => ({ ...current, error: null }));
      return { data: committed.data };
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
      if (committed.applies) {
        latestData.current = committed.data;
        setView({
          status: committed.covered || hasRows ? 'success' : 'error',
          data: committed.data,
          error: failure,
        });
      }
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
      let appActive = AppState.currentState === 'active';
      let reloadRunning = false;
      let reloadRequested = false;
      let reloadRequiredRevision: number | undefined;
      let reloadGeneration = reconciliationGeneration.current;
      let reloadTimer: ReturnType<typeof setTimeout> | undefined;
      let reloadBurstStartedAt: number | undefined;
      let reloadLastRequestedAt: number | undefined;
      let localReadRunning = false;
      const pendingLocalDates = new Map<string, number | undefined>();
      let localTimer: ReturnType<typeof setTimeout> | undefined;
      let localBurstStartedAt: number | undefined;
      let localLastRequestedAt: number | undefined;
      /**
       * `freezeOnBlur` can suspend the component before React finishes an effect cleanup. The
       * navigation object remains live, so every invalidation also checks actual route focus.
       * A retained listener is therefore inert instead of reading Today behind an open Plans tab.
       */
      const isFocused = () => navigation.isFocused();
      const isCurrent = () =>
        active && appActive && isFocused() && getActiveNativeState() === state;
      const maximumRevision = (left: number | undefined, right: number | undefined) =>
        left === undefined ? right : right === undefined ? left : Math.max(left, right);
      const scheduleAtBound = (kind: 'full' | 'local', drain: () => Promise<void>) => {
        const timer = kind === 'full' ? reloadTimer : localTimer;
        if (timer !== undefined) clearTimeout(timer);
        const now = Date.now();
        const last = kind === 'full' ? reloadLastRequestedAt : localLastRequestedAt;
        const started = kind === 'full' ? reloadBurstStartedAt : localBurstStartedAt;
        const delay = Math.max(
          0,
          Math.min(
            (last ?? now) + INVALIDATION_IDLE_MS,
            (started ?? now) + INVALIDATION_MAX_MS,
          ) - now,
        );
        const scheduled = setTimeout(() => {
          if (kind === 'full') reloadTimer = undefined;
          else localTimer = undefined;
          void drain();
        }, delay);
        if (kind === 'full') reloadTimer = scheduled;
        else localTimer = scheduled;
      };

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
          while (isCurrent() && reloadRequested) {
            reloadRequested = false;
            const requiredRevision = reloadRequiredRevision;
            reloadRequiredRevision = undefined;
            const generation = reloadGeneration;
            reloadBurstStartedAt = undefined;
            reloadLastRequestedAt = undefined;
            const committed = await readCommittedOnce();
            if (!isCurrent()) return;
            if (generation !== reconciliationGeneration.current) continue;
            if (
              requiredRevision !== undefined &&
              committed.commitRevision < requiredRevision
            ) {
              reloadRequiredRevision = maximumRevision(
                reloadRequiredRevision,
                requiredRevision,
              );
              reloadRequested = true;
              reloadGeneration = generation;
              reloadBurstStartedAt ??= Date.now();
              reloadLastRequestedAt = Date.now();
              return;
            }
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
          if (isCurrent() && reloadRequested) {
            scheduleAtBound('full', drainReloads);
          }
        }
      };
      const requestReload = (requiredRevision?: number, immediate = false) => {
        if (!isCurrent()) return;
        const now = Date.now();
        reloadBurstStartedAt ??= now;
        reloadLastRequestedAt = now;
        reloadRequested = true;
        reloadRequiredRevision = maximumRevision(
          reloadRequiredRevision,
          requiredRevision,
        );
        reloadGeneration = reconciliationGeneration.current;
        committedRead.current = undefined;
        if (immediate) void drainReloads();
        else scheduleAtBound('full', drainReloads);
      };

      /**
       * A local target write changes one materialized date. Re-read and replace that date only;
       * publications that arrive during the read collapse into one trailing date batch.
       */
      const drainLocalDates = async (): Promise<void> => {
        if (localReadRunning) return;
        localReadRunning = true;
        try {
          while (isCurrent() && pendingLocalDates.size > 0) {
            const dates = [...pendingLocalDates.keys()].sort();
            const requiredRevision = [...pendingLocalDates.values()].reduce(
              maximumRevision,
              undefined,
            );
            pendingLocalDates.clear();
            const generation = reconciliationGeneration.current;
            localBurstStartedAt = undefined;
            localLastRequestedAt = undefined;
            const startedAt = Date.now();
            const snapshot =
              typeof state.agenda.readDaysSnapshot === 'function'
                ? await state.agenda.readDaysSnapshot(coverage, dates)
                : {
                    days: await state.agenda.readDays(coverage, dates),
                    commitRevision: 0,
                    source: 'writer-fallback' as const,
                    metrics: undefined,
                  };
            const { days } = snapshot;
            if (__DEV__) {
              console.info('native_agenda_local_days_read_completed', {
                dates,
                itemCount: days.reduce(
                  (count, day) =>
                    count + day.schedule.length + day.anytime.length + day.earlier.length,
                  0,
                ),
                commitRevision: snapshot.commitRevision ?? 0,
                source: snapshot.source ?? 'writer-fallback',
                sqliteCalls: snapshot.metrics?.callCount,
                sqliteCallMs: snapshot.metrics?.durationMs,
                decodeMs: snapshot.metrics?.decodeMs,
                durationMs: Date.now() - startedAt,
              });
            }
            if (!isCurrent()) return;
            if (generation !== reconciliationGeneration.current) continue;
            if (
              requiredRevision !== undefined &&
              (snapshot.commitRevision ?? 0) < requiredRevision
            ) {
              for (const date of dates) {
                pendingLocalDates.set(
                  date,
                  maximumRevision(pendingLocalDates.get(date), requiredRevision),
                );
              }
              localBurstStartedAt ??= Date.now();
              localLastRequestedAt = Date.now();
              return;
            }
            const current = latestData.current;
            if (current === undefined) {
              reconciliationGeneration.current += 1;
              requestReload(requiredRevision, true);
              continue;
            }
            const applyStartedAt = Date.now();
            completionGate.reconcile(
              { days, warnings: [] },
              snapshot.commitRevision ?? 0,
            );
            const data = mergeAgendaDays(current, days);
            latestData.current = data;
            setView((visible) => ({
              status: 'success',
              data,
              error: visible.error,
            }));
            if (__DEV__) {
              console.info('native_agenda_result_applied', {
                kind: 'local-days',
                dates,
                commitRevision: snapshot.commitRevision ?? 0,
                resultApplicationMs: Date.now() - applyStartedAt,
              });
            }
          }
        } catch (error) {
          /* A narrow-read failure falls back to the established full committed snapshot. */
          if (__DEV__) {
            console.warn('native_agenda_local_day_read_failed', {
              message: error instanceof Error ? error.message : String(error),
            });
          }
          reconciliationGeneration.current += 1;
          requestReload(undefined);
        } finally {
          localReadRunning = false;
          if (isCurrent() && pendingLocalDates.size > 0) {
            scheduleAtBound('local', drainLocalDates);
          }
        }
      };
      const reload = (invalidation: AgendaInvalidation = { kind: 'immediate' }) => {
        if (!isCurrent()) return;
        reconciliationGeneration.current += 1;
        if (invalidation.kind !== 'local-day' || !incrementalLocalTargetReconciliation) {
          pendingLocalDates.clear();
          if (localTimer !== undefined) clearTimeout(localTimer);
          localTimer = undefined;
          requestReload(invalidation.commitRevision);
          return;
        }
        if (reloadRequested && !reloadRunning) {
          requestReload(invalidation.commitRevision);
          return;
        }
        const now = Date.now();
        localBurstStartedAt ??= now;
        localLastRequestedAt = now;
        pendingLocalDates.set(
          invalidation.date,
          maximumRevision(
            pendingLocalDates.get(invalidation.date),
            invalidation.commitRevision,
          ),
        );
        scheduleAtBound('local', drainLocalDates);
      };
      const stopAgenda = state.agenda.subscribe(coverage, reload);
      const appState = AppState.addEventListener('change', (next) => {
        appActive = next === 'active';
        if (!appActive) {
          reconciliationGeneration.current += 1;
          reloadRequested = false;
          reloadRequiredRevision = undefined;
          pendingLocalDates.clear();
          if (reloadTimer !== undefined) clearTimeout(reloadTimer);
          if (localTimer !== undefined) clearTimeout(localTimer);
          reloadTimer = undefined;
          localTimer = undefined;
          committedRead.current = undefined;
        } else if (isFocused() && getActiveNativeState() === state) {
          void refetch();
        }
      });
      reconciliationGeneration.current += 1;
      requestReload(undefined, true);

      const key = state.agenda.scope(coverage);
      if (initialAttempted.current !== key) {
        initialAttempted.current = key;
        /* The focused snapshot already reads exact coverage metadata; do not race it with a
         * second, unscheduled SQLite lookup solely to make the same refetch decision. */
        void readCommittedOnce().then(
          ({ covered }) => {
            if (isCurrent() && !covered) void pullRemote();
          },
          () => undefined,
        );
      }

      return () => {
        active = false;
        appActive = false;
        reconciliationGeneration.current += 1;
        pendingLocalDates.clear();
        reloadRequested = false;
        reloadRequiredRevision = undefined;
        if (reloadTimer !== undefined) clearTimeout(reloadTimer);
        if (localTimer !== undefined) clearTimeout(localTimer);
        /* A later focus must read afresh rather than share a snapshot started before blur. */
        committedRead.current = undefined;
        stopAgenda();
        appState.remove();
      };
    }, [
      applyCommitted,
      completionGate,
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
