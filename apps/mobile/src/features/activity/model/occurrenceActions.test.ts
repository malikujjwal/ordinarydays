import type { Activity } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  canSkipOccurrence,
  canSnoozeOccurrence,
  effectiveSchedule,
  type OccurrenceContext,
  occurrenceAgendaItem,
} from './occurrenceActions';

/**
 * Which activities the detail screen offers `Snooze` and `Skip today` on
 * (`today-and-tasks.md` §5.3, §5.4).
 *
 * These first required an occurrence in context, which silently dropped the whole non-recurring
 * row of §5.3's table and every one-off skip §5.4 allows — reported as "I don't see any snooze
 * or skip for non-recurring tasks". The gates below are that table, case by case.
 */
const TODAY = '2026-08-15';

const context = (patch: Partial<OccurrenceContext> = {}): OccurrenceContext => ({
  occurrenceDate: undefined,
  shownSchedule: { date: TODAY, time: '18:00' },
  capabilities: { complete: true, skip: true, snooze: true },
  objectKind: 'task',
  recurring: false,
  ...patch,
});

describe('canSnoozeOccurrence', () => {
  it('offers snooze on a one-off timed task — §5.3’s first row', () => {
    expect(canSnoozeOccurrence(context())).toBe(true);
  });

  it('offers snooze on a recurring occurrence in context', () => {
    expect(canSnoozeOccurrence(context({ recurring: true, occurrenceDate: TODAY }))).toBe(
      true,
    );
  });

  /** §5.3's last row: there is no time to move. */
  it('withholds snooze from an untimed task', () => {
    expect(canSnoozeOccurrence(context({ shownSchedule: { date: TODAY } }))).toBe(false);
  });

  /** §3.1 gives Snooze to task rows; a plan reschedules instead. */
  it('withholds snooze from a plan', () => {
    expect(canSnoozeOccurrence(context({ objectKind: 'plan' }))).toBe(false);
  });

  /** A series with no day in context names no occurrence to move. */
  it('withholds snooze from a series reached without an occurrence', () => {
    expect(canSnoozeOccurrence(context({ recurring: true }))).toBe(false);
  });

  it('withholds snooze when the server does not permit it', () => {
    expect(
      canSnoozeOccurrence(
        context({ capabilities: { complete: true, skip: true, snooze: false } }),
      ),
    ).toBe(false);
  });
});

describe('canSkipOccurrence', () => {
  /** §5.4: "available on any task" — no time required, and no occurrence. */
  it('offers skip on a one-off task, timed or not', () => {
    expect(canSkipOccurrence(context())).toBe(true);
    expect(canSkipOccurrence(context({ shownSchedule: { date: TODAY } }))).toBe(true);
  });

  /** …"and on any recurring occurrence", which need not be a task. */
  it('offers skip on a recurring plan occurrence', () => {
    expect(
      canSkipOccurrence(
        context({ objectKind: 'plan', recurring: true, occurrenceDate: TODAY }),
      ),
    ).toBe(true);
  });

  /** A non-recurring plan is neither; a passed one resolves through its own prompt. */
  it('withholds skip from a non-recurring plan', () => {
    expect(canSkipOccurrence(context({ objectKind: 'plan' }))).toBe(false);
  });

  it('withholds skip from a series reached without an occurrence', () => {
    expect(canSkipOccurrence(context({ recurring: true }))).toBe(false);
  });

  it('withholds skip when the server does not permit it', () => {
    expect(
      canSkipOccurrence(
        context({ capabilities: { complete: true, skip: false, snooze: true } }),
      ),
    ).toBe(false);
  });
});

