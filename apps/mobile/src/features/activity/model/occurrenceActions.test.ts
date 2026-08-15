import type { Activity } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  canSkipOccurrence,
  canSnoozeOccurrence,
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
