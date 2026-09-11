import { agendaData } from '@od/shared/schemas';
import {
  WORKED_EXAMPLE_ACTIVITY_IDS,
  WORKED_EXAMPLE_DATE,
  WORKED_EXAMPLE_NOW,
  WORKED_EXAMPLE_TIMEZONE,
  WORKED_EXAMPLE_USER_ID,
  workedExampleDayResponse,
} from '@od/shared/test-fixtures';
import type { AgendaData, AgendaItem } from '@od/shared/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  seedWorkedExampleDay,
  type WorkedExampleDay,
} from '../fixtures/workedExampleDay.js';
import { authedHeaders, withUser } from '../helpers/auth.js';
import { useTestTable } from './harness.js';

useTestTable({ truncateBetweenTests: false });

type ActivityRepository = typeof import('../../src/repositories/activityRepository.js');
type OccurrenceRepository =
  typeof import('../../src/repositories/occurrenceRepository.js');

let activities: ActivityRepository;
let occurrences: OccurrenceRepository;
let fixture: WorkedExampleDay;

beforeAll(async () => {
  activities = await import('../../src/repositories/activityRepository.js');
  occurrences = await import('../../src/repositories/occurrenceRepository.js');
  fixture = await seedWorkedExampleDay(activities.createActivity);
  vi.useFakeTimers({ now: new Date(WORKED_EXAMPLE_NOW), toFake: ['Date'] });
});

afterAll(() => {
  vi.useRealTimers();
});

const agendaUrl = (from: string, to = from) =>
  `http://localhost/v1/agenda?from=${from}&to=${to}&tz=${encodeURIComponent(
    WORKED_EXAMPLE_TIMEZONE,
  )}&include=anytime_unscheduled,overdue`;

async function requestAgenda(from: string, to = from, etag?: string): Promise<Response> {
  return withUser(WORKED_EXAMPLE_USER_ID).fetch(
    new Request(agendaUrl(from, to), {
      headers: {
        ...authedHeaders(),
        ...(etag === undefined ? {} : { 'If-None-Match': etag }),
      },
    }),
  );
}

async function agendaResponse(from: string, to = from): Promise<AgendaData> {
  const response = await requestAgenda(from, to);
  expect(response.status).toBe(200);
  return agendaData.parse((await response.json()).data) as AgendaData;
}

