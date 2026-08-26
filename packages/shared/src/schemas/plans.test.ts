import { describe, expect, it } from 'vitest';
import { MAX_AGENDA_DAYS, MAX_NEEDS_DATE_ROWS } from '../constants.js';
import { plansData, plansQuery } from './plans.js';

const TZ = 'America/New_York';
const WINDOW = { from: '2026-09-01', through: '2026-11-01', nextFrom: null };

describe('plansQuery', () => {
  it.each([
    ['initial', { mode: 'initial', tz: TZ }],
    [
      'upcoming_window',
      {
        mode: 'upcoming_window',
        tz: TZ,
        upcomingFrom: '2026-09-01',
        upcomingTo: '2026-09-30',
      },
    ],
    [
      'past_window',
      { mode: 'past_window', tz: TZ, pastFrom: '2026-08-01', pastBefore: '2026-09-01' },
    ],
    ['past_cursor', { mode: 'past_cursor', tz: TZ, cursor: 'abc' }],
  ])('accepts a well-formed %s request', (_mode, query) => {
    expect(plansQuery.safeParse(query).success).toBe(true);
  });

  /**
   * The strictness is the 2026-08-25 amendment's whole point: a field from another mode is a
   * named `400`, never a parameter that silently launches streams the caller did not ask for
   * and pays for three stages while scrolling one.
   */
  it.each([
    [
      'past bounds on an upcoming window',
      {
        mode: 'upcoming_window',
        tz: TZ,
        upcomingFrom: '2026-09-01',
        upcomingTo: '2026-09-30',
        pastFrom: '2026-08-01',
      },
    ],
    [
      'upcoming bounds on initial',
      { mode: 'initial', tz: TZ, upcomingFrom: '2026-09-01' },
    ],
    ['a cursor on initial', { mode: 'initial', tz: TZ, cursor: 'abc' }],
    [
      'upcoming bounds on a past window',
      {
        mode: 'past_window',
        tz: TZ,
        pastFrom: '2026-08-01',
        pastBefore: '2026-09-01',
        upcomingTo: '2026-09-30',
      },
    ],
    ['an unknown mode', { mode: 'sideways', tz: TZ }],
    ['a missing timezone', { mode: 'initial' }],
    [
      'a half-specified upcoming window',
      { mode: 'upcoming_window', tz: TZ, upcomingFrom: '2026-09-01' },
    ],
    ['a past_cursor with no cursor', { mode: 'past_cursor', tz: TZ }],
  ])('refuses %s', (_why, query) => {
    expect(plansQuery.safeParse(query).success).toBe(false);
  });

  /** 62 inclusive dates is the cap; 63 is the request §P3-20 requires to fail. */
  it('accepts exactly MAX_AGENDA_DAYS and refuses one more', () => {
    const inclusive = (days: number) => ({
      mode: 'upcoming_window',
      tz: TZ,
      upcomingFrom: '2026-09-01',
      upcomingTo: new Date(Date.UTC(2026, 8, 1) + (days - 1) * 86_400_000)
        .toISOString()
        .slice(0, 10),
    });

    expect(plansQuery.safeParse(inclusive(MAX_AGENDA_DAYS)).success).toBe(true);
    expect(plansQuery.safeParse(inclusive(MAX_AGENDA_DAYS + 1)).success).toBe(false);
  });

  it('refuses a reversed upcoming window', () => {
    expect(
      plansQuery.safeParse({
        mode: 'upcoming_window',
        tz: TZ,
        upcomingFrom: '2026-09-30',
        upcomingTo: '2026-09-01',
      }).success,
    ).toBe(false);
  });

  /** `pastBefore` is exclusive, so an equal pair is an empty range rather than one day. */
  it.each([
    ['an empty range', '2026-09-01', '2026-09-01'],
    ['a reversed range', '2026-09-02', '2026-09-01'],
  ])('refuses %s', (_why, pastFrom, pastBefore) => {
    expect(
      plansQuery.safeParse({ mode: 'past_window', tz: TZ, pastFrom, pastBefore }).success,
    ).toBe(false);
  });
});

