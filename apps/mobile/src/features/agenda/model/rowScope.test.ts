import type { AgendaItem } from '@od/shared/types';
import { activityScope, occurrenceScope } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  isFutureRecurringOccurrence,
  scopeForRow,
  wouldCompleteWholeSeries,
} from './rowScope';

const row = (patch: Partial<AgendaItem> = {}): AgendaItem => ({
  activityId: 'act_STANDUP',
  type: 'task',
  title: 'Stand-up',
  status: 'scheduled',
  time: '09:30',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: false, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
  ...patch,
});

describe('scopeForRow', () => {
  it('reads a one-off as activity scope', () => {
    expect(scopeForRow(row())).toEqual(activityScope());
  });

  it('reads an expanded occurrence as its day', () => {
    expect(scopeForRow(row({ isRecurring: true, occurrenceDate: '2026-08-13' }))).toEqual(
      occurrenceScope('2026-08-13'),
    );
  });
});

/**
 * The condition the Today checkbox was missing. A recurring row is expected to name its day;
 * one that does not is a row the client built wrong, and no write may be sent from it.
 */
describe('wouldCompleteWholeSeries', () => {
  it('is true for a recurring row that names no day', () => {
    expect(wouldCompleteWholeSeries(row({ isRecurring: true }))).toBe(true);
  });

  it('is false once the row names its occurrence', () => {
    expect(
      wouldCompleteWholeSeries(row({ isRecurring: true, occurrenceDate: '2026-08-13' })),
    ).toBe(false);
  });

  it('is false for a one-off, whose activity scope is the correct answer', () => {
    expect(wouldCompleteWholeSeries(row())).toBe(false);
  });
});

describe('isFutureRecurringOccurrence', () => {
  it('accepts only a recurring occurrence strictly after today', () => {
    expect(
      isFutureRecurringOccurrence(
        row({ isRecurring: true, occurrenceDate: '2026-08-14' }),
        '2026-08-13',
      ),
    ).toBe(true);
    expect(
      isFutureRecurringOccurrence(
        row({ isRecurring: true, occurrenceDate: '2026-08-13' }),
        '2026-08-13',
      ),
    ).toBe(false);
    expect(
      isFutureRecurringOccurrence(row({ occurrenceDate: '2026-08-14' }), '2026-08-13'),
    ).toBe(false);
  });
});
