import { describe, expect, it } from 'vitest';
import { calendarListLandingRecovery } from './calendarListLanding';

describe('calendar List landing recovery', () => {
  it('uses one stable virtualized offset and stops after two layout retries', () => {
    expect(calendarListLandingRecovery({ index: 80, averageItemLength: 72 }, 0)).toEqual({
      offset: 5_760,
      retryAfterMs: 32,
    });
    expect(calendarListLandingRecovery({ index: 80, averageItemLength: 72 }, 1)).toEqual({
      offset: 5_760,
      retryAfterMs: 32,
    });
    expect(
      calendarListLandingRecovery({ index: 80, averageItemLength: 72 }, 2),
    ).toBeUndefined();
    expect(
      calendarListLandingRecovery({ index: 80, averageItemLength: 72 }, 40),
    ).toBeUndefined();
  });
});
