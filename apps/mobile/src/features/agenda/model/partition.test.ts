import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workedExampleDayResponse } from '@od/shared/test-fixtures';
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

const titles = (items: readonly AgendaItem[]) => items.map((entry) => entry.title);

/**
 * **EARLIER TODAY ascends** — founder decision, 2026-08-17, with the section moved above
 * SCHEDULE. Reading down the screen now runs oldest → NOW → soonest, so the past climbs into the
 * present instead of retreating from it; `today-and-tasks.md` §2.4 is amended to match in the
 * same pull request. Every expectation below is the previous one reversed, and nothing else about
 * the partition changed.
 */
describe('partitionAgenda', () => {
  it.each([
    [
      '15:10',
      ['Pick up groceries'],
      ['Pick up groceries', 'Gym', 'Chicken tacos', 'Severance'],
      ['Call apartment office', 'Submit insurance form', 'Book flights for New York'],
      ['Overnight oats', 'Dentist appointment'],
    ],
    [
      '17:31',
      ['Gym'],
      ['Gym', 'Chicken tacos', 'Severance'],
      ['Call apartment office', 'Submit insurance form', 'Book flights for New York'],
      ['Overnight oats', 'Dentist appointment', 'Pick up groceries'],
    ],
    [
      '23:59',
      [],
      [],
      ['Call apartment office', 'Submit insurance form', 'Book flights for New York'],
      [
        'Overnight oats',
        'Dentist appointment',
        'Pick up groceries',
        'Gym',
        'Chicken tacos',
        'Severance',
      ],
    ],
  ])('matches the worked example at %s', (minute, upNext, schedule, anytime, earlier) => {
    const day = workedExampleDayResponse().days[0];
    if (day === undefined) throw new Error('The worked example fixture is incomplete.');
    const result = partitionAgenda(agendaItemsForDay(day), minute);
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
    expect(titles(result.earlier)).toEqual(['Untimed skip', 'Future skip']);
  });

  it('flattens the server arrays without duplicating up next', () => {
    const day = workedExampleDayResponse().days[0];
    if (day === undefined) throw new Error('The worked example fixture is incomplete.');
    const items = agendaItemsForDay(day);

    expect(items).toEqual([...day.schedule, ...day.anytime, ...day.earlier]);
    expect(
      items.filter(({ activityId }) => activityId === day.upNext?.activityId),
    ).toHaveLength(1);
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
