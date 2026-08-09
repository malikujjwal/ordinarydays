import { describe, expect, it } from 'vitest';
import {
  reconcileReminder,
  reminderOptions,
  TIMED_REMINDER_OPTIONS,
  UNTIMED_REMINDER_OPTIONS,
} from './reminders';

/**
 * The reminder picker's two lists (`notifications.md` §3, §3.2).
 *
 * An activity with a date and no time has no instant to offset from, so it gets days rather
 * than minutes. Everything here is about not offering — or silently keeping — an offset the
 * visible control cannot show.
 */
describe('reminderOptions', () => {
  it('offers §3 timed list, in its order, with Off first', () => {
    expect(reminderOptions(true).map((option) => option.label)).toEqual([
      'Off',
      'At the time',
      '5 minutes before',
      '15 minutes before',
      '30 minutes before',
      '1 hour before',
      '2 hours before',
      '1 day before',
      '2 days before',
    ]);
  });

  it('offers §3.2 untimed list instead when there is no time', () => {
    expect(reminderOptions(false).map((option) => option.label)).toEqual([
      'Off',
      'On the day',
      '1 day before',
      '2 days before',
    ]);
  });

  /** `0` is a real reminder — "at the time". `undefined` is the absence of one. */
  it('distinguishes At the time from Off', () => {
    expect(TIMED_REMINDER_OPTIONS[0]?.offsetMinutes).toBeUndefined();
    expect(TIMED_REMINDER_OPTIONS[1]?.offsetMinutes).toBe(0);
    expect(UNTIMED_REMINDER_OPTIONS[1]?.offsetMinutes).toBe(0);
  });

  /** Every offset is at or before the fire instant; the schema rejects a positive one. */
  it('never offers an offset after the start', () => {
    for (const option of TIMED_REMINDER_OPTIONS) {
      if (option.offsetMinutes !== undefined) {
        expect(option.offsetMinutes).toBeLessThanOrEqual(0);
      }
    }
  });
});

describe('reconcileReminder', () => {
  it('keeps Off as Off, both ways', () => {
    expect(reconcileReminder(undefined, true)).toBeUndefined();
    expect(reconcileReminder(undefined, false)).toBeUndefined();
  });

  /** Setting a time must not silently drop a reminder the untimed list also offers. */
  it('keeps an offset both lists share', () => {
    expect(reconcileReminder(-1440, true)).toBe(-1440);
    expect(reconcileReminder(-1440, false)).toBe(-1440);
    expect(reconcileReminder(0, false)).toBe(0);
  });

  /**
   * Clearing the time falls back to `Off` rather than leaving `15 minutes before` set on a
   * control that cannot show it — the picker then reads exactly what will happen.
   */
  it('falls back to Off for an offset the new list cannot show', () => {
    expect(reconcileReminder(-15, false)).toBeUndefined();
    expect(reconcileReminder(-120, false)).toBeUndefined();
  });

  it('keeps a sub-day offset while there is still a time', () => {
    expect(reconcileReminder(-15, true)).toBe(-15);
  });
});
