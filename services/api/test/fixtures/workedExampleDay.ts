import {
  WORKED_EXAMPLE_ACTIVITY_IDS,
  WORKED_EXAMPLE_USER_ID,
} from '@od/shared/test-fixtures';
import type { Activity } from '@od/shared/types';

type CreateActivity =
  typeof import('../../src/repositories/activityRepository.js').createActivity;

const CREATED_AT = '2026-08-01T10:00:00.000Z';
const COMPLETED_AT = '2026-08-06T12:05:00.000Z';

function activity(overrides: Partial<Activity>): Activity {
  return {
    activityId: WORKED_EXAMPLE_ACTIVITY_IDS.groceries,
    ownerId: WORKED_EXAMPLE_USER_ID,
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
    createdAt: CREATED_AT,
    lastActivityAt: CREATED_AT,
    updatedAt: CREATED_AT,
    schemaVersion: 1,
    ...overrides,
  } as Activity;
}

export interface WorkedExampleDay {
  readonly oats: Activity;
  readonly dentist: Activity;
  readonly groceries: Activity;
  readonly gym: Activity;
  readonly tacos: Activity;
  readonly severance: Activity;
  readonly insurance: Activity;
  readonly apartment: Activity;
  readonly flights: Activity;
  readonly parentPlan: Activity;
}

/** Builds fresh Activity values for the canonical Today §9 scene. */
export function buildWorkedExampleDay(): WorkedExampleDay {
  const parentPlan = activity({
    activityId: WORKED_EXAMPLE_ACTIVITY_IDS.parentPlan,
    objectKind: 'plan',
    type: 'custom',
    status: 'saved',
    title: 'New York Trip',
    details: { kind: 'custom' },
  });

  return {
    oats: activity({
      activityId: WORKED_EXAMPLE_ACTIVITY_IDS.oats,
      objectKind: 'plan',
      type: 'meal',
      status: 'completed',
      title: 'Overnight oats',
      details: { kind: 'meal', mealSlot: 'breakfast' },
      schedule: {
        date: '2026-08-06',
        time: '08:00',
        timezone: 'America/New_York',
      },
      completedAt: COMPLETED_AT,
      outcome: 'had_it',
    }),
    dentist: activity({
      activityId: WORKED_EXAMPLE_ACTIVITY_IDS.dentist,
      objectKind: 'plan',
      type: 'event',
      title: 'Dentist appointment',
      details: { kind: 'event' },
      schedule: {
        date: '2026-08-06',
        time: '14:30',
        timezone: 'America/New_York',
      },
      location: { label: 'Dr Patel' },
    }),
    groceries: activity({
      activityId: WORKED_EXAMPLE_ACTIVITY_IDS.groceries,
      title: 'Pick up groceries',
      schedule: {
        date: '2026-08-06',
        time: '17:30',
        timezone: 'America/New_York',
      },
    }),
    gym: activity({
      activityId: WORKED_EXAMPLE_ACTIVITY_IDS.gym,
      title: 'Gym',
      schedule: {
        date: '2026-01-05',
        time: '18:00',
        timezone: 'America/New_York',
      },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'weekdays', effectiveFrom: '2026-01-05', time: '18:00' }],
      },
    }),
    tacos: activity({
      activityId: WORKED_EXAMPLE_ACTIVITY_IDS.tacos,
      objectKind: 'plan',
      type: 'meal',
      title: 'Chicken tacos',
      details: { kind: 'meal', mealSlot: 'dinner' },
      schedule: {
        date: '2026-08-06',
        time: '19:30',
        timezone: 'America/New_York',
      },
    }),
    severance: activity({
      activityId: WORKED_EXAMPLE_ACTIVITY_IDS.severance,
      objectKind: 'plan',
      type: 'watch',
      title: 'Severance',
      details: {
        kind: 'watch',
        mediaTitle: 'Severance',
        mediaKind: 'show',
        season: 2,
        episode: 4,
        service: 'Apple TV+',
      },
      schedule: {
        date: '2026-08-06',
        time: '20:00',
        timezone: 'America/New_York',
      },
    }),
    insurance: activity({
      activityId: WORKED_EXAMPLE_ACTIVITY_IDS.insurance,
      title: 'Submit insurance form',
      schedule: { date: '2026-08-06', timezone: 'America/New_York' },
    }),
    apartment: activity({
      activityId: WORKED_EXAMPLE_ACTIVITY_IDS.apartment,
      title: 'Call apartment office',
      schedule: { date: '2026-08-04', timezone: 'America/New_York' },
    }),
    flights: activity({
      activityId: WORKED_EXAMPLE_ACTIVITY_IDS.flights,
      status: 'saved',
      title: 'Book flights for New York',
      parentActivityId: parentPlan.activityId,
    }),
    parentPlan,
  };
}

/** Seeds only through the production repository write path. */
export async function seedWorkedExampleDay(
  createActivity: CreateActivity,
): Promise<WorkedExampleDay> {
  const fixture = buildWorkedExampleDay();

  await createActivity(WORKED_EXAMPLE_USER_ID, fixture.parentPlan);
  await createActivity(WORKED_EXAMPLE_USER_ID, fixture.oats);
  await createActivity(WORKED_EXAMPLE_USER_ID, fixture.dentist);
  await createActivity(WORKED_EXAMPLE_USER_ID, fixture.groceries, {
    reminders: [
      {
        reminderId: 'rem_01J8XKQ2M4N5P6R7S8T9V0W1R1',
        offsetMinutes: -15,
      },
    ],
  });
  await createActivity(WORKED_EXAMPLE_USER_ID, fixture.gym);
  await createActivity(WORKED_EXAMPLE_USER_ID, fixture.tacos);
  await createActivity(WORKED_EXAMPLE_USER_ID, fixture.severance);
  await createActivity(WORKED_EXAMPLE_USER_ID, fixture.insurance);
  await createActivity(WORKED_EXAMPLE_USER_ID, fixture.apartment);
  await createActivity(WORKED_EXAMPLE_USER_ID, fixture.flights, {
    taskSubtitle: fixture.parentPlan.title,
    childPointerRank: fixture.flights.createdAt,
  });

  return fixture;
}
