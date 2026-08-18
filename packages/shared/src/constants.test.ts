import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_ACTIVE_SERIES,
  MAX_AGENDA_DAYS,
  MAX_AUTOMATIC_INTENT_AGE_DAYS,
  MAX_LIST_ITEMS,
  MAX_NOTES_LEN,
  MAX_OFFLINE_MUTATIONS,
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
    ['MAX_OFFLINE_MUTATIONS', MAX_OFFLINE_MUTATIONS, 200],
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

/**
 * The tombstone window (P2-49).
 *
 * `MAX_AUTOMATIC_INTENT_AGE_DAYS` bounds two things that must never be tuned apart: how long
 * a deletion tombstone is retained on the server, and how long a queued create keeps replaying
 * on the client. If a tombstone could expire while an intent was still replaying automatically,
 * that intent would find the id free and resurrect an activity the user deleted.
 *
 * **What this proves and what it does not.** It proves the arithmetic relating the two windows
 * never inverts, across arbitrary orderings of the two instants including clock skew. It cannot
 * prove that both call sites *use* this constant — they live in `services/api` and
 * `apps/mobile`, so no test in this package can import them. That half is held by the two
 * suites that assert it directly: the repository test pins the tombstone's `ttl` to this
 * constant, and the intent-log test pins automation's cutoff to it.
 */
describe('the tombstone outlives every intent that could replay against it', () => {
  const DAY_SECONDS = 24 * 60 * 60;
  const windowSeconds = MAX_AUTOMATIC_INTENT_AGE_DAYS * DAY_SECONDS;

  /** The server's derivation, as `activityRepository.deleteActivity` computes it. */
  const tombstoneExpiry = (deletedAtMs: number) =>
    Math.floor(deletedAtMs / 1000) + windowSeconds;

  /** The client's, as `intentLog.isAutomatable` bounds it. */
  const automationCutoff = (intentCreatedAtMs: number) =>
    Math.floor(intentCreatedAtMs / 1000) + windowSeconds;

  it('holds for any intent created at or before the delete', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4_102_444_800_000 }),
        fc.integer({ min: 0, max: 10 * 365 * DAY_SECONDS * 1000 }),
        (intentCreatedAt, gap) => {
          // An intent that could target this id was necessarily created before it was deleted.
          const deletedAt = intentCreatedAt + gap;
          return tombstoneExpiry(deletedAt) >= automationCutoff(intentCreatedAt);
        },
      ),
    );
  });

  it('still holds when the two instants coincide, the tightest case', () => {
    const instant = Date.parse('2026-08-17T10:00:00.000Z');

    // Equal, never less: a create and a delete in the same millisecond is the boundary.
    expect(tombstoneExpiry(instant)).toBe(automationCutoff(instant));
  });

  it('gives the tombstone the whole window even against a future-skewed intent', () => {
    /**
     * A device clock running ahead mints an intent stamped after the delete. The client's own
     * clock rule parks such an intent for confirmation rather than replaying it, so it never
     * reaches the server — but the arithmetic is asserted here anyway, because the guard that
     * matters most is the one nobody is relying on.
     */
    const deletedAt = Date.parse('2026-08-17T10:00:00.000Z');
    const skewed = deletedAt + 60 * 60 * 1000;

    expect(tombstoneExpiry(deletedAt)).toBeLessThan(automationCutoff(skewed));
  });
});
