import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgendaItem } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { agendaItemsForDay, partitionAgenda } from './partition';

const item = (
  activityId: string,
  title: string,
  patch: Partial<AgendaItem> = {},
): AgendaItem => ({
  activityId,
  type: 'task',
  title,
  status: 'scheduled',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: false, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
  ...patch,
});

// today-and-tasks.md §9, self-seeded here so this pure projection owns its own fixture.
const workedExample = [
  item('act_A', 'Overnight oats', {
    type: 'meal',
    status: 'completed',
    time: '08:00',
    hasCheckbox: false,
    isPast: true,
  }),
  item('act_B', 'Dentist appointment', {
    type: 'event',
    time: '14:30',
    hasCheckbox: false,
    isPast: true,
  }),
  item('act_C', 'Pick up groceries', { time: '17:30' }),
  item('act_D', 'Gym', {
    time: '18:00',
    occurrenceDate: '2026-08-06',
    isRecurring: true,
  }),
  item('act_E', 'Chicken tacos', {
    type: 'meal',
    time: '19:30',
    hasCheckbox: false,
  }),
  item('act_F', 'Severance', {
    type: 'watch',
    time: '20:00',
    hasCheckbox: false,
  }),
  item('act_G', 'Submit insurance form'),
  item('act_H', 'Call apartment office', { overdueFromDate: '2026-08-04' }),
  item('act_I', 'Book flights for New York', {
    status: 'saved',
    subtitle: 'New York Trip',
  }),
];

const titles = (items: readonly AgendaItem[]) => items.map((entry) => entry.title);

describe('partitionAgenda', () => {
  it.each([
    [
      '15:10',
      ['Pick up groceries'],
      ['Pick up groceries', 'Gym', 'Chicken tacos', 'Severance'],
      ['Call apartment office', 'Submit insurance form', 'Book flights for New York'],
      ['Dentist appointment', 'Overnight oats'],
    ],
    [
      '17:31',
      ['Gym'],
      ['Gym', 'Chicken tacos', 'Severance'],
      ['Call apartment office', 'Submit insurance form', 'Book flights for New York'],
      ['Pick up groceries', 'Dentist appointment', 'Overnight oats'],
    ],
    [
      '23:59',
      [],
      [],
      ['Call apartment office', 'Submit insurance form', 'Book flights for New York'],
      [
        'Severance',
        'Chicken tacos',
        'Gym',
        'Pick up groceries',
        'Dentist appointment',
        'Overnight oats',
      ],
    ],
  ])('matches the worked example at %s', (minute, upNext, schedule, anytime, earlier) => {
    const result = partitionAgenda(workedExample, minute);
    expect(titles(result.upNext)).toEqual(upNext);
    expect(titles(result.schedule)).toEqual(schedule);
    expect(titles(result.anytime)).toEqual(anytime);
    expect(titles(result.earlier)).toEqual(earlier);
  });

  it('uses an end time as the pass boundary and hides skipped and cancelled rows', () => {
    const items = [
      item('act_range', 'Workshop', { time: '14:00', endTime: '16:00' }),
      item('act_skip', 'Skipped', { status: 'skipped' }),
      item('act_cancel', 'Cancelled', { status: 'cancelled', time: '18:00' }),
    ];
    const result = partitionAgenda(items, '15:10');

    expect(titles(result.schedule)).toEqual(['Workshop']);
    expect(titles(result.upNext)).toEqual([]);
    expect(titles(result.anytime)).toEqual([]);
    expect(titles(result.earlier)).toEqual([]);

    const revealed = partitionAgenda(items, '15:10', true);
    expect(titles(revealed.schedule)).toEqual(['Workshop']);
    expect(titles(revealed.anytime)).toEqual([]);
    expect(titles(revealed.earlier)).toEqual(['Skipped']);
  });

  it('always places revealed skipped occurrences in Earlier today', () => {
    const result = partitionAgenda(
      [
        item('act_future', 'Future skip', {
          status: 'skipped_occurrence',
          occurrenceDate: '2026-08-06',
          time: '20:00',
        }),
        item('act_untimed', 'Untimed skip', { status: 'skipped_occurrence' }),
      ],
      '15:10',
      true,
    );

    expect(titles(result.upNext)).toEqual([]);
    expect(titles(result.schedule)).toEqual([]);
    expect(titles(result.anytime)).toEqual([]);
    expect(titles(result.earlier)).toEqual(['Future skip', 'Untimed skip']);
  });

  it('flattens the server arrays without duplicating up next', () => {
    const schedule = workedExample[2];
    const anytime = workedExample[6];
    const earlier = workedExample[1];
    if (schedule === undefined || anytime === undefined || earlier === undefined) {
      throw new Error('The worked example fixture is incomplete.');
    }
    expect(
      agendaItemsForDay({
        schedule: [schedule],
        anytime: [anytime],
        earlier: [earlier],
      }),
    ).toEqual([schedule, anytime, earlier]);
  });

  it('contains no client copy of the server bucket rule', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'features', 'agenda', 'model', 'partition.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/\.type\b|\['type'\]/);
    expect(source).not.toContain('participantCount');
  });
});
