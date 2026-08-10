import type { ActivityListItem } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { rowLabel, rowState, rowSubtitle } from './rows';

const item = (overrides: Partial<ActivityListItem> = {}): ActivityListItem => ({
  activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  type: 'event',
  title: 'Dinner at Zahav',
  status: 'scheduled',
  isRecurring: false,
  participantCount: 0,
  ...overrides,
});

describe('rowSubtitle', () => {
  it('joins the time and the server-built subtitle', () => {
    expect(rowSubtitle(item({ time: '19:30', subtitle: 'Zahav' }))).toBe(
      '7:30 PM · Zahav',
    );
  });

  it.each([
    ['00:00', '12:00 AM'],
    ['12:00', '12:00 PM'],
    ['09:05', '9:05 AM'],
  ])('renders %s as %s', (time, expected) => {
    expect(rowSubtitle(item({ time }))).toBe(expected);
  });

  it('drops the separator when only one part is there', () => {
    expect(rowSubtitle(item({ subtitle: 'Meal · Dinner' }))).toBe('Meal · Dinner');
    expect(rowSubtitle(item({ time: '19:30' }))).toBe('7:30 PM');
  });

  /** An untimed activity with nothing to say gets no second line at all, not an empty one. */
  it('is absent when there is nothing to say', () => {
    expect(rowSubtitle(item())).toBeUndefined();
    expect(rowSubtitle(item({ subtitle: '' }))).toBeUndefined();
  });
});

describe('rowState', () => {
  it.each([
    ['saved', false, false],
    ['scheduled', false, false],
    ['completed', true, true],
    // Skipped and cancelled recede, but neither was *done* — striking them would say it was.
    ['skipped', true, false],
    ['cancelled', true, false],
  ] as const)('%s → dimmed %s, struck %s', (status, dimmed, struck) => {
    expect(rowState(item({ status }))).toEqual({ dimmed, struck });
  });
});

describe('rowLabel', () => {
  it('is the visible text when there is nothing extra', () => {
    expect(rowLabel(item({ time: '19:30', subtitle: 'Zahav' }))).toBe(
      'Dinner at Zahav · 7:30 PM · Zahav',
    );
  });

  /**
   * The repeat marker and the completed styling are visual. Colour and an icon are never the
   * only carriers of meaning (`design-system.md` §5.1), so both go into the name a screen
   * reader announces rather than becoming facts only sighted users get.
   */
  it('says a series repeats, which the visible row only draws', () => {
    expect(rowLabel(item({ isRecurring: true }))).toBe('Dinner at Zahav · Repeats');
  });

  it('says a row is completed, which the visible row only strikes', () => {
    expect(rowLabel(item({ status: 'completed' }))).toBe('Dinner at Zahav · Completed');
  });
});
