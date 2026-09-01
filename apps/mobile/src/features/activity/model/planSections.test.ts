import type { TimeZone, WallDate } from '@od/shared/time';
import { describe, expect, it } from 'vitest';
import { prepProgress, relativeUpdateTime } from './planSections';

const TODAY = '2026-08-06' as WallDate;
const SYDNEY = 'Australia/Sydney' as TimeZone;

describe('relativeUpdateTime', () => {
  it('uses the viewer wall date rather than the UTC calendar date', () => {
    expect(relativeUpdateTime('2026-08-05T15:00:00.000Z', TODAY, SYDNEY)).toBe('today');
  });

  it('rejects an unvalidated stored timestamp before timezone conversion', () => {
    expect(() => relativeUpdateTime('not-an-instant', TODAY, SYDNEY)).toThrow();
  });
});

describe('prepProgress', () => {
  it('uses the canonical tappable counter copy', () => {
    expect(
      prepProgress([
        {
          activityId: 'act_1',
          title: 'Pack',
          status: 'completed',
          restoredStatus: 'saved',
          isRecurring: false,
        },
        {
          activityId: 'act_2',
          title: 'Book',
          status: 'scheduled',
          restoredStatus: 'scheduled',
          isRecurring: false,
        },
      ]),
    ).toBe('1 of 2 done');
  });
});
