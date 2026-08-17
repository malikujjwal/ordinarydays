import type { AgendaItem } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { dayCount, dayCountLabel } from './dayCount';

/**
 * The day's figure (P2-44). Pure, so the three cases §7.1 cares about — none done, some done,
 * all done — are three lines rather than three rendered screens.
 */
const item = (status: AgendaItem['status'], id: string = status): AgendaItem =>
  ({ activityId: id, status }) as AgendaItem;

describe('dayCount', () => {
  it('reports nothing done on a fresh day', () => {
    const count = dayCount([item('scheduled', 'a'), item('scheduled', 'b')]);
    expect(count).toEqual({ done: 0, total: 2, fraction: 0 });
    expect(dayCountLabel(count)).toBe('0 of 2 done');
  });

  it('counts a completed one-off and a completed occurrence alike', () => {
    const count = dayCount([
      item('completed', 'a'),
      item('completed_occurrence', 'b'),
      item('scheduled', 'c'),
      item('saved', 'd'),
    ]);
    expect(count).toEqual({ done: 2, total: 4, fraction: 0.5 });
    expect(dayCountLabel(count)).toBe('2 of 4 done');
  });

  it('fills at a fully completed day', () => {
    const count = dayCount([item('completed', 'a'), item('completed', 'b')]);
    expect(count).toEqual({ done: 2, total: 2, fraction: 1 });
  });

  /**
   * A skip is "deliberately not done, no guilt attached" (`today-and-tasks.md` §5.4). In the
   * denominator it would hold the bar permanently short of full on a day the user had finished
   * with; in the numerator it would claim the thing happened.
   */
  it('leaves a skipped or cancelled row out of both halves', () => {
    const count = dayCount([
      item('completed', 'a'),
      item('skipped', 'b'),
      item('skipped_occurrence', 'c'),
      item('cancelled', 'd'),
    ]);
    expect(count).toEqual({ done: 1, total: 1, fraction: 1 });
    expect(dayCountLabel(count)).toBe('1 of 1 done');
  });

  /** `done / total` is `NaN` at zero, and a `NaN` width silently renders nothing. */
  it('reports a zero fraction rather than NaN on an empty day', () => {
    expect(dayCount([])).toEqual({ done: 0, total: 0, fraction: 0 });
  });
});
