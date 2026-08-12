import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ActivityType, AgendaItem } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  agendaAccessibilityActions,
  agendaSwipeActions,
  allAgendaSwipeActions,
} from './swipeActions';

const item = (patch: Partial<AgendaItem> = {}): AgendaItem => ({
  activityId: 'act_01J8SEED000000000000000000',
  type: 'task',
  title: 'Evening plan',
  status: 'scheduled',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: true, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
  ...patch,
});

const labels = (patch: Partial<AgendaItem>) => {
  const actions = agendaSwipeActions(item(patch));
  return {
    positive: actions.positive.map(({ label }) => label),
    secondary: actions.secondary.map(({ label }) => label),
  };
};

describe('agenda gesture table', () => {
  it.each<{
    row: string;
    patch: Partial<AgendaItem>;
    positive: string[];
    secondary: string[];
  }>([
    {
      row: 'timed task',
      patch: { time: '18:00' },
      positive: ['Complete'],
      secondary: ['Snooze', 'Reschedule', 'Delete'],
    },
    {
      row: 'untimed task',
      patch: {},
      positive: ['Complete'],
      secondary: ['Schedule', 'Delete'],
    },
    {
      row: 'overdue task',
      patch: { overdueFromDate: '2026-08-10' },
      positive: ['Complete'],
      secondary: ['Do today', 'Reschedule', 'Delete'],
    },
    {
      row: 'recurring occurrence',
      patch: { isRecurring: true, occurrenceDate: '2026-08-11', time: '18:00' },
      positive: ['Complete'],
      secondary: ['Snooze', 'Skip', 'Edit series'],
    },
    {
      row: 'prep task',
      patch: { parentActivityId: 'act_01J8PARENT0000000000000000', isRecurring: true },
      positive: ['Complete'],
      secondary: ['Open plan', 'Reschedule', 'Delete'],
    },
    {
      row: 'completed row',
      patch: { status: 'completed' },
      positive: ['Undo'],
      secondary: ['Delete'],
    },
    {
      row: 'skipped occurrence',
      patch: { status: 'skipped_occurrence', isRecurring: true },
      positive: ['Undo skip'],
      secondary: ['Delete'],
    },
  ])('returns the exact $row action set', ({ patch, positive, secondary }) => {
    expect(labels(patch)).toEqual({ positive, secondary });
  });

  it.each<[ActivityType, string]>([
    ['meal', 'Had it'],
    ['watch', 'Watched'],
    ['event', 'Attended'],
    ['custom', 'Done'],
  ])('uses the %s completion verb and Plan actions', (type, verb) => {
    expect(labels({ type, hasCheckbox: false })).toEqual({
      positive: [verb],
      secondary: ['Reschedule', 'Delete'],
    });
  });

  it('intersects complete, snooze and skip with server capabilities', () => {
    expect(
      labels({
        isRecurring: true,
        capabilities: { complete: false, snooze: false, skip: false },
      }),
    ).toEqual({ positive: [], secondary: ['Edit series'] });
  });

  it('mirrors every rendered action into an accessibility action with the same label', () => {
    const actions = agendaSwipeActions(item({ isRecurring: true, time: '18:00' }));

    expect(agendaAccessibilityActions(actions)).toEqual(
      allAgendaSwipeActions(actions).map(({ name, label }) => ({ name, label })),
    );
  });

  it('uses the prep parent only as the gesture discriminator and Open plan target', () => {
    const parentActivityId = 'act_01J8PARENT0000000000000000';
    const actions = agendaSwipeActions(
      item({
        parentActivityId,
        participantCount: 99,
        capabilities: { complete: false, snooze: false, skip: false },
      }),
    );

    expect(actions.positive).toEqual([]);
    expect(actions.secondary[0]).toMatchObject({
      name: 'openPlan',
      targetActivityId: parentActivityId,
    });

    const source = readFileSync(resolve(__dirname, 'swipeActions.ts'), 'utf8');
    expect(source).not.toMatch(/ownerId|participantCount/);
  });
});
