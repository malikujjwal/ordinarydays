import { expandRecurrence } from '@od/shared/recurrence';
import type { Activity } from '@od/shared/types';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestTable } from './harness.js';

useTestTable();

type ActivityRepository = typeof import('../../src/repositories/activityRepository.js');
type OccurrenceRepository =
  typeof import('../../src/repositories/occurrenceRepository.js');
type ReminderRepository = typeof import('../../src/repositories/reminderRepository.js');
type AgendaService = typeof import('../../src/services/agendaService.js');
type Base = typeof import('../../src/repositories/base.js');
type Keys = typeof import('../../src/repositories/keys.js');

let activities: ActivityRepository;
let occurrences: OccurrenceRepository;
let reminders: ReminderRepository;
let agenda: AgendaService;
let base: Base;
let keys: Keys;

beforeAll(async () => {
  activities = await import('../../src/repositories/activityRepository.js');
  occurrences = await import('../../src/repositories/occurrenceRepository.js');
  reminders = await import('../../src/repositories/reminderRepository.js');
  agenda = await import('../../src/services/agendaService.js');
  base = await import('../../src/repositories/base.js');
  keys = await import('../../src/repositories/keys.js');
});

let sequence = 0;
const nextId = () => `act_01J8XKQ2M4N5P6R7S8T9V0${String(sequence++).padStart(4, '0')}`;

function subject(overrides: Partial<Activity>): Activity {
  const stamp = '2026-08-01T10:00:00.000Z';
  return {
    activityId: nextId(),
    ownerId: 'usr_alice',
    objectKind: 'task',
    type: 'task',
    status: 'scheduled',
    title: 'Task',
    details: { kind: 'task' },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: stamp,
    lastActivityAt: stamp,
    updatedAt: stamp,
    schemaVersion: 1,
    ...overrides,
  } as Activity;
}

