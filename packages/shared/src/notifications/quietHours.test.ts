import { describe, expect, it } from 'vitest';
import type { QuietHours } from '../types/user.js';
import {
  insideQuietHours,
  notificationDelivery,
  reminderDelivery,
} from './quietHours.js';

/** `notifications.md` §4's default, and the case every realistic setting shares: it wraps. */
const NIGHT: QuietHours = { enabled: true, start: '22:00', end: '07:00' };
const DAY: QuietHours = { enabled: true, start: '09:00', end: '17:00' };
const OFF: QuietHours = { enabled: false, start: '22:00', end: '07:00' };

describe('insideQuietHours', () => {
  it.each([
    ['22:00', true, 'the window opens inclusively'],
    ['23:30', true, 'before midnight'],
    ['00:00', true, 'midnight itself'],
    ['03:15', true, 'after midnight, the half a naive comparison drops'],
    ['06:59', true, 'the last minute'],
    ['07:00', false, 'the window closes exclusively'],
    ['12:00', false, 'the middle of the day'],
    ['21:59', false, 'the minute before it opens'],
  ])('%s → %s (%s)', (time, expected) => {
    expect(insideQuietHours(time, NIGHT)).toBe(expected);
  });

  it('handles a window that does not wrap midnight', () => {
    expect(insideQuietHours('12:00', DAY)).toBe(true);
    expect(insideQuietHours('08:59', DAY)).toBe(false);
    expect(insideQuietHours('17:00', DAY)).toBe(false);
  });

  it('silences nothing when disabled or zero-length', () => {
    expect(insideQuietHours('03:00', OFF)).toBe(false);
    expect(
      insideQuietHours('03:00', { enabled: true, start: '22:00', end: '22:00' }),
    ).toBe(false);
  });
});

describe('reminderDelivery', () => {
  /**
   * §4's own example, and the rule the whole module exists for: a 6 AM flight is exactly what
   * quiet hours must not suppress. The reminder fires inside the window and is delivered
   * anyway, because the **activity** is inside it too.
   */
  it('delivers a reminder for an activity inside the window', () => {
    expect(
      reminderDelivery({ fireAt: '05:30', activityAt: '06:00', window: NIGHT }),
    ).toEqual({ kind: 'deliver' });
  });

  it('holds an early reminder that merely lands inside the window', () => {
    /**
     * The mirror case. A 2 PM meeting is not urgent at 6 AM, so an eight-hour-early reminder
     * waits for the window's end rather than waking the user for it.
     */
    expect(
      reminderDelivery({ fireAt: '06:00', activityAt: '14:00', window: NIGHT }),
    ).toEqual({ kind: 'hold', until: '07:00' });
  });

  it('delivers anything that fires outside the window', () => {
    expect(
      reminderDelivery({ fireAt: '09:00', activityAt: '14:00', window: NIGHT }),
    ).toEqual({ kind: 'deliver' });
  });

  it('judges an all-day reminder on its own fire time', () => {
    // No start instant to be inside or outside anything, so the ordinary rule applies.
    expect(
      reminderDelivery({ fireAt: '03:00', activityAt: undefined, window: NIGHT }),
    ).toEqual({ kind: 'hold', until: '07:00' });
    expect(
      reminderDelivery({ fireAt: '09:00', activityAt: undefined, window: NIGHT }),
    ).toEqual({ kind: 'deliver' });
  });

  it('delivers everything when quiet hours are off or unset', () => {
    expect(
      reminderDelivery({ fireAt: '03:00', activityAt: '14:00', window: OFF }),
    ).toEqual({ kind: 'deliver' });
    expect(
      reminderDelivery({ fireAt: '03:00', activityAt: '14:00', window: undefined }),
    ).toEqual({ kind: 'deliver' });
  });
});

describe('notificationDelivery', () => {
  it('holds an ordinary notification inside the window', () => {
    expect(notificationDelivery({ fireAt: '23:00', window: NIGHT })).toEqual({
      kind: 'hold',
      until: '07:00',
    });
  });

  it('delivers a change to an activity less than twelve hours away', () => {
    // §4's imminent-change exception: a plan moved to 8 AM qualifies at 10 PM tonight.
    expect(
      notificationDelivery({ fireAt: '22:00', window: NIGHT, hoursUntilActivity: 10 }),
    ).toEqual({ kind: 'deliver' });
  });

  it('holds a change to an activity further out, and one with no date', () => {
    expect(
      notificationDelivery({ fireAt: '22:00', window: NIGHT, hoursUntilActivity: 36 }),
    ).toEqual({ kind: 'hold', until: '07:00' });
    expect(notificationDelivery({ fireAt: '22:00', window: NIGHT })).toEqual({
      kind: 'hold',
      until: '07:00',
    });
  });
});
