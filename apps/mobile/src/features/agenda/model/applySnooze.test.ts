import {
  WORKED_EXAMPLE_ACTIVITY_IDS,
  WORKED_EXAMPLE_DATE,
  workedExampleDayResponse,
} from '@od/shared/test-fixtures';
import { describe, expect, it } from 'vitest';
import { applySnooze } from './applySnooze';

const target = {
  activityId: WORKED_EXAMPLE_ACTIVITY_IDS.gym,
  occurrenceDate: WORKED_EXAMPLE_DATE,
  date: WORKED_EXAMPLE_DATE,
  today: WORKED_EXAMPLE_DATE,
  currentMinute: '15:10',
};

describe('applySnooze', () => {
  it('matches the captured worked-example response and re-sorts by effective time', () => {
    const cached = workedExampleDayResponse();
    const expected = workedExampleDayResponse();
    const day = expected.days[0];
    const gym = day?.schedule.find(
      ({ activityId }) => activityId === WORKED_EXAMPLE_ACTIVITY_IDS.gym,
    );
    if (day === undefined || gym === undefined) {
      throw new Error('The worked example fixture is incomplete.');
    }
    const snoozed = {
      ...gym,
      time: '20:00',
      originalTime: '18:00',
      isSnoozed: true,
    };
    const [groceries, , tacos, severance] = day.schedule;
    if (groceries === undefined || tacos === undefined || severance === undefined) {
      throw new Error('The worked example schedule is incomplete.');
    }
    day.schedule = [groceries, tacos, snoozed, severance];

    expect(applySnooze(cached, { ...target, snoozed: true, time: '20:00' })).toEqual(
      expected,
    );
  });

  it('returns the captured cache deep-equal after unsnooze', () => {
    const cached = workedExampleDayResponse();
    const snoozed = applySnooze(cached, {
      ...target,
      snoozed: true,
      time: '20:00',
    });
    expect(applySnooze(snoozed, { ...target, snoozed: false })).toEqual(cached);
  });
});
