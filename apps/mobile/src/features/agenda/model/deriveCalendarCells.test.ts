import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PlansData } from '@od/shared/client';
import type { WallDate } from '@od/shared/time';
import { describe, expect, it } from 'vitest';
import {
  type CalendarCell,
  type CalendarProjection,
  type CalendarStage,
  canShowMonth,
  chunkWeeks,
  deriveCalendarCells,
  isLiveDate,
  monthGridWindow,
  monthOf,
  planLoadHeight,
  shiftMonth,
  stageRange,
  stripWindow,
  weekdayIndex,
} from './deriveCalendarCells';

/**
 * P3-48's model, `plans-and-lists.md` §1.3.4: the stage decides eligibility, spillover carries
 * its density, today belongs to Upcoming, and an unmarked date is a claim only under coverage.
 */

const TODAY = '2026-08-14' as WallDate;
const row = (type: 'event' | 'task' | 'meal') => ({ type });

function projection(
  dates: Record<string, ('event' | 'task' | 'meal')[]>,
  covered: { from: string; through: string }[] = [],
): CalendarProjection {
  return {
    byDate: new Map(
      Object.entries(dates).map(([date, types]) => [date as WallDate, types.map(row)]),
    ),
    covered: covered.map(({ from, through }) => ({
      from: from as WallDate,
      through: through as WallDate,
    })),
  } as unknown as CalendarProjection;
}

/** The stage rule rebuilt independently of the model, per cell. */
const expectedState = (
  stage: CalendarStage,
  cell: CalendarCell,
  month: string | undefined,
): CalendarCell['state'] => {
  const eligible = stage === 'upcoming' ? cell.date >= TODAY : cell.date < TODAY;
  if (!eligible) return 'inert';
  return month === undefined || cell.date.startsWith(month) ? 'live' : 'spill';
};

describe('the stage rule', () => {
  it('puts today in Upcoming and strictly before today in Past', () => {
    expect(isLiveDate('upcoming', TODAY, TODAY)).toBe(true);
    expect(isLiveDate('past', TODAY, TODAY)).toBe(false);
    expect(isLiveDate('past', '2026-08-13' as WallDate, TODAY)).toBe(true);
    expect(isLiveDate('upcoming', '2026-08-13' as WallDate, TODAY)).toBe(false);
  });

  it.each(['upcoming', 'past'] as const)(
    'derives every %s month-grid cell from the rule, spillover in both directions',
    (stage) => {
      const grid = monthGridWindow('2026-08');
      // August 2026 starts on a Saturday: July 27 – September 6, six rows.
      expect(grid).toEqual({ from: '2026-07-27', through: '2026-09-06' });
      const cells = deriveCalendarCells(projection({}), grid, {
        stage,
        today: TODAY,
        month: '2026-08',
      });
      expect(cells).toHaveLength(42);
      for (const cell of cells) {
        expect(cell.state, cell.date).toBe(expectedState(stage, cell, '2026-08'));
      }
      const byDate = new Map(cells.map((cell) => [cell.date, cell.state]));
      if (stage === 'upcoming') {
        expect(byDate.get('2026-07-30' as WallDate)).toBe('inert');
        expect(byDate.get('2026-08-13' as WallDate)).toBe('inert');
        expect(byDate.get('2026-08-14' as WallDate)).toBe('live');
        expect(byDate.get('2026-09-03' as WallDate)).toBe('spill');
      } else {
        expect(byDate.get('2026-07-30' as WallDate)).toBe('spill');
        expect(byDate.get('2026-08-13' as WallDate)).toBe('live');
        expect(byDate.get('2026-08-14' as WallDate)).toBe('inert');
        expect(byDate.get('2026-09-03' as WallDate)).toBe('inert');
      }
    },
  );

  it('renders today inert at the end of the Past strip and live at the head of Upcoming', () => {
    const past = deriveCalendarCells(projection({}), stripWindow('past', TODAY), {
      stage: 'past',
      today: TODAY,
    });
    expect(past.map((cell) => cell.date)).toEqual([
      '2026-08-08',
      '2026-08-09',
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
    ]);
    expect(past.at(-1)).toMatchObject({ isToday: true, state: 'inert' });

    const upcoming = deriveCalendarCells(projection({}), stripWindow('upcoming', TODAY), {
      stage: 'upcoming',
      today: TODAY,
    });
    expect(upcoming[0]).toMatchObject({ date: TODAY, isToday: true, state: 'live' });
    expect(upcoming.at(-1)?.date).toBe('2026-08-20');
  });
});

