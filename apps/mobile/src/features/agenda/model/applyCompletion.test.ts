import {
  WORKED_EXAMPLE_ACTIVITY_IDS,
  WORKED_EXAMPLE_DATE,
  workedExampleDayResponse,
} from '@od/shared/test-fixtures';
import { describe, expect, it } from 'vitest';
import { applyCompletion } from './applyCompletion';

const clock = { today: WORKED_EXAMPLE_DATE, currentMinute: '15:10' };

describe('applyCompletion', () => {
  it('matches the captured worked-example response after task completion', () => {
    const cached = workedExampleDayResponse();
    const expected = workedExampleDayResponse();
    const day = expected.days[0];
    const groceries = day?.schedule.find(
      ({ activityId }) => activityId === WORKED_EXAMPLE_ACTIVITY_IDS.groceries,
    );
    if (day === undefined || groceries === undefined) {
      throw new Error('The worked example fixture is incomplete.');
    }
    day.schedule = day.schedule.filter(
      ({ activityId }) => activityId !== WORKED_EXAMPLE_ACTIVITY_IDS.groceries,
    );
    const next = day.schedule[0];
    if (next === undefined) throw new Error('The worked example schedule is incomplete.');
    day.upNext = next;
    day.earlier = [{ ...groceries, status: 'completed' }, ...day.earlier];

    expect(
      applyCompletion(cached, {
        activityId: WORKED_EXAMPLE_ACTIVITY_IDS.groceries,
        completed: true,
        ...clock,
      }),
    ).toEqual(expected);
  });

  it('returns the captured cache deep-equal after the compensating mutation', () => {
    const cached = workedExampleDayResponse();
    const variables = {
      activityId: WORKED_EXAMPLE_ACTIVITY_IDS.groceries,
      ...clock,
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
    const cached = workedExampleDayResponse();
    const expected = workedExampleDayResponse();
    const day = expected.days[0];
    if (day === undefined) throw new Error('The worked example fixture is incomplete.');
    day.anytime = day.anytime.filter(
      ({ activityId }) => activityId !== WORKED_EXAMPLE_ACTIVITY_IDS.apartment,
    );

    expect(
      applyCompletion(cached, {
        activityId: WORKED_EXAMPLE_ACTIVITY_IDS.apartment,
        completed: true,
        ...clock,
      }),
    ).toEqual(expected);
  });
});
