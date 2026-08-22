import {
  WORKED_EXAMPLE_ACTIVITY_IDS,
  WORKED_EXAMPLE_DATE,
  workedExampleDayResponse,
} from '@od/shared/test-fixtures';
import type { AgendaData, AgendaDay, AgendaItem } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { applyReschedule } from './applyReschedule';
import { buildUpcomingSections } from './plansWindow';

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

  it('materializes a paged Anytime fallback on a future day outside retained Agenda', () => {
    const result = applyReschedule(
      { days: [todayDay], warnings: [] },
      {
        activityId: saved.activityId,
        date: '2026-09-15',
        fallbackItem: saved,
        ...clock,
      },
    );

    expect(result.days.map(({ date }) => date)).toEqual(['2026-08-11', '2026-09-15']);
    expect(result.days[1]?.anytime).toContainEqual(
      expect.objectContaining({
        activityId: saved.activityId,
        status: 'scheduled',
      }),
    );
  });

  it('clears an overdue marker when moving the task to tomorrow so Plans renders it', () => {
    const agenda: AgendaData = {
      days: [
        { ...todayDay, anytime: [overdue] },
        {
          date: tomorrowDay.date,
          schedule: [],
          anytime: tomorrowDay.anytime,
          earlier: tomorrowDay.earlier,
        },
      ],
      warnings: [],
    };

    const result = applyReschedule(agenda, {
      activityId: overdue.activityId,
      date: tomorrowDay.date,
      ...clock,
    });
    const movedToTomorrow = result.days[1]?.anytime.find(
      ({ activityId }) => activityId === overdue.activityId,
    );

    expect(movedToTomorrow).toBeDefined();
    expect(movedToTomorrow).not.toHaveProperty('overdueFromDate');
    expect(
      buildUpcomingSections(result).flatMap((section) =>
        section.data.flatMap((item) => (item.kind === 'date' ? item.items : [])),
      ),
    ).toContainEqual(expect.objectContaining({ activityId: overdue.activityId }));
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

  it('pins a cleared schedule to today instead of the oldest retained day', () => {
    const oldDay: AgendaDay = {
      date: '2026-08-01',
      upNext: moved,
      schedule: [moved],
      anytime: [],
      earlier: [],
    };

    const result = applyReschedule(
      { days: [oldDay], warnings: [] },
      {
        activityId: moved.activityId,
        date: null,
        ...clock,
      },
    );

    expect(result.days.map(({ date }) => date)).toEqual(['2026-08-01', clock.today]);
    expect(result.days[0]?.schedule).toEqual([]);
    expect(result.days[1]?.anytime).toContainEqual(
      expect.objectContaining({
        activityId: moved.activityId,
        status: 'saved',
      }),
    );
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

/**
 * The glyph rule (`today-and-tasks.md` §5.3). A snoozed row renders a snooze glyph and its
 * original time de-emphasised; once the schedule itself moves there is no original time left to
 * contrast against, so both go. The server clears the underlying snooze on the same write —
 * `scheduleService` — and this is that fact projected, so the row stops claiming it without
 * waiting for a refetch.
 */
describe('a reschedule ends the snooze it replaced', () => {
  const snoozedDay: AgendaData = {
    days: [
      {
        ...todayDay,
        schedule: [{ ...moved, time: '18:15', isSnoozed: true, originalTime: '17:00' }],
      },
      tomorrowDay,
    ],
    warnings: [],
  };
  const rowOf = (agenda: AgendaData): AgendaItem | undefined =>
    agenda.days
      .flatMap((day) => [...day.schedule, ...day.anytime, ...day.earlier])
      .find(({ activityId }) => activityId === moved.activityId);

  it('clears the glyph and the original-time affix', () => {
    const next = applyReschedule(snoozedDay, {
      activityId: moved.activityId,
      date: '2026-08-11',
      time: '19:00',
      ...clock,
    });

    const row = rowOf(next);
    expect(row?.time).toBe('19:00');
    expect(row?.isSnoozed).toBe(false);
    expect(row?.originalTime).toBeUndefined();
  });

  it('clears them when the time is removed entirely', () => {
    const next = applyReschedule(snoozedDay, {
      activityId: moved.activityId,
      date: '2026-08-11',
      ...clock,
    });

    const row = rowOf(next);
    expect(row?.time).toBeUndefined();
    expect(row?.isSnoozed).toBe(false);
    expect(row?.originalTime).toBeUndefined();
  });
});
