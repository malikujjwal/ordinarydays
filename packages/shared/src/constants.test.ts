import { describe, expect, it } from 'vitest';
import {
  MAX_ACTIVE_SERIES,
  MAX_AGENDA_DAYS,
  MAX_LIST_ITEMS,
  MAX_NOTES_LEN,
  MAX_PARTICIPANTS,
  MAX_REMINDERS_PER_USER_PER_ACTIVITY,
  MAX_TITLE_LEN,
  MAX_UPLOAD_BYTES,
  OVERDUE_WINDOW_DAYS,
  TODAY_ANYTIME_SAVED_LIMIT,
  TODAY_EARLIER_COLLAPSED_LIMIT,
  TODAY_OVERDUE_COLLAPSE_THRESHOLD,
  TODAY_OVERDUE_COLLAPSED_LIMIT,
} from './constants.js';

/**
 * These are the numbers the client and the server must agree on, and every one of them is
 * quoted in a canonical document — 50 participants, a 62-day agenda window, 20 people on a
 * shared list, 30 days of overdue roll-forward. Changing one is a product decision, and the
 * value is asserted here so that changing it is a deliberate act with a failing test
 * attached, rather than an edit nobody notices until an error message contradicts a doc.
 */
describe('the limits both sides of the wire enforce', () => {
  it.each([
    ['MAX_PARTICIPANTS', MAX_PARTICIPANTS, 50],
    ['MAX_AGENDA_DAYS', MAX_AGENDA_DAYS, 62],
    ['MAX_LIST_ITEMS', MAX_LIST_ITEMS, 500],
    ['MAX_TITLE_LEN', MAX_TITLE_LEN, 200],
    ['MAX_NOTES_LEN', MAX_NOTES_LEN, 4000],
    ['MAX_REMINDERS_PER_USER_PER_ACTIVITY', MAX_REMINDERS_PER_USER_PER_ACTIVITY, 3],
    ['MAX_ACTIVE_SERIES', MAX_ACTIVE_SERIES, 200],
    ['OVERDUE_WINDOW_DAYS', OVERDUE_WINDOW_DAYS, 30],
    ['TODAY_ANYTIME_SAVED_LIMIT', TODAY_ANYTIME_SAVED_LIMIT, 20],
    ['TODAY_EARLIER_COLLAPSED_LIMIT', TODAY_EARLIER_COLLAPSED_LIMIT, 10],
    ['TODAY_OVERDUE_COLLAPSE_THRESHOLD', TODAY_OVERDUE_COLLAPSE_THRESHOLD, 5],
    ['TODAY_OVERDUE_COLLAPSED_LIMIT', TODAY_OVERDUE_COLLAPSED_LIMIT, 3],
    ['MAX_UPLOAD_BYTES', MAX_UPLOAD_BYTES, 10 * 1024 * 1024],
  ])('%s is %i', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });
});
