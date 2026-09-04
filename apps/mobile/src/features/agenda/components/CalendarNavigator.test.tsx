import type { WallDate } from '@od/shared/time';
import { ThemeProvider } from '@od/ui';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AccessibilityInfo, Animated } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarLoadRange } from '../hooks/useCalendarNavigator';
import type { CalendarProjection } from '../model/deriveCalendarCells';
import { CalendarNavigator } from './CalendarNavigator';

/**
 * The navigator as rendered (P3-48, `plans-and-lists.md` §1.3.4): the strip's caption per
 * stage, expanding without a request, a visible clamp, a day tap that never writes, and
 * Past's presence dots that make no claim about unloaded dates.
 */

const TODAY = '2026-08-14' as WallDate;
interface LayoutAwareElement extends Element {
  __reactLayoutHandler?: (event: {
    nativeEvent: {
      layout: { x: number; y: number; width: number; height: number };
    };
  }) => void;
}

const memoryStorage = () => ({
  get: vi.fn(async () => null),
  set: vi.fn(async () => undefined),
});

function projection(
  dates: Record<string, ('event' | 'task')[]>,
  covered: { from: string; through: string }[],
): CalendarProjection {
  return {
    byDate: new Map(
      Object.entries(dates).map(([date, types]) => [
        date as WallDate,
        types.map((type) => ({ type })),
      ]),
    ),
    covered: covered.map(({ from, through }) => ({
      from: from as WallDate,
      through: through as WallDate,
    })),
  } as unknown as CalendarProjection;
}

function mount(
  stage: 'upcoming' | 'past',
  data: CalendarProjection,
  loadRange: CalendarLoadRange = vi.fn(async () => undefined),
  onSelectDate = vi.fn(),
  compact = false,
  onHeightChange?: (height: number) => void,
) {
  render(
    <ThemeProvider scheme="light">
      <CalendarNavigator
        stage={stage}
        today={TODAY}
        projection={data}
        loadRange={loadRange}
        onSelectDate={onSelectDate}
        settleMs={10}
        storage={memoryStorage()}
        compact={compact}
        {...(onHeightChange === undefined ? {} : { onHeightChange })}
      />
    </ThemeProvider>,
  );
  return { loadRange, onSelectDate };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
};

