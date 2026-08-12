import type { AgendaData, AgendaItem } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { applySnooze } from './applySnooze';

const first: AgendaItem = {
  activityId: 'act_SERIES',
  occurrenceDate: '2026-08-11',
  type: 'task',
  title: 'Daily stretch',
  status: 'scheduled',
  time: '17:00',
  isRecurring: true,
  recurrenceDescription: 'Every day',
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: true, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
};
const second = {
  ...first,
  activityId: 'act_LATER',
  occurrenceDate: '2026-08-11',
  time: '19:00',
};
const cached: AgendaData = {
  days: [
    {
      date: '2026-08-11',
      upNext: first,
      schedule: [first, second],
      anytime: [],
      earlier: [],
    },
  ],
  warnings: [],
};
const target = {
  activityId: first.activityId,
  occurrenceDate: '2026-08-11',
  date: '2026-08-11',
  today: '2026-08-11',
  currentMinute: '15:00',
};

describe('applySnooze', () => {
  it('matches the self-seeded server response and re-sorts by effective time', () => {
    const snoozed = {
      ...first,
      time: '20:00',
      originalTime: '17:00',
      isSnoozed: true,
    };
    const recordedServerResponse: AgendaData = {
      days: [
        {
          date: '2026-08-11',
          upNext: second,
          schedule: [second, snoozed],
          anytime: [],
          earlier: [],
        },
      ],
      warnings: [],
    };

    expect(applySnooze(cached, { ...target, snoozed: true, time: '20:00' })).toEqual(
      recordedServerResponse,
    );
  });

  it('returns the original cache deep-equal after unsnooze', () => {
    const snoozed = applySnooze(cached, {
      ...target,
      snoozed: true,
      time: '20:00',
    });
    expect(applySnooze(snoozed, { ...target, snoozed: false })).toEqual(cached);
  });
});
