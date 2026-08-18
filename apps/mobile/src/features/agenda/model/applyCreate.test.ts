import type { CreateActivityInput } from '@od/shared/schemas';
import type { Activity, AgendaData, AgendaDay, AgendaItem } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { applyCreate, applyPendingCreate } from './applyCreate';

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

  it('expands a new recurrence across every cached day immediately', () => {
    const next = applyCreate(cached, {
      activity: activity({
        schedule: { date: '2026-08-11', time: '18:00', timezone: 'America/New_York' },
        recurrence: {
          mode: 'fixed',
          segments: [{ freq: 'daily', interval: 1, effectiveFrom: '2026-08-11' }],
        },
      }),
      ...clock,
    });

    const rows = next.days.flatMap((day) =>
      [...day.schedule, ...day.anytime, ...day.earlier].filter(
        (row) => row.activityId === 'act_NEW',
      ),
    );
    expect(rows.map((row) => row.occurrenceDate)).toEqual(['2026-08-11', '2026-08-12']);
    expect(rows.every((row) => row.recurrenceDescription === 'Daily')).toBe(true);
  });
});

/**
 * The offline half (P2-49). A create the server has not seen yet still renders, under the
 * permanent id the client minted for it.
 */
describe('applyPendingCreate', () => {
  const CLIENT_ID = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
  const input = {
    objectKind: 'task',
    type: 'task',
    title: 'Written on the subway',
    schedule: { date: '2026-08-12', time: '09:00', timezone: 'America/New_York' },
  } as const;

  const pending = () =>
    applyPendingCreate(cached, {
      input,
      activityId: CLIENT_ID,
      mintedAt: '2026-08-11T15:00:00.000Z',
      ...clock,
    });

  it('renders the row from local input, under its permanent id', () => {
    const next = pending();

    expect(titles(next, '2026-08-12', 'schedule')).toEqual(['Written on the subway']);
    // The id it will keep for the rest of its life — no temporary id to rewrite later.
    expect(next.days[1]?.schedule[0]?.activityId).toBe(CLIENT_ID);
  });

  it('projects only what the client can compute correctly', () => {
    const row = pending().days[1]?.schedule[0];

    // Everything here came from the user; no server state can contradict it.
    expect(row).toMatchObject({
      type: 'task',
      time: '09:00',
      status: 'scheduled',
      hasCheckbox: true,
      isRecurring: false,
    });
  });

  it('lets the 201 replace it wholesale, since only the server owns the rest', () => {
    const projected = pending();
    const reconciled = applyCreate(projected, {
      activity: activity({
        activityId: CLIENT_ID,
        title: 'Written on the subway',
        schedule: { date: '2026-08-12', time: '09:00', timezone: 'America/New_York' },
        ownerId: 'usr_real',
        createdAt: '2026-08-11T15:00:04.000Z',
      }),
      reconcile: true,
      ...clock,
    });

    const rows = reconciled.days[1]?.schedule ?? [];
    // Reconciled in place: one row, still the client's id, now carrying server truth.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.activityId).toBe(CLIENT_ID);
  });

  it('does not double the row when the 201 arrives without reconcile', () => {
    const projected = pending();
    const again = applyCreate(projected, {
      activity: activity({
        activityId: CLIENT_ID,
        schedule: { date: '2026-08-12', time: '09:00', timezone: 'America/New_York' },
      }),
      ...clock,
    });

    expect(again.days[1]?.schedule).toHaveLength(1);
  });

  it('expands a pending recurrence locally and lets the 201 replace the whole expansion', () => {
    const recurringInput: CreateActivityInput = {
      ...input,
      schedule: { date: '2026-08-11', time: '18:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', interval: 1, effectiveFrom: '2026-08-11' }],
      },
    };
    const projected = applyPendingCreate(cached, {
      input: recurringInput,
      activityId: CLIENT_ID,
      mintedAt: '2026-08-11T15:00:00.000Z',
      ...clock,
    });

    const pendingRows = projected.days.flatMap((day) =>
      [...day.schedule, ...day.anytime, ...day.earlier].filter(
        (row) => row.activityId === CLIENT_ID,
      ),
    );
    expect(pendingRows.map((row) => row.occurrenceDate)).toEqual([
      '2026-08-11',
      '2026-08-12',
    ]);

    const reconciled = applyCreate(projected, {
      activity: activity({
        activityId: CLIENT_ID,
        title: 'Canonical title',
        schedule: recurringInput.schedule as NonNullable<Activity['schedule']>,
        recurrence: recurringInput.recurrence as NonNullable<Activity['recurrence']>,
      }),
      reconcile: true,
      ...clock,
    });
    const canonicalRows = reconciled.days.flatMap((day) =>
      [...day.schedule, ...day.anytime, ...day.earlier].filter(
        (row) => row.activityId === CLIENT_ID,
      ),
    );
    expect(canonicalRows).toHaveLength(2);
    expect(canonicalRows.every((row) => row.title === 'Canonical title')).toBe(true);
  });
});