describe('CalendarNavigator', () => {
  it('paints an opaque surface while it overlays scrolling plan rows', async () => {
    mount('upcoming', projection({}, [{ from: '2026-08-14', through: '2026-10-14' }]));
    await settle();

    expect(screen.getByTestId('plans-calendar').style.backgroundColor).toBe(
      'rgb(241, 237, 229)',
    );
  });

  it('collapses to the rolling strip with the stage caption and today at the right edge', async () => {
    mount('upcoming', projection({}, [{ from: '2026-08-14', through: '2026-10-14' }]));
    await settle();
    expect(screen.getByTestId('plans-calendar-caption').textContent).toBe('Next 7 days');
    expect(screen.getByTestId('calendar-cell-2026-08-14')).toBeDefined();
    expect(screen.getByTestId('calendar-cell-2026-08-20')).toBeDefined();
    expect(screen.queryByTestId('calendar-cell-2026-08-21')).toBeNull();
    // The strip's weekday letters are the dates' own, not a Monday-first header.
    expect(screen.getByTestId('calendar-cell-2026-08-14').textContent).toMatch(/^F14/);
    expect(screen.getByTestId('calendar-cell-2026-08-17').textContent).toMatch(/^M17/);
  });

  it('gives the collapsed strip enough height for both labels and density marks', async () => {
    mount(
      'upcoming',
      projection({ '2026-08-14': ['event', 'task'] }, [
        { from: '2026-08-14', through: '2026-10-14' },
      ]),
    );
    await settle();

    expect(
      Number.parseFloat(screen.getByTestId('calendar-cell-2026-08-14').style.minHeight),
    ).toBeGreaterThanOrEqual(71);
    expect(screen.getByTestId('calendar-bar-2026-08-14')).toBeDefined();
    expect(screen.getByTestId('calendar-dot-2026-08-14')).toBeDefined();
  });

  it('expands to the month grid without issuing a request when the grid is covered', async () => {
    const { loadRange } = mount(
      'upcoming',
      projection({ '2026-08-25': ['event', 'event'], '2026-09-03': ['event', 'task'] }, [
        { from: '2026-08-14', through: '2026-10-14' },
      ]),
    );
    await settle();
    expect(loadRange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Expand calendar' }));
    await settle();

    expect(screen.getByRole('button', { name: /August 2026/ })).toBeDefined();
    expect(screen.getByTestId('calendar-cell-2026-07-27')).toBeDefined();
    expect(screen.getByTestId('calendar-cell-2026-09-06')).toBeDefined();
    // Spillover carries its density: September 3 draws its bar and dot from August's grid.
    expect(screen.getByTestId('calendar-bar-2026-09-03')).toBeDefined();
    expect(screen.getByTestId('calendar-dot-2026-09-03')).toBeDefined();
    expect(screen.getByTestId('calendar-bar-2026-08-25')).toBeDefined();
    expect(loadRange).not.toHaveBeenCalled();
    // The clamp is visible: Upcoming dims the back arrow.
    expect(
      screen
        .getByRole('button', { name: 'Previous month' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: 'Next month' }).getAttribute('aria-disabled'),
    ).not.toBe('true');
  });

  it('a day tap lands within the stage, writes nothing and never switches stage', async () => {
    const { onSelectDate, loadRange } = mount(
      'upcoming',
      projection({}, [{ from: '2026-08-14', through: '2026-10-14' }]),
    );
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Expand calendar' }));
    await settle();

    fireEvent.click(screen.getByTestId('calendar-cell-2026-09-03'));
    await settle();

    expect(onSelectDate).toHaveBeenCalledWith('2026-09-03');
    expect(screen.getByRole('button', { name: /September 2026/ })).toBeDefined();
    expect(loadRange).not.toHaveBeenCalled();
    // An inert date is not a target: no button, no press.
    expect(screen.queryByRole('button', { name: /Thu 13 Aug/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Thu 3 Sep/ })).toBeDefined();
  });

  it('draws presence dots on Past only where rows are known, and nothing for unloaded dates', async () => {
    mount(
      'past',
      projection({ '2026-08-12': ['event'] }, [
        { from: '2026-08-10', through: '2026-08-13' },
      ]),
    );
    await settle();
    expect(screen.getByTestId('plans-calendar-caption').textContent).toBe(
      'Previous 7 days',
    );
    expect(screen.getByTestId('calendar-dot-2026-08-12')).toBeDefined();
    expect(screen.queryByTestId('calendar-dot-2026-08-11')).toBeNull();
    expect(screen.queryByTestId('calendar-bar-2026-08-12')).toBeNull();
    // Today is present as a boundary, inert.
    expect(screen.getByTestId('calendar-cell-2026-08-14')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Fri 14 Aug/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Wed 12 Aug, activity/ })).toBeDefined();
    // Uncovered dates (Aug 8, 9) make no claim: no dot, no empty hairline.
    expect(screen.queryByTestId('calendar-dot-2026-08-08')).toBeNull();
    expect(screen.queryByTestId('calendar-empty-2026-08-08')).toBeNull();
  });

  it('keeps the shell and shows the retry line when a cold month cannot load', async () => {
    mount(
      'past',
      projection({}, []),
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Expand calendar' }));
    await settle();

    expect(screen.getByTestId('plans-calendar-error')).toBeDefined();
    expect(screen.getByTestId('plans-calendar-grid')).toBeDefined();
    expect(screen.queryAllByTestId(/calendar-dot-/)).toHaveLength(0);
  });

  it('offers only the stage-reachable months in the header sheet', async () => {
    mount('upcoming', projection({}, [{ from: '2026-08-14', through: '2026-10-14' }]));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Expand calendar' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /August 2026. Choose a month/ }));
    await settle();

    expect(
      screen.getByTestId('plans-calendar-picker-2026-07').getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      screen.getByTestId('plans-calendar-picker-2026-09').getAttribute('aria-disabled'),
    ).not.toBe('true');
    fireEvent.click(screen.getByTestId('plans-calendar-picker-2026-10'));
    await settle();
    expect(screen.getByRole('button', { name: /October 2026/ })).toBeDefined();
  });

  it.each([
    ['upcoming', 'Previous month', 'Next month'],
    ['past', 'Next month', 'Previous month'],
  ] as const)(
    'keeps the %s clamp and opens the full calendar from compact month controls',
    async (stage, clamped, reachable) => {
      vi.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
      const timing = vi.spyOn(Animated, 'timing');
      mount(
        stage,
        projection({}, [{ from: '2026-06-01', through: '2026-10-31' }]),
        vi.fn(async () => undefined),
        vi.fn(),
        true,
      );
      await settle();
      timing.mockClear();

      const retainedGrid = screen.getByTestId('plans-calendar-grid');
      const focusableDate = stage === 'upcoming' ? TODAY : '2026-08-13';
      const retainedToday = screen.getByTestId(`calendar-cell-${focusableDate}`);
      expect(
        screen.getByTestId('plans-calendar-compact-grid').getAttribute('aria-hidden'),
      ).toBe('true');
      expect(retainedToday.getAttribute('role')).toBeNull();
      expect(
        screen.getByRole('button', { name: clamped }).getAttribute('aria-disabled'),
      ).toBe('true');
      expect(
        screen.getByRole('button', { name: reachable }).getAttribute('aria-disabled'),
      ).not.toBe('true');

      fireEvent.click(screen.getByRole('button', { name: 'Open full calendar' }));
      const opening = timing.mock.calls.find(([, config]) => config.toValue === 1);
      expect(opening?.[1].duration).toBeGreaterThanOrEqual(180);
      expect(opening?.[1].duration).toBeLessThanOrEqual(240);
      expect(opening?.[1].useNativeDriver).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(screen.getByTestId('plans-calendar-grid')).toBe(retainedGrid);
      expect(
        screen.getByTestId(`calendar-cell-${focusableDate}`).getAttribute('role'),
      ).toBe('button');
      expect(screen.getByRole('button', { name: 'Close full calendar' })).toBeDefined();
      timing.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Close full calendar' }));
      expect(timing.mock.calls.some(([, config]) => config.toValue === 0)).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(screen.getByTestId('plans-calendar-grid')).toBe(retainedGrid);
      expect(
        screen.getByTestId('plans-calendar-compact-grid').getAttribute('aria-hidden'),
      ).toBe('true');
    },
  );

  it('reuses the retained grid measurement when compact calendar controls open it', async () => {
    const onHeightChange = vi.fn();
    mount(
      'upcoming',
      projection({}, [{ from: '2026-06-01', through: '2026-10-31' }]),
      vi.fn(async () => undefined),
      vi.fn(),
      true,
      onHeightChange,
    );
    await settle();
    const grid = screen.getByTestId('plans-calendar-compact-grid') as LayoutAwareElement;
    expect(grid.__reactLayoutHandler).toBeTypeOf('function');
    act(() => {
      grid.__reactLayoutHandler?.({
        nativeEvent: { layout: { x: 0, y: 44, width: 390, height: 180 } },
      });
    });
    onHeightChange.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Open full calendar' }));

    expect(onHeightChange).toHaveBeenCalledWith(224);
  });
});
