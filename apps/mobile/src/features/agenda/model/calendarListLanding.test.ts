import { describe, expect, it } from 'vitest';
import {
  calendarListLandingDeadline,
  calendarListLandingRecovery,
} from './calendarListLanding';

describe('calendar List landing recovery', () => {
  it('restarts the landing window only while the list has measured nothing', () => {
    const unmeasured = { index: 2, averageItemLength: 0 };
    expect(calendarListLandingDeadline(unmeasured, 1_130, 1_256)).toBe(1_386);
    // Never shortens a window that already reaches further.
    expect(calendarListLandingDeadline(unmeasured, 1_000, 1_400)).toBe(1_400);
    expect(
      calendarListLandingDeadline({ index: 15, averageItemLength: 148 }, 1_130, 1_256),
    ).toBe(1_256);
  });

  it('uses one stable virtualized offset across the native render batch, then stops', () => {
    expect(calendarListLandingRecovery({ index: 80, averageItemLength: 72 }, 0)).toEqual({
      offset: 5_760,
      retryAfterMs: 32,
    });
    expect(calendarListLandingRecovery({ index: 80, averageItemLength: 72 }, 1)).toEqual({
      offset: 5_760,
      retryAfterMs: 32,
    });
    expect(calendarListLandingRecovery({ index: 80, averageItemLength: 72 }, 2)).toEqual({
      offset: 5_760,
      retryAfterMs: 32,
    });
    expect(calendarListLandingRecovery({ index: 80, averageItemLength: 72 }, 7)).toEqual({
      offset: 5_760,
      retryAfterMs: 32,
    });
    expect(
      calendarListLandingRecovery({ index: 80, averageItemLength: 72 }, 8),
    ).toBeUndefined();
    expect(
      calendarListLandingRecovery({ index: 80, averageItemLength: 72 }, 40),
    ).toBeUndefined();
  });
});
