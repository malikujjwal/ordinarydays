import type { ListItemPlanState } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { mayShowPlanStateLine } from './listItemRow';
import { planStateLine, spokenPlanStateLine } from './planStateLine';

/**
 * The caller-scoped Plan state line (P3-35, `plans-and-lists.md` §6.2).
 *
 * `today` is Wednesday 2026-08-12, so `2026-08-15` is this Saturday (within 7 days → weekday
 * name) and `2026-09-05` is beyond the window (→ `d MMM`).
 */
const TODAY = '2026-08-12';

function plan(overrides: Partial<ListItemPlanState> = {}): ListItemPlanState {
  return {
    type: 'event',
    status: 'scheduled',
    schedule: { date: '2026-08-15', time: '19:00', timezone: 'America/New_York' },
    ...overrides,
  };
}

describe('planStateLine', () => {
  it('renders Planned with weekday and compact time inside 7 days', () => {
    expect(planStateLine(plan(), TODAY)).toBe('Planned Saturday · 7 PM');
  });

  it('renders Next session for a watch Plan — the kind chooses the verb', () => {
    expect(
      planStateLine(
        plan({
          type: 'watch',
          schedule: { date: '2026-08-14', time: '20:00', timezone: 'America/New_York' },
        }),
        TODAY,
      ),
    ).toBe('Next session Friday · 8 PM');
  });

  it('falls back to d MMM beyond the 7-day window and keeps minutes when set', () => {
    expect(
      planStateLine(
        plan({
          schedule: { date: '2026-09-05', time: '19:30', timezone: 'America/New_York' },
        }),
        TODAY,
      ),
    ).toBe('Planned 5 Sep · 7:30 PM');
  });

  it('renders a dated line with no time suffix when the plan has no time', () => {
    expect(
      planStateLine(
        plan({ schedule: { date: '2026-08-15', timezone: 'America/New_York' } }),
        TODAY,
      ),
    ).toBe('Planned Saturday');
  });

  it('renders Done with the day and never the hour', () => {
    expect(planStateLine(plan({ status: 'completed' }), TODAY)).toBe('Done Saturday');
  });

  it('renders Cancelled with no date suffix', () => {
    expect(planStateLine(plan({ status: 'cancelled' }), TODAY)).toBe('Cancelled');
    const undated: ListItemPlanState = { type: 'event', status: 'cancelled' };
    expect(planStateLine(undated, TODAY)).toBe('Cancelled');
  });

  it('renders nothing for saved, skipped, or a scheduled plan with no date', () => {
    const saved: ListItemPlanState = { type: 'event', status: 'saved' };
    expect(planStateLine(saved, TODAY)).toBeUndefined();
    // A skip clears the pointer, so a skipped projection is stale and renders nothing.
    expect(planStateLine(plan({ status: 'skipped' }), TODAY)).toBeUndefined();
    const dateless: ListItemPlanState = { type: 'event', status: 'scheduled' };
    expect(planStateLine(dateless, TODAY)).toBeUndefined();
    expect(planStateLine(undefined, TODAY)).toBeUndefined();
  });

  it('speaks the unabbreviated time for the accessibility label', () => {
    expect(spokenPlanStateLine(plan(), TODAY)).toBe('Planned Saturday 7:00 PM');
  });
});

describe('mayShowPlanStateLine', () => {
  it('needs a date or a cancellation — link presence alone is never eligibility', () => {
    expect(mayShowPlanStateLine(plan())).toBe(true);
    expect(mayShowPlanStateLine(plan({ status: 'completed' }))).toBe(true);
    expect(mayShowPlanStateLine({ type: 'event', status: 'cancelled' })).toBe(true);
    expect(mayShowPlanStateLine({ type: 'event', status: 'saved' })).toBe(false);
    expect(mayShowPlanStateLine(plan({ status: 'skipped' }))).toBe(false);
    expect(mayShowPlanStateLine({ type: 'event', status: 'scheduled' })).toBe(false);
    expect(mayShowPlanStateLine(undefined)).toBe(false);
  });
});
