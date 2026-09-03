import { missingRanges } from '@od/shared/client';
import type { WallDate } from '@od/shared/time';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type CalendarCell,
  type CalendarMonth,
  type CalendarProjection,
  type CalendarStage,
  type CalendarWindow,
  canShowMonth,
  deriveCalendarCells,
  monthGridWindow,
  monthOf,
  shiftMonth,
  stageRange,
  stripWindow,
} from '../model/deriveCalendarCells';

/**
 * The navigator's state and its one side effect (P3-48, `plans-and-lists.md` §1.3.4).
 *
 * **Navigation selects a window; it is not a second pagination model.** The hook computes
 * the visible window (the strip, or the displayed month's grid), asks the store which part
 * of it is still unknown, and — once the month has *settled* — hands that one range to
 * `loadRange`. Changing the month again before the settle cancels the pending request and
 * aborts an in-flight one. Expanding changes nothing but the window; when the grid is
 * already covered it issues no request at all.
 *
 * Expanded-or-collapsed is view state, remembered locally per platform, never on `User`.
 */

export type CalendarLoadRange = (
  stage: CalendarStage,
  range: CalendarWindow,
  signal: AbortSignal,
) => Promise<void>;

export interface CalendarStorage {
  get: () => Promise<string | null>;
  set: (value: string) => Promise<void>;
}

const EXPANDED_KEY = 'ordinarydays-plans-calendar-expanded-v1';
const asyncStorage: CalendarStorage = {
  get: () => AsyncStorage.getItem(EXPANDED_KEY),
  set: (value) => AsyncStorage.setItem(EXPANDED_KEY, value),
};

/** How long a month must stay on screen before its cold range is requested. */
export const SETTLE_MS = 250;

export interface UseCalendarNavigatorOptions {
  readonly stage: CalendarStage;
  readonly today: WallDate;
  /** The projected store the list renders — never a response. */
  readonly projection: CalendarProjection;
  readonly loadRange: CalendarLoadRange;
  readonly settleMs?: number;
  readonly storage?: CalendarStorage;
  /** Presentation-only override; remembered expansion remains untouched. */
  readonly expandedOverride?: boolean;
  /** Lets compact month controls fetch the displayed grid before it is explicitly opened. */
  readonly windowExpandedOverride?: boolean;
}

export interface CalendarNavigatorState {
  readonly expanded: boolean;
  readonly setExpanded: (expanded: boolean) => void;
  readonly month: CalendarMonth;
  readonly setMonth: (month: CalendarMonth) => void;
  readonly shift: (delta: number) => void;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly window: CalendarWindow;
  readonly cells: CalendarCell[];
  /** A cold range for the visible window is being fetched; the shell stays up meanwhile. */
  readonly loading: boolean;
  /** The last fetch for the visible window failed; the shell stays up and makes no claims. */
  readonly failed: boolean;
  readonly retry: () => void;
}

export function useCalendarNavigator({
  stage,
  today,
  projection,
  loadRange,
  settleMs = SETTLE_MS,
  storage = asyncStorage,
  expandedOverride,
  windowExpandedOverride,
}: UseCalendarNavigatorOptions): CalendarNavigatorState {
  const [expanded, setExpandedState] = useState(false);
  const [month, setMonthState] = useState<CalendarMonth>(() => monthOf(today));
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const changedLocally = useRef(false);

  useEffect(() => {
    let active = true;
    void storage
      .get()
      .then((stored) => {
        if (active && !changedLocally.current) setExpandedState(stored === 'true');
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [storage]);

  const setExpanded = useCallback(
    (next: boolean) => {
      changedLocally.current = true;
      setExpandedState(next);
      void storage.set(String(next)).catch(() => undefined);
    },
    [storage],
  );

  /** A stage change lands on the current month: the other direction's months are out of reach. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: the reset is keyed on the stage
  useEffect(() => {
    setMonthState(monthOf(today));
  }, [stage]);

  const setMonth = useCallback(
    (next: CalendarMonth) => {
      if (canShowMonth(stage, next, today)) setMonthState(next);
    },
    [stage, today],
  );
  const shift = useCallback(
    (delta: number) => setMonth(shiftMonth(month, delta)),
    [month, setMonth],
  );
  const canGoBack = canShowMonth(stage, shiftMonth(month, -1), today);
  const canGoForward = canShowMonth(stage, shiftMonth(month, 1), today);
  const visibleExpanded = expandedOverride ?? expanded;
  const windowExpanded = windowExpandedOverride ?? visibleExpanded;

  const window = useMemo(
    () => (windowExpanded ? monthGridWindow(month) : stripWindow(stage, today)),
    [windowExpanded, month, stage, today],
  );
  const cells = useMemo(
    () =>
      deriveCalendarCells(projection, window, {
        stage,
        today,
        ...(windowExpanded ? { month } : {}),
      }),
    [projection, window, stage, today, windowExpanded, month],
  );

  /**
   * The unknown part of the visible window, clipped to the stage, as one range — a string so
   * the effect below re-arms only when the *need* changes, not on every store update that
   * leaves the need the same.
   */
  const need = useMemo(() => {
    const askable = stageRange(stage, window, today);
    if (askable === undefined) return undefined;
    const gaps = missingRanges(projection, askable.from, askable.through);
    const first = gaps[0];
    const last = gaps[gaps.length - 1];
    if (first === undefined || last === undefined) return undefined;
    return `${first.from}..${last.through}`;
  }, [projection, stage, window, today]);

  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    // `attempt` is the retry: bumping it re-runs this effect for an unchanged need.
    void attempt;
    controller.current?.abort();
    controller.current = undefined;
    if (need === undefined) {
      setLoading(false);
      return;
    }
    const [from, through] = need.split('..') as [WallDate, WallDate];
    const next = new AbortController();
    controller.current = next;
    // Fetch on settle: a month passed through during a gesture never issues a request.
    const timer = setTimeout(() => {
      setLoading(true);
      setFailed(false);
      loadRange(stage, { from, through }, next.signal)
        .then(() => {
          if (!next.signal.aborted) setFailed(false);
        })
        .catch(() => {
          if (!next.signal.aborted) setFailed(true);
        })
        .finally(() => {
          if (controller.current === next) {
            controller.current = undefined;
            setLoading(false);
          }
        });
    }, settleMs);
    return () => {
      clearTimeout(timer);
      next.abort();
    };
  }, [need, stage, loadRange, settleMs, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return {
    expanded: visibleExpanded,
    setExpanded,
    month,
    setMonth,
    shift,
    canGoBack,
    canGoForward,
    window,
    cells,
    loading,
    failed,
    retry,
  };
}
