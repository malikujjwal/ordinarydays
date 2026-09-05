import type { WallDate } from '@od/shared/time';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarProjection } from '../model/deriveCalendarCells';
import { type CalendarLoadRange, useCalendarNavigator } from './useCalendarNavigator';

/**
 * P3-48's fetch discipline: expanding never fetches on its own, a gesture settles before a
 * request, a superseded request is cancelled, and a month that cannot load still renders
 * its shell with no claims.
 */

const TODAY = '2026-08-14' as WallDate;

const projection = (
  covered: { from: string; through: string }[],
): CalendarProjection => ({
  byDate: new Map(),
  covered: covered.map(({ from, through }) => ({
    from: from as WallDate,
    through: through as WallDate,
  })),
});

const memoryStorage = () => {
  let value: string | null = null;
  return {
    get: vi.fn(async () => value),
    set: vi.fn(async (next: string) => {
      value = next;
    }),
  };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useCalendarNavigator', () => {
  it('clears a failed distant window when returning to a covered month', async () => {
    const storage = memoryStorage();
    const loadRange = vi.fn<CalendarLoadRange>(async () => {
      throw new Error('offline');
    });
    const { result } = renderHook(() =>
      useCalendarNavigator({
        stage: 'upcoming',
        today: TODAY,
        projection: projection([{ from: '2026-08-14', through: '2026-10-14' }]),
        loadRange,
        storage,
      }),
    );
    act(() => {
      result.current.setExpanded(true);
      result.current.setMonth('2027-08');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.failed).toBe(true);
    act(() => result.current.setMonth('2026-09'));
    expect(result.current.failed).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores a superseded request that later %ss',
    async (outcome) => {
      const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
      const storage = memoryStorage();
      const loadRange: CalendarLoadRange = () =>
        new Promise<void>((resolve, reject) => {
          pending.push({ resolve, reject });
        });
      const { result } = renderHook(() =>
        useCalendarNavigator({
          stage: 'upcoming',
          today: TODAY,
          projection: projection([{ from: '2026-08-14', through: '2026-10-14' }]),
          loadRange,
          storage,
        }),
      );
      act(() => {
        result.current.setExpanded(true);
        result.current.setMonth('2027-02');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      act(() => result.current.setMonth('2027-08'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      await act(async () => {
        if (outcome === 'resolve') pending[0]?.resolve();
        else pending[0]?.reject(new Error('old window failed'));
      });
      expect(result.current.month).toBe('2027-08');
      expect(result.current.failed).toBe(false);
      expect(result.current.loading).toBe(true);
      await act(async () => {
        pending[1]?.resolve();
      });
      expect(result.current.loading).toBe(false);
    },
  );

  it('expanding issues zero requests when the grid is already covered', async () => {
    const loadRange = vi.fn<CalendarLoadRange>(async () => undefined);
    const storage = memoryStorage();
    const { result } = renderHook(() =>
      useCalendarNavigator({
        stage: 'upcoming',
        today: TODAY,
        // The initial 62-day window covers the rest of August and all of September's grid.
        projection: projection([{ from: '2026-08-14', through: '2026-10-14' }]),
        loadRange,
        storage,
      }),
    );
    expect(result.current.cells).toHaveLength(7);

    act(() => result.current.setExpanded(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(result.current.cells).toHaveLength(42);
    expect(loadRange).not.toHaveBeenCalled();
    expect(storage.set).toHaveBeenCalledWith('true');
  });

  it('three fast month changes issue one request, for the settled month, and cancel the rest', async () => {
    const signals: AbortSignal[] = [];
    const loadRange = vi.fn<CalendarLoadRange>((_stage, _range, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    const { result } = renderHook(() =>
      useCalendarNavigator({
        stage: 'upcoming',
        today: TODAY,
        projection: projection([{ from: '2026-08-14', through: '2026-10-14' }]),
        loadRange,
        storage: memoryStorage(),
      }),
    );
    act(() => result.current.setExpanded(true));

    act(() => result.current.shift(1));
    act(() => vi.advanceTimersByTime(80));
    act(() => result.current.shift(1));
    act(() => vi.advanceTimersByTime(80));
    act(() => result.current.shift(1));
    expect(loadRange).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(loadRange).toHaveBeenCalledTimes(1);
    expect(result.current.month).toBe('2026-11');
    // November's grid runs Oct 26 – Dec 6, none of it covered by the initial window.
    expect(loadRange.mock.calls[0]?.[1]).toEqual({
      from: '2026-10-26',
      through: '2026-12-06',
    });
    expect(result.current.loading).toBe(true);

    // Moving on while that request is in flight aborts it.
    act(() => result.current.shift(1));
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(loadRange).toHaveBeenCalledTimes(2);
    expect(loadRange.mock.calls[1]?.[1]).toEqual({
      from: '2026-11-30',
      through: '2027-01-03',
    });
  });

  it('keeps the shell and makes no claims when a cold month cannot load', async () => {
    const loadRange = vi.fn<CalendarLoadRange>(async () => {
      throw new Error('offline');
    });
    const { result } = renderHook(() =>
      useCalendarNavigator({
        stage: 'past',
        today: TODAY,
        projection: projection([]),
        loadRange,
        storage: memoryStorage(),
      }),
    );
    act(() => result.current.setExpanded(true));
    act(() => result.current.shift(-3));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.failed).toBe(true);
    expect(result.current.month).toBe('2026-05');
    expect(result.current.cells.length).toBeGreaterThan(0);
    expect(result.current.cells.every((cell) => !cell.known && !cell.covered)).toBe(true);
    expect(result.current.loading).toBe(false);

    act(() => result.current.retry());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(loadRange).toHaveBeenCalledTimes(2);
  });

  it('clamps navigation to the stage direction and lands a stage change on the current month', () => {
    const { result, rerender } = renderHook(
      ({ stage }: { stage: 'upcoming' | 'past' }) =>
        useCalendarNavigator({
          stage,
          today: TODAY,
          projection: projection([]),
          loadRange: vi.fn(async () => undefined),
          storage: memoryStorage(),
        }),
      { initialProps: { stage: 'upcoming' } },
    );
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(true);
    act(() => result.current.shift(-1));
    expect(result.current.month).toBe('2026-08');
    act(() => result.current.shift(2));
    expect(result.current.month).toBe('2026-10');

    rerender({ stage: 'past' });
    expect(result.current.month).toBe('2026-08');
    expect(result.current.canGoBack).toBe(true);
    expect(result.current.canGoForward).toBe(false);
  });
});
