import {
  type DateInterval,
  isRangeCovered,
  type PlansDateStore,
} from '@od/shared/client';
import { addWallDays } from '@od/shared/recurrence';
import type { WallDate } from '@od/shared/time';
import { format, getDay, getDaysInMonth, parseISO } from 'date-fns';

/**
 * The calendar navigator's model (P3-48, `plans-and-lists.md` §1.3.4).
 *
 * Everything here is pure and speaks viewer-local `WallDate`s only. **No `Date` object is
 * constructed in this feature** (`coding-standards.md` §4.4): day-of-week, days-in-month and
 * the month title come from `date-fns`, which is greppable in review, and the derive path
 * itself is string and integer arithmetic.
 *
 * The one rule that removes the edge cases: **the stage determines eligibility, never the
 * displayed month** ({@link isLiveDate}). Spillover from a neighbouring month that belongs
 * to the stage is live and carries its density; an out-of-stage date is inert.
 */

export type CalendarStage = 'upcoming' | 'past';

/** `live` in the displayed month · `spill` live from a neighbouring month · `inert` out of stage. */
export type CalendarCellState = 'live' | 'spill' | 'inert';

/** `YYYY-MM`. */
export type CalendarMonth = string;

/** A closed, inclusive range of wall dates — the shape the store's coverage speaks. */
export type CalendarWindow = DateInterval;

/**
 * What the calendar derives from: **the projected agenda the list renders**, including
 * optimistic local writes. The type admits no response envelope, no cache handle and no
 * fetch — a caller holding a raw `PlansData` cannot pass it here, which is the guarantee
 * that keeps the calendar and the list from diverging by construction.
 */
export type CalendarProjection = Pick<PlansDateStore, 'byDate' | 'covered'>;

export interface CalendarCell {
  readonly date: WallDate;
  /** The day of the month, for the numeral. */
  readonly day: number;
  readonly state: CalendarCellState;
  readonly isToday: boolean;
  /** Whether the date is in the displayed month (always `true` on the strip). */
  readonly inMonth: boolean;
  /**
   * Whether some exhausted response covers this date. Only a covered empty date may read as
   * loaded-and-empty; an uncovered one shows no marks and makes no claim.
   */
  readonly covered: boolean;
  /** Plans on the date — Upcoming's load bar. Tasks are counted separately. */
  readonly plans: number;
  /** Any task on the date — Upcoming's dot. */
  readonly hasTasks: boolean;
  /** Any row at all — Past's presence dot. */
  readonly known: boolean;
}

export interface CalendarContext {
  readonly stage: CalendarStage;
  readonly today: WallDate;
  /** The displayed month when expanded; absent on the seven-day strip. */
  readonly month?: CalendarMonth;
}

/** Monday-first, as the mock's weekday header reads. */
export const WEEKDAY_LABELS: readonly string[] = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export const STRIP_DAYS = 7;
/** A month grid is at most six rows of seven. */
export const MAX_GRID_DAYS = 42;

/**
 * **The stage rule, in one expression.** Upcoming is today and the future; Past is strictly
 * before today. Today therefore belongs to Upcoming and sits inert at the end of Past's strip.
 */
export function isLiveDate(
  stage: CalendarStage,
  date: WallDate,
  today: WallDate,
): boolean {
  return stage === 'upcoming' ? date >= today : date < today;
}

export const monthOf = (date: WallDate): CalendarMonth => date.slice(0, 7);

