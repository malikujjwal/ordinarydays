import type { AgendaData, AgendaItem } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { applyReschedule } from './applyReschedule';

const moved: AgendaItem = {
  activityId: 'act_MOVE',
  type: 'task',
  title: 'Move me',
  status: 'scheduled',
  time: '17:00',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: false, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
};
const later = { ...moved, activityId: 'act_LATER', time: '19:00' };
const tomorrow = { ...moved, activityId: 'act_TOMORROW', time: '10:00' };
const cached: AgendaData = {
  days: [
    {
      date: '2026-08-11',
      upNext: moved,
      schedule: [moved, later],
      anytime: [],
      earlier: [],
    },
    {
      date: '2026-08-12',
      upNext: tomorrow,
      schedule: [tomorrow],
      anytime: [],
      earlier: [],
    },
  ],
  warnings: [],
};
const clock = { today: '2026-08-11', currentMinute: '15:00' };

describe('applyReschedule', () => {
  it('matches the self-seeded server response for a cross-day reschedule', () => {
    const rescheduled = { ...moved, time: '09:00' };
    const recordedServerResponse: AgendaData = {
      days: [
        {
          date: '2026-08-11',
          upNext: later,
          schedule: [later],
          anytime: [],
          earlier: [],
        },
        {
          date: '2026-08-12',
          upNext: rescheduled,
          schedule: [rescheduled, tomorrow],
          anytime: [],
          earlier: [],
        },
      ],
      warnings: [],
    };

    expect(
      applyReschedule(cached, {
        activityId: moved.activityId,
        date: '2026-08-12',
        time: '09:00',
        ...clock,
      }),
    ).toEqual(recordedServerResponse);
  });

  it('returns the original cache deep-equal after the inverse reschedule', () => {
    const forward = applyReschedule(cached, {
      activityId: moved.activityId,
      date: '2026-08-12',
      time: '09:00',
      ...clock,
    });
    expect(
      applyReschedule(forward, {
        activityId: moved.activityId,
        date: '2026-08-11',
        time: '17:00',
        ...clock,
      }),
    ).toEqual(cached);
  });
});