describe('plansData', () => {
  /**
   * **Inactive stages are absent, not empty.** A continuation carrying `upcoming: []` would
   * let a client merge an empty stage over one it already had — the exact failure the
   * amendment discriminated the response to prevent.
   */
  it.each([
    [
      'needsDate on an upcoming continuation',
      {
        mode: 'upcoming_window',
        upcoming: [],
        upcomingWindow: WINDOW,
        warnings: [],
        needsDate: [],
      },
    ],
    [
      'upcoming on a past continuation',
      { mode: 'past_cursor', past: [], pastPage: {}, warnings: [], upcoming: [] },
    ],
  ])('refuses %s', (_why, data) => {
    expect(plansData.safeParse(data).success).toBe(false);
  });

  it('accepts each continuation arm with exactly its own members', () => {
    expect(
      plansData.safeParse({
        mode: 'upcoming_window',
        upcoming: [],
        upcomingWindow: WINDOW,
        warnings: [],
      }).success,
    ).toBe(true);

    expect(
      plansData.safeParse({
        mode: 'past_window',
        past: [],
        pastCoverage: {
          requestedFrom: '2026-08-01',
          requestedThrough: '2026-08-31',
          coveredFrom: '2026-08-01',
          coveredThrough: '2026-08-31',
          complete: true,
        },
        warnings: [],
      }).success,
    ).toBe(true);
  });

  const initial = (extra: Record<string, unknown> = {}) => ({
    mode: 'initial',
    needsDate: [],
    upcoming: [],
    upcomingWindow: WINDOW,
    past: [],
    pastPage: {},
    warnings: [],
    ...extra,
  });

  /**
   * §1.3.2 in schema form. Nested RSVP counts and `suggestionCount` describe one row and are
   * content; a stage-level number would be a backlog total, and the cheapest moment to stop a
   * badge existing is before anything can read one.
   */
  it.each(['count', 'total', 'unread', 'badge', 'needsDateCount'])(
    'has no stage-level %s',
    (field) => {
      expect(plansData.safeParse(initial({ [field]: 3 })).success).toBe(false);
    },
  );

  it('caps needsDate at the documented model limit', () => {
    const row = (index: number) => ({
      activityId: `act_01J8XKQ2M4N5P6R7S8T9V${String(index).padStart(4, '0')}`,
      type: 'event',
      title: 'Trip',
      status: 'saved',
      isRecurring: false,
      isSnoozed: false,
      hasCheckbox: false,
      capabilities: { complete: true, skip: true, snooze: true },
      participantAvatars: [],
      participantCount: 0,
      isPast: false,
      lastActivityAt: '2026-08-26T18:00:00.000Z',
      rsvpSummary: {
        interested: { count: 0, names: [] },
        maybe: { count: 0, names: [] },
        pass: { count: 0, names: [] },
        pending: { count: 0, names: [] },
      },
      suggestionCount: 0,
    });

    expect(
      plansData.safeParse(
        initial({
          needsDate: Array.from({ length: MAX_NEEDS_DATE_ROWS + 1 }, (_v, i) => row(i)),
        }),
      ).success,
    ).toBe(false);
  });

  it('admits the needs-a-date warning beside the agenda ones', () => {
    expect(
      plansData.safeParse(
        initial({ warnings: ['needs_date_limit_exceeded', 'series_limit_exceeded'] }),
      ).success,
    ).toBe(true);
  });

  /** An RSVP group carries at most two names; the count supplies the remainder. */
  it('refuses a third name in an RSVP group', () => {
    expect(
      plansData.safeParse(
        initial({
          needsDate: [
            {
              activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
              type: 'event',
              title: 'Trip',
              status: 'saved',
              isRecurring: false,
              isSnoozed: false,
              hasCheckbox: false,
              capabilities: { complete: true, skip: true, snooze: true },
              participantAvatars: [],
              participantCount: 0,
              isPast: false,
              lastActivityAt: '2026-08-26T18:00:00.000Z',
              rsvpSummary: {
                interested: { count: 3, names: ['Alice', 'Ben', 'Cara'] },
                maybe: { count: 0, names: [] },
                pass: { count: 0, names: [] },
                pending: { count: 0, names: [] },
              },
              suggestionCount: 0,
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });
});
