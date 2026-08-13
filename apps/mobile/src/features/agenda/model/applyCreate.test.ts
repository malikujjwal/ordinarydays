import type { Activity, AgendaData, AgendaDay, AgendaItem } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { applyCreate } from './applyCreate';

const existing: AgendaItem = {
  activityId: 'act_EXISTING',
  type: 'task',
  title: 'Already here',
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
const todayDay: AgendaDay = {
  date: '2026-08-11',
  upNext: existing,
  schedule: [existing],
  anytime: [],
  earlier: [],
};
const tomorrowDay: AgendaDay = {
  date: '2026-08-12',
  schedule: [],
  anytime: [],
  earlier: [],
};
const cached: AgendaData = { days: [todayDay, tomorrowDay], warnings: [] };
const clock = { today: '2026-08-11', currentMinute: '15:00' };

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    activityId: 'act_NEW',
    objectKind: 'task',
    type: 'task',
    title: 'Fresh task',
    status: 'scheduled',
    details: { kind: 'task' },
    createdAt: '2026-08-11T15:00:00.000Z',
    updatedAt: '2026-08-11T15:00:00.000Z',
    lastActivityAt: '2026-08-11T15:00:00.000Z',
    ...overrides,
  } as Activity;
}

const titles = (
  agenda: AgendaData,
  date: string,
  bucket: 'schedule' | 'anytime' | 'earlier',
) => (agenda.days.find((day) => day.date === date)?.[bucket] ?? []).map((i) => i.title);

describe('applyCreate', () => {
  it('places a dated task into its own day, without waiting for a refetch', () => {
    const next = applyCreate(cached, {
      activity: activity({
        schedule: { date: '2026-08-12', time: '09:00', timezone: 'America/New_York' },
      }),
      ...clock,
    });

    expect(titles(next, '2026-08-12', 'schedule')).toEqual(['Fresh task']);
    expect(titles(next, '2026-08-11', 'schedule')).toEqual(['Already here']);
  });

  it('places an undated task into the first window day as an ANYTIME row', () => {
    const next = applyCreate(cached, {
      activity: activity({ status: 'saved' }),
      ...clock,
    });

    expect(titles(next, '2026-08-11', 'anytime')).toEqual(['Fresh task']);
    expect(titles(next, '2026-08-11', 'schedule')).toEqual(['Already here']);
  });

  /** The reconciling refetch may still land; it must not produce a second row. */
  it('is idempotent when the window already holds the activity', () => {
    const created = activity({
      schedule: { date: '2026-08-11', time: '18:00', timezone: 'America/New_York' },
    });
    const once = applyCreate(cached, { activity: created, ...clock });
    const twice = applyCreate(once, { activity: created, ...clock });

    expect(titles(twice, '2026-08-11', 'schedule')).toEqual(
      titles(once, '2026-08-11', 'schedule'),
    );
    expect(titles(twice, '2026-08-11', 'schedule')).toHaveLength(2);
  });

  it('leaves a window alone when the activity falls outside it', () => {
    const next = applyCreate(cached, {
      activity: activity({
        schedule: { date: '2026-09-30', timezone: 'America/New_York' },
      }),
      ...clock,
    });

    expect(next).toEqual(cached);
  });

  it('marks a row created earlier today as past, so it sorts into EARLIER TODAY', () => {
    const next = applyCreate(cached, {
      activity: activity({
        schedule: { date: '2026-08-11', time: '09:00', timezone: 'America/New_York' },
      }),
      ...clock,
    });

    expect(titles(next, '2026-08-11', 'earlier')).toEqual(['Fresh task']);
  });
});