async function postAction(
  activityId: string,
  action: 'complete',
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<Response> {
  return withUser(WORKED_EXAMPLE_USER_ID).fetch(
    new Request(`http://localhost/v1/activities/${activityId}/${action}`, {
      method: 'POST',
      headers: authedHeaders({ idempotencyKey }),
      body: JSON.stringify(body),
    }),
  );
}

const titles = (rows: readonly AgendaItem[]) => rows.map((row) => row.title);

describe('the canonical worked-example day', () => {
  it('pins the full agenda pipeline, mutations, and segmented recurrence history', async () => {
    const firstResponse = await requestAgenda(WORKED_EXAMPLE_DATE);
    const initial = agendaData.parse((await firstResponse.json()).data) as AgendaData;
    const captured = workedExampleDayResponse();

    expect(firstResponse.status).toBe(200);
    expect(initial).toEqual(captured);

    const day = initial.days[0];
    expect(day).toBeDefined();
    if (day === undefined) throw new Error('The worked example response has no day.');
    expect(day.upNext?.title).toBe('Pick up groceries');
    expect(titles(day.schedule)).toEqual([
      'Pick up groceries',
      'Gym',
      'Chicken tacos',
      'Severance',
    ]);
    expect(titles(day.anytime)).toEqual([
      'Call apartment office',
      'Submit insurance form',
      'Book flights for New York',
    ]);
    expect(titles(day.earlier)).toEqual(['Dentist appointment', 'Overnight oats']);

    const rows = [...day.schedule, ...day.anytime, ...day.earlier];
    expect(rows).toHaveLength(9);
    expect(rows.filter((row) => row.hasCheckbox).map((row) => row.title)).toEqual([
      'Pick up groceries',
      'Gym',
      'Call apartment office',
      'Submit insurance form',
      'Book flights for New York',
    ]);
    expect(
      Object.fromEntries(rows.map((row) => [row.title, row.subtitle ?? null])),
    ).toMatchObject({
      'Overnight oats': 'Meal · Breakfast',
      'Dentist appointment': 'Dr Patel',
      'Chicken tacos': 'Meal · Dinner',
      Severance: 'Watch · S2 E4',
      'Book flights for New York': 'New York Trip',
    });
    expect(rows.find((row) => row.title === 'Gym')).toMatchObject({
      occurrenceDate: WORKED_EXAMPLE_DATE,
      isRecurring: true,
      recurrenceDescription: 'Every weekday',
    });
    expect(rows.find((row) => row.title === 'Call apartment office')).toMatchObject({
      overdueFromDate: '2026-08-04',
    });
    expect(
      (await activities.getActivityMeta(fixture.apartment.activityId))?.schedule,
    ).toMatchObject({ date: '2026-08-04' });

    const etag = firstResponse.headers.get('etag');
    expect(etag).toBeTruthy();
    const notModified = await requestAgenda(
      WORKED_EXAMPLE_DATE,
      WORKED_EXAMPLE_DATE,
      etag ?? undefined,
    );
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe('');

    const gymMetaBefore = await activities.getActivityMeta(fixture.gym.activityId);
    const gymPartitionBefore = await activities.getActivityPartition(
      fixture.gym.activityId,
    );
    const completedGym = await postAction(
      fixture.gym.activityId,
      'complete',
      { occurrenceDate: WORKED_EXAMPLE_DATE },
      '00000000-0000-4000-8000-000000000036',
    );
    expect(completedGym.status).toBe(200);

    const gymMetaAfter = await activities.getActivityMeta(fixture.gym.activityId);
    const gymPartitionAfter = await activities.getActivityPartition(
      fixture.gym.activityId,
    );
    expect(gymMetaAfter).toEqual(gymMetaBefore);
    expect(gymPartitionAfter).toHaveLength(gymPartitionBefore.length + 1);
    expect(
      await occurrences.get(fixture.gym.activityId, WORKED_EXAMPLE_DATE),
    ).toMatchObject({
      activityId: fixture.gym.activityId,
      date: WORKED_EXAMPLE_DATE,
      status: 'completed',
    });

    const friday = await agendaResponse('2026-08-07');
    expect(friday.days[0]?.schedule).toContainEqual(
      expect.objectContaining({
        activityId: fixture.gym.activityId,
        occurrenceDate: '2026-08-07',
        time: '18:00',
        status: 'scheduled',
      }),
    );

    const attendedDentist = await postAction(
      fixture.dentist.activityId,
      'complete',
      { outcome: 'attended' },
      '00000000-0000-4000-8000-000000000037',
    );
    expect(attendedDentist.status).toBe(200);
    expect(await activities.getActivityMeta(fixture.dentist.activityId)).toMatchObject({
      status: 'completed',
      outcome: 'attended',
    });
    // `projectionVersions` may still name the dentist: its index row was read, not emitted.
    expect(JSON.stringify((await agendaResponse('2026-08-07')).days)).not.toContain(
      fixture.dentist.activityId,
    );

    const patchResponse = await withUser(WORKED_EXAMPLE_USER_ID).fetch(
      new Request(`http://localhost/v1/activities/${fixture.gym.activityId}`, {
        method: 'PATCH',
        headers: {
          ...authedHeaders(),
          'If-Match': gymMetaAfter?.updatedAt ?? '',
        },
        body: JSON.stringify({
          recurrence: {
            mode: 'fixed',
            segments: [
              {
                freq: 'weekdays',
                effectiveFrom: '2026-01-05',
                time: '18:00',
              },
              {
                freq: 'weekly',
                byWeekday: [2, 4],
                effectiveFrom: '2026-08-10',
                time: '07:00',
              },
            ],
          },
          editedFromDate: '2026-08-10',
        }),
      }),
    );
    expect(patchResponse.status).toBe(200);

    const history = await agendaResponse('2026-08-03', '2026-08-14');
    const gymRows = history.days.flatMap((historyDay) =>
      [...historyDay.schedule, ...historyDay.anytime, ...historyDay.earlier]
        .filter((row) => row.activityId === WORKED_EXAMPLE_ACTIVITY_IDS.gym)
        .map((row) => ({
          date: historyDay.date,
          time: row.time,
          status: row.status,
        })),
    );
    expect(gymRows).toEqual([
      { date: '2026-08-03', time: '18:00', status: 'scheduled' },
      { date: '2026-08-04', time: '18:00', status: 'scheduled' },
      { date: '2026-08-05', time: '18:00', status: 'scheduled' },
      { date: '2026-08-06', time: '18:00', status: 'completed_occurrence' },
      { date: '2026-08-07', time: '18:00', status: 'scheduled' },
      { date: '2026-08-11', time: '07:00', status: 'scheduled' },
      { date: '2026-08-13', time: '07:00', status: 'scheduled' },
    ]);
  });
});
