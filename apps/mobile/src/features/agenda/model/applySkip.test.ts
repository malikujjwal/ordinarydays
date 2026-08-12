import {
  WORKED_EXAMPLE_ACTIVITY_IDS,
  WORKED_EXAMPLE_DATE,
  workedExampleDayResponse,
} from '@od/shared/test-fixtures';
import { describe, expect, it } from 'vitest';
import { applySkip } from './applySkip';

const target = {
  activityId: WORKED_EXAMPLE_ACTIVITY_IDS.gym,
  occurrenceDate: WORKED_EXAMPLE_DATE,
  today: WORKED_EXAMPLE_DATE,
  currentMinute: '15:10',
};

describe('applySkip', () => {
  it('matches the captured worked-example response for an occurrence skip', () => {
    const cached = workedExampleDayResponse();
    const expected = workedExampleDayResponse();
    const day = expected.days[0];
    const gym = day?.schedule.find(
      ({ activityId }) => activityId === WORKED_EXAMPLE_ACTIVITY_IDS.gym,
    );
    if (day === undefined || gym === undefined) {
      throw new Error('The worked example fixture is incomplete.');
    }
    day.schedule = day.schedule.filter(
      ({ activityId }) => activityId !== WORKED_EXAMPLE_ACTIVITY_IDS.gym,
    );
    day.earlier = [{ ...gym, status: 'skipped_occurrence' }, ...day.earlier];

    expect(applySkip(cached, { ...target, skipped: true })).toEqual(expected);
  });

  it('returns the captured cache deep-equal after the compensating mutation', () => {
    const cached = workedExampleDayResponse();
    const skipped = applySkip(cached, { ...target, skipped: true });
    expect(applySkip(skipped, { ...target, skipped: false })).toEqual(cached);
  });
});
