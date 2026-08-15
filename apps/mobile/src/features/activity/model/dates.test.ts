import { describe, expect, it } from 'vitest';
import {
  formatReminderOffset,
  formatSchedule,
  formatScheduleChange,
  formatWallDate,
  formatWallTime,
  quickDates,
} from './dates';

/**
 * The quick chips and the date formatting (`activities.md` §3 rule 4).
 *
 * Every case passes `today` explicitly. That is the point of the `new Date()` ban
 * (`coding-standards.md` §4.3): without it, "what does This weekend mean?" is a question
 * whose answer depends on the day the suite ran.
 */

// A Wednesday.
const WEDNESDAY = '2026-08-12';

describe('quickDates', () => {
  /**
   * **Named days, not vague spans.** The founder's frames call for "concrete date shortcuts
   * instead of ambiguous ones": `This weekend` read on a Sunday and `Next week` read on a
   * Friday each mean at least two different things, and the row shows the resolved date beside
   * the label so neither is a guess. From `WEDNESDAY` those resolve to Saturday and Monday.
   */
  it('offers the five options in their fixed order, naming the days', () => {
    expect(quickDates(WEDNESDAY).map((c) => c.label)).toEqual([
      'Today',
      'Tomorrow',
      'Saturday',
      'Next Monday',
      'Pick a date',
    ]);
  });

  it('resolves Today and Tomorrow in wall-clock space', () => {
    const chips = quickDates(WEDNESDAY);
    expect(chips[0]?.date).toBe('2026-08-12');
    expect(chips[1]?.date).toBe('2026-08-13');
  });

  it('makes This weekend the coming Saturday', () => {
    expect(quickDates(WEDNESDAY)[2]?.date).toBe('2026-08-15');
  });

  /**
   * The off-by-a-week case. `nextSaturday` on a Saturday returns the *following* one, so a
   * user tapping `This weekend` on Saturday morning would be shown a date eight days out.
   */
  it('makes This weekend today when today is Saturday', () => {
    expect(quickDates('2026-08-15')[2]?.date).toBe('2026-08-15');
  });

  it('makes Next week the coming Monday', () => {
    expect(quickDates(WEDNESDAY)[3]?.date).toBe('2026-08-17');
  });

  /** The mirror case: on a Monday, `Next week` is next Monday, not today. */
  it('makes Next week a week away when today is Monday', () => {
    expect(quickDates('2026-08-17')[3]?.date).toBe('2026-08-24');
  });

  it('gives Pick a date no value, because it opens the picker instead', () => {
    expect(quickDates(WEDNESDAY)[4]?.date).toBeUndefined();
  });

  /** A month boundary is where naive string arithmetic breaks. */
  it('crosses a month end correctly', () => {
    expect(quickDates('2026-08-31')[1]?.date).toBe('2026-09-01');
  });

  /** 2028 is a leap year. */
  it('crosses a leap day correctly', () => {
    expect(quickDates('2028-02-28')[1]?.date).toBe('2028-02-29');
  });
});

describe('formatWallDate', () => {
  it('drops the year within the current one', () => {
    expect(formatWallDate('2026-08-14', WEDNESDAY)).toBe('Fri 14 Aug');
  });

  it('restores the year when it differs, so a distant date is never ambiguous', () => {
    // 14 Aug 2027 is a Saturday — the weekday is computed, not carried over from the
    // same date a year earlier, which is exactly what this asserts.
    expect(formatWallDate('2027-08-14', WEDNESDAY)).toBe('Sat 14 Aug 2027');
  });
});

describe('formatWallTime', () => {
  it.each([
    ['18:00', '6:00 PM'],
    ['09:05', '9:05 AM'],
    ['00:30', '12:30 AM'],
    ['12:00', '12:00 PM'],
    ['23:59', '11:59 PM'],
  ])('renders %s as %s', (input, expected) => {
    expect(formatWallTime(input)).toBe(expected);
  });
});

describe('formatSchedule', () => {
  /** An undated plan is a plan; the row is never hidden (`plans-and-lists.md` §2.2). */
  it('says Not scheduled rather than rendering an empty row', () => {
    expect(formatSchedule(undefined, WEDNESDAY)).toBe('Not scheduled');
  });

  it('renders a date alone', () => {
    expect(formatSchedule({ date: '2026-08-14' }, WEDNESDAY)).toBe('Fri, Aug 14');
  });

  it('renders a date and a start time', () => {
    expect(formatSchedule({ date: '2026-08-14', time: '19:00' }, WEDNESDAY)).toBe(
      'Fri, Aug 14 · 7:00 PM',
    );
  });

  it('includes the year when the schedule is outside the current year', () => {
    expect(formatSchedule({ date: '2027-08-14', time: '19:00' }, WEDNESDAY)).toBe(
      'Sat, Aug 14, 2027 · 7:00 PM',
    );
  });

  it('renders a time range when there is an end time', () => {
    expect(
      formatSchedule({ date: '2026-08-14', time: '19:00', endTime: '21:30' }, WEDNESDAY),
    ).toBe('Fri, Aug 14 · 7:00 PM – 9:30 PM');
  });
});

describe('formatReminderOffset', () => {
  it.each([
    [0, 'At the time'],
    [-15, '15 minutes before'],
    [-60, '1 hour before'],
    [-120, '2 hours before'],
    [-1440, '1 day before'],
    [-2880, '2 days before'],
    [-90, '90 minutes before'],
  ])('renders %d as %s', (offset, expected) => {
    expect(formatReminderOffset(offset)).toBe(expected);
  });
});

describe('formatScheduleChange', () => {
  const at = (date: string, time: string | null) => ({ date, time });

  it('renders a time-only move as the two clock values', () => {
    expect(
      formatScheduleChange(at(WEDNESDAY, '18:00'), at(WEDNESDAY, '19:00'), WEDNESDAY),
    ).toBe('6:00 PM → 7:00 PM');
  });

  it('names both days once the date moves', () => {
    expect(
      formatScheduleChange(at(WEDNESDAY, '18:00'), at('2026-08-15', '18:00'), WEDNESDAY),
    ).toBe('Wed, Aug 12 · 6:00 PM → Sat, Aug 15 · 6:00 PM');
  });

  it('renders a cleared time as Anytime', () => {
    expect(
      formatScheduleChange(at(WEDNESDAY, '18:00'), at(WEDNESDAY, null), WEDNESDAY),
    ).toBe('6:00 PM → Anytime');
  });

  it('says nothing when nothing moved', () => {
    expect(
      formatScheduleChange(at(WEDNESDAY, '18:00'), at(WEDNESDAY, '18:00'), WEDNESDAY),
    ).toBeUndefined();
  });
});