describe('occurrenceAgendaItem', () => {
  const activity = {
    activityId: 'act_01J0000000000000000000000A',
    type: 'task',
    title: 'Gym',
    participantCount: 0,
  } as Activity;

  it('carries no occurrenceDate for a one-off, so the write stays activity-scoped', () => {
    const item = occurrenceAgendaItem(activity, context());

    expect(item?.occurrenceDate).toBeUndefined();
    expect(item?.isRecurring).toBe(false);
    expect(item?.time).toBe('18:00');
  });

  it('carries the nominal date for an occurrence', () => {
    const recurring = { ...activity, recurrence: { mode: 'fixed', segments: [] } };
    const item = occurrenceAgendaItem(
      recurring as Activity,
      context({ recurring: true, occurrenceDate: TODAY }),
    );

    expect(item?.occurrenceDate).toBe(TODAY);
    expect(item?.isRecurring).toBe(true);
  });

  it('renders nothing without a time, which the sheet needs to prune its options', () => {
    expect(
      occurrenceAgendaItem(activity, context({ shownSchedule: { date: TODAY } })),
    ).toBeUndefined();
  });
});

/**
 * **The two storage shapes of one behaviour, asserted side by side.**
 *
 * A snooze is an `OCC#` override on a series and `snoozedUntil` on a one-off. The contract
 * describes one snooze; the client understood one shape, so a snoozed one-off showed its
 * scheduled time forever and repeating a snooze compounded on a series but not on a one-off.
 * Pairing the cases in one table is what makes a fork like that fail a test rather than reach a
 * user.
 */
describe('effectiveSchedule — both shapes of the same override', () => {
  const activity = {
    activityId: 'act_01J0000000000000000000000A',
    schedule: { date: TODAY, time: '18:00', timezone: 'America/New_York' },
  } as Activity;

  const occurrenceProjection = {
    nominalDate: TODAY,
    date: TODAY,
    time: '18:00',
    status: 'scheduled' as const,
    isSnoozed: false,
  };

  it('reads the scheduled time when nothing has moved — either shape', () => {
    expect(effectiveSchedule(activity, undefined)?.time).toBe('18:00');
    expect(effectiveSchedule(activity, occurrenceProjection)?.time).toBe('18:00');
  });

  it('reads the snoozed time — either shape', () => {
    const snoozedOneOff = { ...activity, snoozedUntil: '18:15' } as Activity;
    const snoozedOccurrence = { ...occurrenceProjection, time: '18:15', isSnoozed: true };

    expect(effectiveSchedule(snoozedOneOff, undefined)?.time).toBe('18:15');
    expect(effectiveSchedule(activity, snoozedOccurrence)?.time).toBe('18:15');
  });

  /**
   * The behaviour the founder reported as differing per kind: the sheet computes its options
   * from the time it is shown, so both shapes must move for a repeat snooze to compound alike.
   */
  it('feeds the same moved time to the snooze sheet, whichever shape stored it', () => {
    const snoozedOneOff = { ...activity, snoozedUntil: '18:15' } as Activity;
    const oneOff = occurrenceAgendaItem(snoozedOneOff, {
      ...context(),
      shownSchedule: effectiveSchedule(snoozedOneOff, undefined),
    });
    const series = occurrenceAgendaItem(activity, {
      ...context({ recurring: true, occurrenceDate: TODAY }),
      shownSchedule: effectiveSchedule(activity, {
        ...occurrenceProjection,
        time: '18:15',
        isSnoozed: true,
      }),
    });

    expect(oneOff?.time).toBe('18:15');
    expect(series?.time).toBe('18:15');
  });

  /** An occurrence's own date wins, because an override can move it off the series' day. */
  it('takes the occurrence’s date when there is one', () => {
    expect(
      effectiveSchedule(activity, { ...occurrenceProjection, date: '2026-08-20' })?.date,
    ).toBe('2026-08-20');
  });

  /**
   * The instant form belongs to a cross-day occurrence move and never reaches the one-off
   * branch — the server rejects a cross-day one-off snooze outright. Ignored rather than
   * parsed, so this stays a pure wall-clock read.
   */
  it('ignores a non-wall-clock snoozedUntil rather than parsing a zone', () => {
    const odd = { ...activity, snoozedUntil: '2026-08-16T02:15:00.000Z' } as Activity;
    expect(effectiveSchedule(odd, undefined)?.time).toBe('18:00');
  });

  it('says nothing for an undated activity', () => {
    expect(effectiveSchedule({ activityId: 'a' } as Activity, undefined)).toBeUndefined();
  });
});