/** Adds whole months to a `YYYY-MM` by integer arithmetic. */
export function shiftMonth(month: CalendarMonth, delta: number): CalendarMonth {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const index = year * 12 + (monthNumber - 1) + delta;
  const nextYear = Math.floor(index / 12);
  const nextMonth = (index % 12) + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}`;
}

/**
 * Whether a month may be shown for the stage: Upcoming shows the current month and forward,
 * Past the current month and backward. The clamp is visible (§1.3.4) — the navigator dims
 * the arrow and the months this refuses rather than silently doing nothing.
 */
export function canShowMonth(
  stage: CalendarStage,
  month: CalendarMonth,
  today: WallDate,
): boolean {
  const current = monthOf(today);
  return stage === 'upcoming' ? month >= current : month <= current;
}

/** The rolling strip: `Next 7 days` today → +6, or `Previous 7 days` −6 → today. */
export function stripWindow(stage: CalendarStage, today: WallDate): CalendarWindow {
  return stage === 'upcoming'
    ? { from: today, through: addWallDays(today, STRIP_DAYS - 1) as WallDate }
    : { from: addWallDays(today, -(STRIP_DAYS - 1)) as WallDate, through: today };
}

/** Monday-first index (0 = Monday) of a wall date. */
export function weekdayIndex(date: WallDate): number {
  // Local noon: `date-fns` owns the `Date` here, and noon cannot cross a day boundary.
  return (getDay(parseISO(`${date}T12:00:00`)) + 6) % 7;
}

export function daysInMonth(month: CalendarMonth): number {
  return getDaysInMonth(parseISO(`${month}-01T12:00:00`));
}

/**
 * The visible grid of a month: from the Monday on or before the 1st, through the Sunday on or
 * after the last day — five or six rows, never more than {@link MAX_GRID_DAYS}. This is also
 * exactly the range a fetch asks for: the visible grid, not the nominal month.
 */
export function monthGridWindow(month: CalendarMonth): CalendarWindow {
  const first = `${month}-01` as WallDate;
  const offset = weekdayIndex(first);
  const rows = Math.ceil((offset + daysInMonth(month)) / 7);
  const from = addWallDays(first, -offset) as WallDate;
  return { from, through: addWallDays(from, rows * 7 - 1) as WallDate };
}

/**
 * The part of a visible window the stage can ask for. Out-of-stage dates are inert and are
 * never fetched: Upcoming clips to today and later, Past to strictly before today.
 */
export function stageRange(
  stage: CalendarStage,
  window: CalendarWindow,
  today: WallDate,
): CalendarWindow | undefined {
  const from = stage === 'upcoming' && window.from < today ? today : window.from;
  const lastPast = addWallDays(today, -1) as WallDate;
  const through =
    stage === 'past' && window.through > lastPast ? lastPast : window.through;
  return from > through ? undefined : { from, through };
}

/** `August 2026` — the expanded header. */
export function monthTitle(month: CalendarMonth): string {
  return format(parseISO(`${month}-01T12:00:00`), 'MMMM yyyy');
}

/** `Aug` — the month/year grid. */
export function monthShortName(month: CalendarMonth): string {
  return format(parseISO(`${month}-01T12:00:00`), 'MMM');
}

/** `Fri 14 Aug` — a cell's accessible date. */
export function cellDateLabel(date: WallDate): string {
  return format(parseISO(`${date}T12:00:00`), 'EEE d MMM');
}

/** The load bar's height in points, from the mock's three steps. `0` draws the empty hairline. */
export function planLoadHeight(plans: number): 0 | 6 | 10 | 14 {
  if (plans <= 0) return 0;
  if (plans === 1) return 6;
  if (plans === 2) return 10;
  return 14;
}

/**
 * One day cell for every date in `window`, in order. The same function draws the strip and the
 * month grid; only the date sequence and the `month` context differ.
 */
export function deriveCalendarCells(
  projection: CalendarProjection,
  window: CalendarWindow,
  context: CalendarContext,
): CalendarCell[] {
  const cells: CalendarCell[] = [];
  for (
    let date = window.from;
    date <= window.through;
    date = addWallDays(date, 1) as WallDate
  ) {
    const rows = projection.byDate.get(date) ?? [];
    const live = isLiveDate(context.stage, date, context.today);
    const inMonth = context.month === undefined || monthOf(date) === context.month;
    let plans = 0;
    let hasTasks = false;
    for (const row of rows) {
      if (row.type === 'task') hasTasks = true;
      else plans += 1;
    }
    cells.push({
      date,
      day: Number(date.slice(8, 10)),
      state: !live ? 'inert' : inMonth ? 'live' : 'spill',
      isToday: date === context.today,
      inMonth,
      covered: isRangeCovered(projection, date, date),
      plans,
      hasTasks,
      known: rows.length > 0,
    });
  }
  return cells;
}

/** The cells in rows of seven, for the grid. */
export function chunkWeeks(cells: readonly CalendarCell[]): CalendarCell[][] {
  const weeks: CalendarCell[][] = [];
  for (let index = 0; index < cells.length; index += 7) {
    weeks.push(cells.slice(index, index + 7));
  }
  return weeks;
}
