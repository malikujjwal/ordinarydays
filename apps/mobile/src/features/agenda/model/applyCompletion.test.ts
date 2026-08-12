import type { AgendaData, AgendaItem } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { applyCompletion } from './applyCompletion';

const task = (activityId: string, time: string): AgendaItem => ({
  activityId,
  type: 'task',
  title: activityId,
  status: 'scheduled',
  time,
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: false, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
});

const first = task('act_A', '17:00');
const second = task('act_B', '19:00');
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

describe('applyCompletion', () => {
  it('matches the self-seeded server response for task completion', () => {
    const completed = { ...first, status: 'completed' as const };
    const recordedServerResponse: AgendaData = {
      days: [
        {
          date: '2026-08-11',
          upNext: second,
          schedule: [second],
          anytime: [],
          earlier: [completed],
        },
      ],
      warnings: [],
    };

    expect(
      applyCompletion(cached, {
        activityId: first.activityId,
        completed: true,
        today: '2026-08-11',
        currentMinute: '15:00',
      }),
    ).toEqual(recordedServerResponse);
  });

  it('returns the original cache deep-equal after the compensating mutation', () => {
    const variables = {
      activityId: first.activityId,
      today: '2026-08-11',
      currentMinute: '15:00',
    };
    const completed = applyCompletion(cached, { ...variables, completed: true });

    expect(
      applyCompletion(completed, {
        ...variables,
        completed: false,
        restoredStatus: 'scheduled',
      }),
    ).toEqual(cached);
  });

  it('removes a completed rolled-forward task without inserting it into Earlier today', () => {
    const { time: _time, ...untimedFirst } = first;
    const overdue: AgendaItem = {
      ...untimedFirst,
      overdueFromDate: '2026-08-04',
    };
    const data: AgendaData = {
      days: [
        {
          date: '2026-08-11',
          schedule: [],
          anytime: [overdue],
          earlier: [],
        },
      ],
      warnings: [],
    };

    expect(
      applyCompletion(data, {
        activityId: overdue.activityId,
        completed: true,
        today: '2026-08-11',
        currentMinute: '15:00',
      }),
    ).toEqual({
      days: [
        {
          date: '2026-08-11',
          schedule: [],
          anytime: [],
          earlier: [],
        },
      ],
      warnings: [],
    });
  });
});
