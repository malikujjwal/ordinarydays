import type { AgendaData, AgendaItem } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { buildUpcomingSections } from './plansWindow';

const row = (id: string, occurrenceDate?: string): AgendaItem => ({
  activityId: id,
  ...(occurrenceDate === undefined ? {} : { occurrenceDate }),
  type: 'event',
  title: id,
  status: 'scheduled',
  isRecurring: occurrenceDate !== undefined,
  isSnoozed: false,
  hasCheckbox: false,
  capabilities: { complete: true, skip: false, snooze: false },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
});

const window = (dates: Array<[string, AgendaItem[]]>): AgendaData => ({
  days: dates.map(([date, items]) => ({
    date,
    schedule: items,
    anytime: [],
    earlier: [],
  })),
  warnings: [],
});

describe('buildUpcomingSections', () => {
  it('keeps one occurrence of a recurring series on every populated date', () => {
    const result = buildUpcomingSections(
      window([
        ['2026-08-17', [row('act_01J0000000000000000000000A', '2026-08-17')]],
        ['2026-08-18', [row('act_01J0000000000000000000000A', '2026-08-18')]],
        ['2026-08-19', [row('act_01J0000000000000000000000A', '2026-08-19')]],
        ['2026-08-20', [row('act_01J0000000000000000000000A', '2026-08-20')]],
        ['2026-08-21', [row('act_01J0000000000000000000000A', '2026-08-21')]],
        ['2026-08-22', [row('act_01J0000000000000000000000A', '2026-08-22')]],
        ['2026-08-23', [row('act_01J0000000000000000000000A', '2026-08-23')]],
      ]),
    );

    expect(
      result.flatMap((section) => section.data).filter((item) => item.kind === 'date'),
    ).toHaveLength(7);
  });

  it('renders the exact single-day gap copy', () => {
    const result = buildUpcomingSections(
      window([
        ['2026-08-19', [row('act_01J0000000000000000000000A')]],
        ['2026-08-20', []],
        ['2026-08-21', [row('act_01J0000000000000000000000B')]],
      ]),
    );

    expect(result[0]?.data[1]).toEqual({
      kind: 'gap',
      from: '2026-08-20',
      to: '2026-08-20',
      label: 'Aug 20 · nothing planned',
    });
  });

  it('collapses several consecutive empty dates into one quiet line', () => {
    const result = buildUpcomingSections(
      window([
        ['2026-08-19', [row('act_01J0000000000000000000000A')]],
        ['2026-08-20', []],
        ['2026-08-21', []],
        ['2026-08-22', []],
        ['2026-08-23', []],
        ['2026-08-24', []],
        ['2026-08-25', [row('act_01J0000000000000000000000B')]],
      ]),
    );

    expect(result[0]?.data[1]).toEqual({
      kind: 'gap',
      from: '2026-08-20',
      to: '2026-08-24',
      label: 'Aug 20 – 24 · nothing planned',
    });
  });

  it('renders no empty dates before the first entry or after the last', () => {
    const result = buildUpcomingSections(
      window([
        ['2026-08-17', []],
        ['2026-08-18', []],
        ['2026-08-19', [row('act_01J0000000000000000000000A')]],
        ['2026-08-20', []],
        ['2026-08-21', []],
      ]),
    );

    expect(result.flatMap((section) => section.data)).toEqual([
      expect.objectContaining({ kind: 'date', date: '2026-08-19' }),
    ]);
  });

  it('keeps month context and names both months when one gap crosses a boundary', () => {
    const result = buildUpcomingSections(
      window([
        ['2026-08-29', [row('act_01J0000000000000000000000A')]],
        ['2026-09-03', [row('act_01J0000000000000000000000B')]],
      ]),
    );

    expect(result.map(({ title }) => title)).toEqual(['August 2026', 'September 2026']);
    expect(result[0]?.data[1]).toMatchObject({
      kind: 'gap',
      label: 'Aug 30 – Sep 2 · nothing planned',
    });
  });
});