describe('the worked-example day', () => {
  it('hydrates, expands, orders and never reads Needs a date', async () => {
    const oats = subject({
      type: 'meal',
      objectKind: 'plan',
      title: 'Overnight oats',
      status: 'completed',
      details: { kind: 'meal', mealSlot: 'breakfast' },
      schedule: { date: '2026-08-06', time: '08:00', timezone: 'America/New_York' },
      completedAt: '2026-08-06T12:05:00.000Z',
    });
    const dentist = subject({
      type: 'event',
      objectKind: 'plan',
      title: 'Dentist appointment',
      details: { kind: 'event' },
      schedule: { date: '2026-08-06', time: '14:30', timezone: 'America/New_York' },
      location: { label: 'Dr Patel' },
    });
    const groceries = subject({
      title: 'Pick up groceries',
      schedule: { date: '2026-08-06', time: '17:30', timezone: 'America/New_York' },
    });
    const gym = subject({
      title: 'Gym',
      schedule: { date: '2026-01-05', time: '18:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'weekdays', effectiveFrom: '2026-01-05', time: '18:00' }],
      },
    });
    const tacos = subject({
      type: 'meal',
      objectKind: 'plan',
      title: 'Chicken tacos',
      details: { kind: 'meal', mealSlot: 'dinner' },
      schedule: { date: '2026-08-06', time: '19:30', timezone: 'America/New_York' },
    });
    const severance = subject({
      type: 'watch',
      objectKind: 'plan',
      title: 'Severance',
      details: { kind: 'watch', mediaTitle: 'Severance', season: 2, episode: 4 },
      schedule: { date: '2026-08-06', time: '20:00', timezone: 'America/New_York' },
    });
    const insurance = subject({
      title: 'Submit insurance form',
      schedule: { date: '2026-08-06', timezone: 'America/New_York' },
    });
    const anytime = subject({
      title: 'Book flights for New York',
      status: 'saved',
    });
    const needsDate = subject({
      objectKind: 'plan',
      type: 'custom',
      title: 'Dinner at Zahav',
      details: { kind: 'custom' },
      status: 'saved',
    });

    for (const row of [
      oats,
      dentist,
      groceries,
      gym,
      tacos,
      severance,
      insurance,
      anytime,
      needsDate,
    ]) {
      await activities.createActivity('usr_alice', row);
    }
    await base.putItem({
      ...keys.reminder(groceries.activityId, 'usr_alice', 'rem_alice'),
      entity: 'Reminder',
      reminderId: 'rem_01J8XKQ2M4N5P6R7S8T9V0W1AA',
      activityId: groceries.activityId,
      userId: 'usr_alice',
      offsetMinutes: -15,
      channel: 'push',
      createdAt: oats.createdAt,
      updatedAt: oats.updatedAt,
      schemaVersion: 1,
    });
    await base.putItem({
      ...keys.reminder(groceries.activityId, 'usr_bob', 'rem_bob'),
      entity: 'Reminder',
      reminderId: 'rem_01J8XKQ2M4N5P6R7S8T9V0W1AB',
      activityId: groceries.activityId,
      userId: 'usr_bob',
      offsetMinutes: -60,
      channel: 'push',
      createdAt: oats.createdAt,
      updatedAt: oats.updatedAt,
      schemaVersion: 1,
    });

    const queried: string[] = [];
    const result = await agenda.assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-06',
        to: '2026-08-06',
        timezone: 'America/New_York',
        now: '2026-08-06T19:10:00.000Z',
        includeAnytimeUnscheduled: true,
        includeReminders: true,
      },
      {
        listBucket: async (...args) => {
          queried.push(args[1]);
          return activities.listByBucket(...args);
        },
        batchActivities: activities.batchGetActivityMeta,
        listParticipants: activities.listParticipants,
        batchAgendaRows: occurrences.batchGetAgendaRows,
        batchOccurrences: occurrences.batchGetForPairs,
        listReminders: reminders.listForUser,
        expand: expandRecurrence,
        warn: vi.fn(),
      },
    );

    const baselineQueried: string[] = [];
    const baseline = await agenda.assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-06',
        to: '2026-08-06',
        timezone: 'America/New_York',
        now: '2026-08-06T19:10:00.000Z',
      },
      {
        listBucket: async (...args) => {
          baselineQueried.push(args[1]);
          return activities.listByBucket(...args);
        },
        batchActivities: activities.batchGetActivityMeta,
        listParticipants: activities.listParticipants,
        batchAgendaRows: occurrences.batchGetAgendaRows,
        batchOccurrences: occurrences.batchGetForPairs,
        listReminders: reminders.listForUser,
        expand: expandRecurrence,
        warn: vi.fn(),
      },
    );

    const day = result.days[0];
    expect(queried).toEqual(['S', 'R', 'N']);
    expect(queried).not.toContain('P');
    expect(baselineQueried).toEqual(['S', 'R']);
    expect(baselineQueried).not.toContain('P');
    expect(JSON.stringify(baseline)).not.toContain('Dinner at Zahav');
    expect(day?.upNext?.activity.title).toBe('Pick up groceries');
    expect(day?.schedule.map((row) => row.activity.title)).toEqual([
      'Pick up groceries',
      'Gym',
      'Chicken tacos',
      'Severance',
    ]);
    expect(day?.anytime.map((row) => row.activity.title)).toEqual([
      'Submit insurance form',
      'Book flights for New York',
    ]);
    expect(day?.earlier.map((row) => row.activity.title)).toEqual([
      'Dentist appointment',
      'Overnight oats',
    ]);
    expect(
      day?.schedule.find((row) => row.activity.activityId === groceries.activityId)
        ?.reminders,
    ).toEqual([expect.objectContaining({ userId: 'usr_alice', offsetMinutes: -15 })]);
    expect(JSON.stringify(result)).not.toContain('usr_bob');
    expect(JSON.stringify(result)).not.toContain('Dinner at Zahav');
  });
});
