import type { Clock, Instant, TimeZone, WallDate } from '@od/shared/time';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClockProvider } from '@/hooks/useClock';
import { useMinuteTicker } from './useMinuteTicker';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useMinuteTicker', () => {
  it('ticks on the minute, sleeps in background, and refreshes on foreground', () => {
    vi.useFakeTimers();
    let current = '2026-08-06T15:10:30.000Z' as Instant;
    let onAppStateChange: Parameters<typeof AppState.addEventListener>[1] | undefined;
    const remove = vi.fn();
    const clock: Clock = {
      now: () => current,
      todayIn: (_timezone: TimeZone) => '2026-08-06' as WallDate,
    };
    vi.spyOn(AppState, 'currentState', 'get').mockReturnValue('active');
    vi.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      onAppStateChange = listener;
      return { remove };
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClockProvider clock={clock}>{children}</ClockProvider>
    );

    const mounted = renderHook(() => useMinuteTicker(), { wrapper });
    expect(mounted.result.current).toEqual({
      instant: '2026-08-06T15:10:30.000Z',
      revision: 0,
    });

    current = '2026-08-06T15:11:00.000Z' as Instant;
    act(() => vi.advanceTimersByTime(30_000));
    expect(mounted.result.current).toEqual({ instant: current, revision: 1 });

    act(() => onAppStateChange?.('background'));
    current = '2026-08-06T15:12:15.000Z' as Instant;
    act(() => vi.advanceTimersByTime(75_000));
    expect(mounted.result.current).toEqual({
      instant: '2026-08-06T15:11:00.000Z',
      revision: 1,
    });

    act(() => onAppStateChange?.('active'));
    expect(mounted.result.current).toEqual({ instant: current, revision: 2 });

    mounted.unmount();
    expect(remove).toHaveBeenCalledOnce();
  });
});
