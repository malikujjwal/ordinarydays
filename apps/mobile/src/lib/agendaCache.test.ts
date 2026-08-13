import type { AgendaData, AgendaItem } from '@od/shared/types';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { projectActivityWrite } from '@/lib/agendaCache';

/**
 * The regression this file exists for.
 *
 * P2-46 stopped the agenda refetching on invalidation, because a refetch fired immediately
 * after a write races an eventually-consistent index and usually loses. That is only safe if
 * **every** write projects into the cache. Completion from the agenda screen always did;
 * completion from the detail screen did not, so a task completed from its own detail screen
 * reached the server and never reached Today — a mounted tab has nothing to trigger a refetch,
 * and Plans looked correct only because navigating to it remounts.
 *
 * Projecting centrally is what makes the row checkbox, the swipe action, the passed-plan sheet,
 * the detail button and an offline replay behave identically. These cases are the proof.
 */

const TODAY = '2026-08-13';
const KEY = ['agenda', TODAY, TODAY, 'America/New_York', 'anytime_unscheduled,overdue'];

const row = (patch: Partial<AgendaItem> = {}): AgendaItem => ({
  activityId: 'act_STANDUP',
  type: 'task',
  title: 'Stand-up',
  status: 'scheduled',
  time: '09:30',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: false, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
  ...patch,
});

function seeded(item = row()): QueryClient {
  const client = new QueryClient();
  const agenda: AgendaData = {
    days: [{ date: TODAY, schedule: [item], anytime: [], earlier: [] }],
    warnings: [],
  };
  client.setQueryData(KEY, agenda);
  return client;
}

const statusOf = (client: QueryClient, activityId: string): string | undefined => {
  const agenda = client.getQueryData<AgendaData>(KEY);
  for (const day of agenda?.days ?? []) {
    for (const item of [...day.schedule, ...day.anytime, ...day.earlier]) {
      if (item.activityId === activityId) return item.status;
    }
  }
  return undefined;
};

const completion = (activityId: string, status: string) => ({
  activity: { activityId, status, schedule: { date: TODAY, time: '09:30' } },
});

describe('a completion recorded anywhere reaches the agenda cache', () => {
  it('marks the row completed, so Today crosses it off without a refetch', () => {
    const client = seeded();

    const projected = projectActivityWrite(
      client,
      ['activity', 'complete'],
      completion('act_STANDUP', 'completed'),
      { activityId: 'act_STANDUP', input: { outcome: 'done' } },
    );

    expect(projected).toBe(true);
    expect(statusOf(client, 'act_STANDUP')).toBe('completed');
  });

  it('restores the row on the compensating uncomplete, so Undo is real', () => {
    const client = seeded(row({ status: 'completed' }));

    projectActivityWrite(
      client,
      ['activity', 'uncomplete'],
      completion('act_STANDUP', 'scheduled'),
      { activityId: 'act_STANDUP', input: {} },
    );

    expect(statusOf(client, 'act_STANDUP')).toBe('scheduled');
  });

  /** Occurrence scope travels in the request, never in the response. */
  it('scopes a recurring completion to its occurrence', () => {
    const client = seeded(row({ isRecurring: true, occurrenceDate: TODAY }));

    projectActivityWrite(
      client,
      ['activity', 'complete'],
      completion('act_STANDUP', 'scheduled'),
      { activityId: 'act_STANDUP', input: { outcome: 'done', occurrenceDate: TODAY } },
    );

    expect(statusOf(client, 'act_STANDUP')).toBe('completed_occurrence');
  });

  it('projects a skip too', () => {
    const client = seeded();

    projectActivityWrite(
      client,
      ['activity', 'skip'],
      completion('act_STANDUP', 'skipped'),
      { activityId: 'act_STANDUP', input: {} },
    );

    expect(statusOf(client, 'act_STANDUP')).toBe('skipped');
  });

  /**
   * The detail cache as well as the agenda. Completing or undoing from a Today row never
   * touched `['activity', id]`, and that query has a 60-second stale time — so the detail
   * screen kept claiming an activity was completed long after the row had gone back to normal.
   */
  it('updates the detail cache too, so the two screens cannot disagree', () => {
    const client = seeded(row({ status: 'completed' }));
    client.setQueryData(['activity', 'act_STANDUP'], {
      activity: { activityId: 'act_STANDUP', status: 'completed' },
      reminders: [],
    });

    projectActivityWrite(
      client,
      ['activity', 'uncomplete'],
      completion('act_STANDUP', 'scheduled'),
      { activityId: 'act_STANDUP', input: {} },
    );

    const detail = client.getQueryData<{ activity: { status: string } }>([
      'activity',
      'act_STANDUP',
    ]);
    expect(detail?.activity.status).toBe('scheduled');
  });

  it('ignores a mutation that carries no activity', () => {
    const client = seeded();

    expect(projectActivityWrite(client, ['activity', 'complete'], null, {})).toBe(false);
    expect(statusOf(client, 'act_STANDUP')).toBe('scheduled');
  });
});