describe('density', () => {
  it('carries plan load and task presence onto spillover cells', () => {
    const cells = deriveCalendarCells(
      projection(
        {
          '2026-09-03': ['event', 'meal', 'event', 'task'],
          '2026-08-25': ['event', 'event'],
        },
        [{ from: '2026-08-14', through: '2026-10-14' }],
      ),
      monthGridWindow('2026-08'),
      { stage: 'upcoming', today: TODAY, month: '2026-08' },
    );
    const spill = cells.find((cell) => cell.date === '2026-09-03');
    expect(spill).toMatchObject({
      state: 'spill',
      plans: 3,
      hasTasks: true,
      known: true,
      covered: true,
    });
    expect(planLoadHeight(spill?.plans ?? 0)).toBe(14);
    expect(cells.find((cell) => cell.date === '2026-08-25')).toMatchObject({
      plans: 2,
      hasTasks: false,
    });
    expect(planLoadHeight(2)).toBe(10);
    expect(planLoadHeight(1)).toBe(6);
  });

  it('marks an empty date covered only inside an exhausted range — no dot means no claim', () => {
    const cells = deriveCalendarCells(
      projection({}, [{ from: '2026-08-01', through: '2026-08-10' }]),
      { from: '2026-08-08' as WallDate, through: '2026-08-12' as WallDate },
      { stage: 'past', today: TODAY },
    );
    expect(cells.map((cell) => [cell.date, cell.covered, cell.known])).toEqual([
      ['2026-08-08', true, false],
      ['2026-08-09', true, false],
      ['2026-08-10', true, false],
      ['2026-08-11', false, false],
      ['2026-08-12', false, false],
    ]);
  });
});

describe('windows and clamps', () => {
  it('clips a visible window to what the stage may ask for', () => {
    const grid = monthGridWindow('2026-08');
    expect(stageRange('upcoming', grid, TODAY)).toEqual({
      from: '2026-08-14',
      through: '2026-09-06',
    });
    expect(stageRange('past', grid, TODAY)).toEqual({
      from: '2026-07-27',
      through: '2026-08-13',
    });
    expect(stageRange('upcoming', monthGridWindow('2026-06'), TODAY)).toBeUndefined();
    expect(stageRange('past', monthGridWindow('2026-10'), TODAY)).toBeUndefined();
  });

  it('never exceeds six rows and starts on a Monday', () => {
    for (const month of ['2026-02', '2026-03', '2026-05', '2027-01', '2028-02']) {
      const grid = monthGridWindow(month);
      const cells = deriveCalendarCells(projection({}), grid, {
        stage: 'upcoming',
        today: TODAY,
        month,
      });
      expect(cells.length % 7).toBe(0);
      expect(cells.length).toBeLessThanOrEqual(42);
      expect(weekdayIndex(grid.from)).toBe(0);
      expect(chunkWeeks(cells).every((week) => week.length === 7)).toBe(true);
    }
  });

  it('shifts months across year boundaries and clamps to the stage direction', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(monthOf(TODAY)).toBe('2026-08');
    expect(canShowMonth('upcoming', '2026-07', TODAY)).toBe(false);
    expect(canShowMonth('upcoming', '2026-08', TODAY)).toBe(true);
    expect(canShowMonth('past', '2026-09', TODAY)).toBe(false);
    expect(canShowMonth('past', '2025-03', TODAY)).toBe(true);
  });
});

describe('what the derive path may be handed', () => {
  it('admits the projected store and refuses a network payload by type', () => {
    const payload = {} as PlansData;
    expect(() =>
      // @ts-expect-error — a `/v1/plans` response is not the projection the list renders.
      deriveCalendarCells(payload, stripWindow('upcoming', TODAY), {
        stage: 'upcoming',
        today: TODAY,
      }),
    ).toThrow();
  });

  it('constructs no Date anywhere in the agenda feature', () => {
    const root = join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
          if (/new Date\(/.test(readFileSync(path, 'utf8'))) offenders.push(path);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
