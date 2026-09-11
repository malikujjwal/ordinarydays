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

let activities: ActivityRepository;
let occurrences: OccurrenceRepository;
let reminders: ReminderRepository;
let agenda: AgendaService;

beforeAll(async () => {
  activities = await import('../../src/repositories/activityRepository.js');
  occurrences = await import('../../src/repositories/occurrenceRepository.js');
  reminders = await import('../../src/repositories/reminderRepository.js');
  agenda = await import('../../src/services/agendaService.js');
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

describe('overdue roll-forward', () => {
  it('rolls only the bounded task forward and completion preserves its stored date', async () => {
    const overdue = subject({
      title: 'Call apartment office',
      schedule: { date: '2026-08-04', timezone: 'America/New_York' },
    });
    const tooOld = subject({
      title: 'Forgotten task',
      schedule: { date: '2026-06-27', timezone: 'America/New_York' },
    });
    const event = subject({
      objectKind: 'plan',
      type: 'event',
      title: 'Past event',
      details: { kind: 'event' },
      schedule: { date: '2026-08-05', timezone: 'America/New_York' },
    });
    const recurring = subject({
      title: 'Daily task',
      schedule: { date: '2026-08-01', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
      },
    });
    for (const row of [overdue, tooOld, event, recurring]) {
      await activities.createActivity('usr_alice', row);
    }

    const result = await agenda.assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-06',
        to: '2026-08-06',
        timezone: 'America/New_York',
        now: '2026-08-06T16:00:00.000Z',
        includeOverdue: true,
      },
      {
        listBucket: activities.listByBucket,
        listOverdue: activities.listOverdueTaskCandidates,
        batchActivities: activities.batchGetActivityMeta,
        listParticipants: activities.listParticipants,
        batchAgendaRows: occurrences.batchGetAgendaRows,
        batchOccurrences: occurrences.batchGetForPairs,
        listReminders: reminders.listForUser,
        expand: expandRecurrence,
        warn: vi.fn(),
      },
    );

    const overdueItems = result.days[0]?.anytime.filter(
      (item) => item.overdueFromDate !== undefined,
    );
    expect(overdueItems).toEqual([
      expect.objectContaining({
        activity: expect.objectContaining({ activityId: overdue.activityId }),
        overdueFromDate: '2026-08-04',
      }),
    ]);
    // `projectionVersions` may name an index row the read hydrated but did not emit.
    expect(JSON.stringify(result.days)).not.toContain(tooOld.activityId);
    expect(JSON.stringify(result.days)).not.toContain(event.activityId);
    expect(result.days[0]?.anytime).toContainEqual(
      expect.objectContaining({
        activity: expect.objectContaining({ activityId: recurring.activityId }),
        occurrenceDate: '2026-08-06',
      }),
    );
    expect((await activities.getActivityMeta(overdue.activityId))?.schedule?.date).toBe(
      '2026-08-04',
    );

    const completedAt = '2026-08-06T16:05:00.000Z';
    await activities.patchActivity(
      'usr_alice',
      { ...overdue, status: 'completed', completedAt, updatedAt: completedAt },
      overdue.updatedAt,
      { previous: overdue },
    );
    const stored = await activities.getActivityMeta(overdue.activityId);
    expect(stored).toMatchObject({
      status: 'completed',
      completedAt,
      schedule: { date: '2026-08-04' },
    });
  });
});

/**
 * The native agenda fences an acknowledged write until a response proves the index caught up,
 * and the proof is the index row's `updatedAt` matching META. GSI1 must project that stamp:
 * unit fakes hand back whole index rows, so a projection without it went unnoticed and every
 * native fence stayed up for ever — recurring rows vanished from Today (2026-09-10).
 */
describe('projection versions', () => {
  it('reports the stamp of each index row read back through GSI1', async () => {
    const ownerId = 'usr_carol';
    const dated = subject({
      ownerId,
      title: 'Dentist',
      schedule: { date: '2026-08-06', time: '15:00', timezone: 'America/New_York' },
    });
    const series = subject({
      ownerId,
      title: 'Daily task',
      schedule: { date: '2026-08-01', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
      },
    });
    for (const row of [dated, series]) await activities.createActivity(ownerId, row);
    const assemble = () =>
      agenda.assembleAgenda(
        {
          userId: ownerId,
          from: '2026-08-06',
          to: '2026-08-06',
          timezone: 'America/New_York',
          now: '2026-08-06T12:00:00.000Z',
          includeOverdue: true,
        },
        {
          listBucket: activities.listByBucket,
          listOverdue: activities.listOverdueTaskCandidates,
          batchActivities: activities.batchGetActivityMeta,
          listParticipants: activities.listParticipants,
          batchAgendaRows: occurrences.batchGetAgendaRows,
          batchOccurrences: occurrences.batchGetForPairs,
          listReminders: reminders.listForUser,
          expand: expandRecurrence,
          warn: vi.fn(),
        },
      );

    expect((await assemble()).projectionVersions).toEqual(
      expect.arrayContaining([
        { activityId: dated.activityId, version: dated.updatedAt },
        { activityId: series.activityId, version: series.updatedAt },
      ]),
    );

    const editedAt = '2026-08-06T12:05:00.000Z';
    await activities.patchActivity(
      ownerId,
      { ...dated, title: 'Dentist, rebooked', updatedAt: editedAt },
      dated.updatedAt,
      { previous: dated },
    );
    expect((await assemble()).projectionVersions).toContainEqual({
      activityId: dated.activityId,
      version: editedAt,
    });
  });
});

describe('passed-plan history', () => {
  it('does not carry an unresolved plan from yesterday into today', async () => {
    const unresolved = subject({
      objectKind: 'plan',
      type: 'event',
      title: 'Yesterday dentist appointment',
      details: { kind: 'event' },
      schedule: {
        date: '2026-08-05',
        time: '14:30',
        timezone: 'America/New_York',
      },
    });
    await activities.createActivity('usr_alice', unresolved);

    const result = await agenda.assembleAgenda(
      {
        userId: 'usr_alice',
        from: '2026-08-06',
        to: '2026-08-06',
        timezone: 'America/New_York',
        now: '2026-08-06T16:00:00.000Z',
        includeOverdue: true,
      },
      {
        listBucket: activities.listByBucket,
        listOverdue: activities.listOverdueTaskCandidates,
        batchActivities: activities.batchGetActivityMeta,
        listParticipants: activities.listParticipants,
        batchAgendaRows: occurrences.batchGetAgendaRows,
        batchOccurrences: occurrences.batchGetForPairs,
        listReminders: reminders.listForUser,
        expand: expandRecurrence,
        warn: vi.fn(),
      },
    );

    const today = result.days[0];
    expect(
      today === undefined
        ? []
        : [...today.schedule, ...today.anytime, ...today.earlier].map(
            (row) => row.activity.activityId,
          ),
    ).not.toContain(unresolved.activityId);
    expect((await activities.getActivityMeta(unresolved.activityId))?.status).toBe(
      'scheduled',
    );
  });
});
