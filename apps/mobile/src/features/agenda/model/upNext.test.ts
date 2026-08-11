import { fixedClock, type Instant, type TimeZone } from '@od/shared/time';
import type { AgendaItem } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { selectUpNext } from './upNext';

const timezone = 'UTC' as TimeZone;

function item(
  activityId: string,
  time?: string,
  patch: Partial<AgendaItem> = {},
): AgendaItem {
  return {
    activityId,
    type: 'task',
    title: activityId,
    status: 'scheduled',
    ...(time === undefined ? {} : { time }),
    isRecurring: false,
    isSnoozed: false,
    hasCheckbox: true,
    capabilities: { complete: true, skip: false, snooze: true },
    participantAvatars: [],
    participantCount: 0,
    isPast: false,
    ...patch,
  };
}

describe('selectUpNext', () => {
  const rows = [
    item('act_earlier', '17:00', { endTime: '17:45' }),
    item('act_groceries', '17:30'),
    item('act_gym', '18:00'),
  ];

  it.each([
    ['2026-08-06T17:29:00.000Z', 'act_groceries', 'in 1 minute'],
    ['2026-08-06T17:30:00.000Z', 'act_groceries', 'now'],
    ['2026-08-06T17:31:00.000Z', 'act_gym', 'in 29 minutes'],
  ] as const)(
    'advances at %s using a frozen clock',
    (instant, activityId, relativeTime) => {
      expect(selectUpNext(rows, fixedClock(instant as Instant), timezone)).toMatchObject({
        item: { activityId },
        relativeTime,
      });
    },
  );

  it('excludes untimed, overdue, and resolved rows and rounds hour copy', () => {
    const selection = selectUpNext(
      [
        item('act_untimed'),
        item('act_overdue', '16:00', { overdueFromDate: '2026-08-05' }),
        item('act_completed', '16:30', { status: 'completed' }),
        item('act_later', '17:30'),
      ],
      fixedClock('2026-08-06T15:10:00.000Z' as Instant),
      timezone,
    );

    expect(selection).toMatchObject({
      item: { activityId: 'act_later' },
      relativeTime: 'in 2 hours',
    });
  });
});
