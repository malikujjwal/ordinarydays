import {
  WORKED_EXAMPLE_ACTIVITY_IDS,
  WORKED_EXAMPLE_DATE,
  workedExampleDayResponse,
} from '@od/shared/test-fixtures';
import type { AgendaData, AgendaDay, AgendaItem } from '@od/shared/types';
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
const todayDay: AgendaDay = {
  date: '2026-08-11',
  upNext: moved,
  schedule: [moved, later],
  anytime: [],
  earlier: [],
};
const tomorrowDay: AgendaDay = {
  date: '2026-08-12',
  upNext: tomorrow,
  schedule: [tomorrow],
  anytime: [],
  earlier: [],
};
const cached: AgendaData = {
  days: [todayDay, tomorrowDay],
  warnings: [],
};
const clock = { today: '2026-08-11', currentMinute: '15:00' };

const saved: AgendaItem = {
  activityId: 'act_SAVED',
  type: 'task',
  title: 'Already saved',
  status: 'saved',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: false, snooze: false },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
};

const overdue: AgendaItem = {
  ...saved,
  activityId: 'act_OVERDUE',
  title: 'Rolled forward',
  status: 'scheduled',
  overdueFromDate: '2026-08-10',
};

describe('applyReschedule', () => {
  it('matches the captured worked-example response for a same-day reschedule', () => {
    const canonical = workedExampleDayResponse();
    const expected = workedExampleDayResponse();
    const day = expected.days[0];
    const groceries = day?.schedule.find(
      ({ activityId }) => activityId === WORKED_EXAMPLE_ACTIVITY_IDS.groceries,
    );
    if (day === undefined || groceries === undefined) {
      throw new Error('The worked example fixture is incomplete.');
    }
    const [, gym, tacos, severance] = day.schedule;
    if (gym === undefined || tacos === undefined || severance === undefined) {
      throw new Error('The worked example schedule is incomplete.');
    }
    const rescheduled = { ...groceries, time: '19:00' };
    day.upNext = gym;
    day.schedule = [gym, rescheduled, tacos, severance];

    expect(
      applyReschedule(canonical, {
        activityId: WORKED_EXAMPLE_ACTIVITY_IDS.groceries,
        date: WORKED_EXAMPLE_DATE,
        time: '19:00',
        today: WORKED_EXAMPLE_DATE,
        currentMinute: '15:10',
      }),
    ).toEqual(expected);
  });

  it('returns the original cache deep-equal after the inverse reschedule', () => {
    const canonical = workedExampleDayResponse();
    const variables = {
      activityId: WORKED_EXAMPLE_ACTIVITY_IDS.groceries,
      date: WORKED_EXAMPLE_DATE,
      today: WORKED_EXAMPLE_DATE,
      currentMinute: '15:10',
    };
    const forward = applyReschedule(canonical, {
      ...variables,
      time: '19:00',
    });
    expect(
      applyReschedule(forward, {
        ...variables,
        time: '17:30',
      }),
    ).toEqual(canonical);
  });

  it('returns the same cache reference when the target is absent', () => {
    expect(
      applyReschedule(cached, {
        activityId: 'act_MISSING',
        date: '2026-08-12',
        ...clock,
      }),
    ).toBe(cached);
  });

  it('clears date, time, end time, and overdue state into sorted Anytime', () => {
    const source = {
      ...moved,
      endTime: '18:00',
      overdueFromDate: '2026-08-10',
    };
    const secondOverdue = { ...overdue, activityId: 'act_OVERDUE_B' };
    const undatedA = { ...overdue, activityId: 'act_UNDATED_A' };
    const undatedB = { ...overdue, activityId: 'act_UNDATED_B' };
    delete undatedA.overdueFromDate;
    delete undatedB.overdueFromDate;
    const agenda: AgendaData = {
      ...cached,
      days: [
        {
          ...todayDay,
          upNext: source,
          schedule: [source, later],
          anytime: [saved, overdue, secondOverdue, undatedA, undatedB],
        },
        tomorrowDay,
      ],
    };

    const result = applyReschedule(agenda, {
      activityId: moved.activityId,
      date: null,
      ...clock,
    });

    expect(result.days[0]?.anytime.map(({ activityId }) => activityId)).toEqual([
      'act_OVERDUE',
      'act_OVERDUE_B',
      'act_UNDATED_A',
      'act_UNDATED_B',
      'act_SAVED',
      'act_MOVE',
    ]);
    expect(result.days[0]?.anytime.at(-1)).not.toHaveProperty('time');
    expect(result.days[0]?.anytime.at(-1)).not.toHaveProperty('endTime');
    expect(result.days[0]?.anytime.at(-1)).not.toHaveProperty('overdueFromDate');
    expect(result.days[0]?.anytime.at(-1)).toMatchObject({
      status: 'saved',
      isPast: false,
    });
  });

  it('marks a same-day move past once its end time has elapsed', () => {
    const result = applyReschedule(cached, {
      activityId: moved.activityId,
      date: clock.today,
      time: '14:00',
      endTime: '14:30',
      ...clock,
    });

    expect(result.days[0]?.earlier[0]).toMatchObject({
      activityId: moved.activityId,
      time: '14:00',
      endTime: '14:30',
      isPast: true,
    });
  });

  it.each(['completed', 'skipped'] as const)(
    'preserves a %s status when the row is moved',
    (status) => {
      const resolved = { ...moved, status };
      const agenda: AgendaData = {
        ...cached,
        days: [{ ...todayDay, upNext: later, schedule: [resolved, later] }, tomorrowDay],
      };

      const result = applyReschedule(agenda, {
        activityId: moved.activityId,
        date: '2026-08-12',
        time: '16:00',
        ...clock,
      });

      expect(result.days[1]?.schedule).toContainEqual(
        expect.objectContaining({ activityId: moved.activityId, status }),
      );
    },
  );
});
