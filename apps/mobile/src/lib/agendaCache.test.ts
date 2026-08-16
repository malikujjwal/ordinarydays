import type { AgendaData, AgendaItem } from '@od/shared/types';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  guardAgendaResponse,
  projectActivityWrite,
  projectOptimisticCompletion,
  projectOptimisticSnooze,
  reconcileAgendaProjection,
} from '@/lib/agendaCache';

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
  it('crosses the Today row off before the detail request settles and can roll back', () => {
    const client = seeded();

    const rollback = projectOptimisticCompletion(client, {
      activityId: 'act_STANDUP',
      completed: true,
    });

    expect(statusOf(client, 'act_STANDUP')).toBe('completed');
    rollback();
    expect(statusOf(client, 'act_STANDUP')).toBe('scheduled');
  });

  it('restores an overdue row removed by an optimistic completion', () => {
    const client = seeded(row({ overdueFromDate: '2026-08-11' }));

    const rollback = projectOptimisticCompletion(client, {
      activityId: 'act_STANDUP',
      completed: true,
    });

    expect(statusOf(client, 'act_STANDUP')).toBeUndefined();
    rollback();
    expect(statusOf(client, 'act_STANDUP')).toBe('scheduled');
  });

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

/**
 * Reported 2026-08-13: "if you change the plan on a later date to today, it takes some time for
 * it to show up on the Today page."
 *
 * `applyReschedule` moves a row the cached window already holds, and correctly does nothing for
 * one it has never seen — which is precisely a plan arriving from next Friday. The projection
 * was therefore a no-op and Today only gained the row when something else happened to refetch.
 */
describe('a plan rescheduled into today', () => {
  /**
   * `['activity', …]`, singular — the real key from `activityMutationKeys`. This fixture said
   * `activities` and still passed, because the projector only ever read element 1 and never
   * checked the scope; `changesActivityLists` does check it, so the key under test could not
   * have reached the projector in production at all.
   */
  const scheduleKey = ['activity', 'schedule'];
  const arriving = {
    activityId: 'act_DINNER',
    ownerId: 'usr_1',
    objectKind: 'plan',
    type: 'event',
    status: 'scheduled',
    title: 'Dinner at Zahav',
    schedule: { date: TODAY, time: '19:00', timezone: 'America/New_York' },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    details: { kind: 'event' },
  };

  it('appears immediately rather than waiting for a refetch', () => {
    const client = seeded();
    expect(statusOf(client, 'act_DINNER')).toBeUndefined();

    projectActivityWrite(client, scheduleKey, arriving);

    expect(statusOf(client, 'act_DINNER')).toBe('scheduled');
  });

  it('does not double the row when a refetch already won the race', () => {
    const client = seeded();
    projectActivityWrite(client, scheduleKey, arriving);
    projectActivityWrite(client, scheduleKey, arriving);

    const agenda = client.getQueryData<AgendaData>(KEY);
    const matches = (agenda?.days ?? []).flatMap((day) =>
      [...day.schedule, ...day.anytime, ...day.earlier].filter(
        (item) => item.activityId === 'act_DINNER',
      ),
    );
    expect(matches).toHaveLength(1);
  });

  /** A date outside every cached window is still not this projection's to place. */
  it('leaves a window that does not contain the destination alone', () => {
    const client = seeded();

    projectActivityWrite(client, scheduleKey, {
      ...arriving,
      schedule: { ...arriving.schedule, date: '2026-09-01' },
    });

    expect(statusOf(client, 'act_DINNER')).toBeUndefined();
  });
});

/**
 * The same invariant, for the write that did not have it.
 *
 * `changesActivityLists` returns true for every `['activity', *]` key, so a patch always
 * reached `refreshActivityLists` — which marks the agenda stale with `refetchType: 'none'`.
 * `projectActivityWrite` had no `patch` branch, so it returned false and wrote nothing. Net:
 * no projection *and* no refetch, and Today kept the pre-patch row until a remount, a
 * foreground, or the 60-second `staleTime` expired. Switching an activity from repeating to
 * one-off left Today insisting it still repeated.
 */
describe('a patch reaches the agenda cache', () => {
  const patchKey = ['activity', 'patch'];

  const daily = {
    mode: 'fixed',
    segments: [{ freq: 'daily', effectiveFrom: TODAY, time: '09:30' }],
  };

  const patched = (patch: Record<string, unknown>) => ({
    activityId: 'act_STANDUP',
    type: 'task',
    title: 'Stand-up',
    status: 'scheduled',
    schedule: { date: TODAY, time: '09:30' },
    ...patch,
  });

  const rowOf = (client: QueryClient): AgendaItem | undefined => {
    const agenda = client.getQueryData<AgendaData>(KEY);
    for (const day of agenda?.days ?? []) {
      for (const item of [...day.schedule, ...day.anytime, ...day.earlier]) {
        if (item.activityId === 'act_STANDUP') return item;
      }
    }
    return undefined;
  };

  it('does not guess the row shape when a series becomes a one-off', () => {
    const client = seeded(
      row({
        isRecurring: true,
        capabilities: { complete: true, skip: true, snooze: true },
      }),
    );

    expect(projectActivityWrite(client, patchKey, patched({}))).toBe(true);

    expect(rowOf(client)?.isRecurring).toBe(true);
    expect(rowOf(client)?.capabilities.skip).toBe(true);
  });

  it('does not invent an occurrence when a one-off becomes a series', () => {
    const client = seeded();

    projectActivityWrite(
      client,
      patchKey,
      patched({
        recurrence: {
          mode: 'fixed',
          segments: [{ freq: 'daily', effectiveFrom: TODAY }],
        },
      }),
    );

    expect(rowOf(client)?.isRecurring).toBe(false);
    expect(rowOf(client)?.capabilities.skip).toBe(false);
  });

  it('renames the row without touching the occurrence status it carries', () => {
    const client = seeded(
      row({ isRecurring: true, occurrenceDate: TODAY, status: 'completed_occurrence' }),
    );

    projectActivityWrite(
      client,
      patchKey,
      patched({ title: 'Morning stand-up', recurrence: daily }),
    );

    expect(rowOf(client)?.title).toBe('Morning stand-up');
    // An `Occurrence` override never moves `ACT#/META`, so a patch may not move it either.
    expect(rowOf(client)?.status).toBe('completed_occurrence');
  });

  /**
   * The founder's flow, steps 2–4: make a plan daily, then try to complete today from detail.
   *
   * An expanded occurrence is identified by the day it falls on, and the detail screen offers
   * no completion control without one. Marking the row recurring while leaving it without an
   * occurrence date hid the button until a real refetch arrived.
   */
  it('does not invent an occurrence date before authoritative expansion arrives', () => {
    const client = seeded();

    projectActivityWrite(client, patchKey, patched({ recurrence: daily }));

    expect(rowOf(client)?.occurrenceDate).toBeUndefined();
  });

  /**
   * The founder's flow, step 7: complete today, then switch the series back to a one-off.
   *
   * `completed_occurrence` describes an occurrence that no longer exists, so the row stayed
   * crossed off with an `Undo` that targeted nothing — "stuck as completed, won't switch back".
   */
  it('keeps occurrence state until authoritative expansion replaces it', () => {
    const client = seeded(
      row({ isRecurring: true, occurrenceDate: TODAY, status: 'completed_occurrence' }),
    );

    projectActivityWrite(client, patchKey, patched({}));

    expect(rowOf(client)?.status).toBe('completed_occurrence');
    expect(rowOf(client)?.occurrenceDate).toBe(TODAY);
    expect(rowOf(client)?.isRecurring).toBe(true);
  });

  /** A one-off exists on exactly one date, so the other days' occurrences go with the rule. */
  it('does not partially collapse occurrences when the recurrence is removed', () => {
    const client = new QueryClient();
    client.setQueryData(KEY, {
      days: [
        {
          date: TODAY,
          schedule: [
            row({ isRecurring: true, occurrenceDate: TODAY }),
            row({ isRecurring: true, occurrenceDate: '2026-08-14', time: '09:31' }),
          ],
          anytime: [],
          earlier: [],
        },
      ],
      warnings: [],
    } satisfies AgendaData);

    projectActivityWrite(client, patchKey, patched({}));

    const agenda = client.getQueryData<AgendaData>(KEY);
    const rows = (agenda?.days ?? []).flatMap((day) =>
      [...day.schedule, ...day.anytime, ...day.earlier].filter(
        (item) => item.activityId === 'act_STANDUP',
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((item) => item.occurrenceDate)).toEqual([TODAY, '2026-08-14']);
  });

  it('removes a confirmed-stale recurrence expansion while canonical reconciliation runs', () => {
    const client = new QueryClient();
    client.setQueryData(KEY, {
      days: [
        {
          date: TODAY,
          schedule: [
            row({ isRecurring: true, occurrenceDate: TODAY }),
            row({ isRecurring: true, occurrenceDate: '2026-08-14', time: '09:31' }),
          ],
          anytime: [],
          earlier: [],
        },
      ],
      warnings: [],
    } satisfies AgendaData);

    projectActivityWrite(
      client,
      patchKey,
      patched({ updatedAt: '2026-08-13T13:30:00.000Z', recurrence: daily }),
      { activityId: 'act_STANDUP', input: { recurrence: daily } },
    );

    expect(rowOf(client)).toBeUndefined();
  });

  it('leaves a window that never held the activity alone', () => {
    const client = seeded(row({ activityId: 'act_OTHER' }));

    projectActivityWrite(client, patchKey, patched({ title: 'Renamed' }));

    expect(rowOf(client)).toBeUndefined();
  });
});

describe('versioned agenda reconciliation', () => {
  it('discards two stale GSI bodies before accepting the observed activity version', async () => {
    const client = seeded(row({ title: 'Before' }));
    const body = (title: string, version: string): AgendaData => ({
      days: [
        {
          date: TODAY,
          schedule: [row({ title })],
          anytime: [],
          earlier: [],
        },
      ],
      warnings: [],
      projectionVersions: [{ activityId: 'act_STANDUP', version }],
    });
    const responses = [
      body('Stale one', '2026-08-14T09:00:00.000Z'),
      body('Stale two', '2026-08-14T09:59:59.000Z'),
      body('Current', '2026-08-14T10:00:00.000Z'),
    ];
    const load = vi.fn(async () => responses.shift() as AgendaData);
    const seenWhileWaiting: string[] = [];

    const reconciled = await reconcileAgendaProjection(
      client,
      {
        activityId: 'act_STANDUP',
        version: '2026-08-14T10:00:00.000Z',
      },
      load,
      async () => {
        const cached = client.getQueryData<AgendaData>(KEY);
        seenWhileWaiting.push(cached?.days[0]?.schedule[0]?.title ?? 'missing');
      },
    );

    expect(reconciled).toBe(true);
    expect(load).toHaveBeenCalledTimes(3);
    expect(seenWhileWaiting).toEqual(['Before', 'Before']);
    expect(client.getQueryData<AgendaData>(KEY)?.days[0]?.schedule[0]?.title).toBe(
      'Current',
    );
  });
});

/**
 * The other write that opted into the stale-marking and forgot the projection.
 *
 * The detail screen navigates away on a successful delete, but the Today tab it returns to is
 * already mounted and refetches nothing — so the deleted row stayed on screen until a remount,
 * a foreground, or the 60-second `staleTime` expired.
 */
describe('a delete reaches the agenda cache', () => {
  const deleteKey = ['activity', 'delete'];

  const holds = (client: QueryClient, activityId: string): number => {
    const agenda = client.getQueryData<AgendaData>(KEY);
    return (agenda?.days ?? []).flatMap((day) =>
      [...day.schedule, ...day.anytime, ...day.earlier].filter(
        (item) => item.activityId === activityId,
      ),
    ).length;
  };

  it('removes the row, so Today drops it without a refetch', () => {
    const client = seeded();

    expect(projectActivityWrite(client, deleteKey, { activityId: 'act_STANDUP' })).toBe(
      true,
    );

    expect(holds(client, 'act_STANDUP')).toBe(0);
  });

  /**
   * `replaceAgendaItem` matches `activityId` *and* `occurrenceDate`, so a bare-id target would
   * have removed only the undated row and left every expanded occurrence on screen.
   */
  it('removes every occurrence of a deleted series', () => {
    const client = new QueryClient();
    client.setQueryData(KEY, {
      days: [
        {
          date: TODAY,
          schedule: [
            row({ isRecurring: true, occurrenceDate: TODAY }),
            row({ isRecurring: true, occurrenceDate: '2026-08-14', time: '09:31' }),
          ],
          anytime: [],
          earlier: [],
        },
      ],
      warnings: [],
    } satisfies AgendaData);

    projectActivityWrite(client, deleteKey, { activityId: 'act_STANDUP' });

    expect(holds(client, 'act_STANDUP')).toBe(0);
  });

  it('leaves a window that never held the activity alone', () => {
    const client = seeded(row({ activityId: 'act_OTHER' }));

    projectActivityWrite(client, deleteKey, { activityId: 'act_STANDUP' });

    expect(holds(client, 'act_OTHER')).toBe(1);
  });

  it('clears an older pending recurrence version when the series is deleted', async () => {
    const client = seeded();
    const stale: AgendaData = {
      days: [{ date: TODAY, schedule: [row()], anytime: [], earlier: [] }],
      warnings: [],
      projectionVersions: [
        { activityId: 'act_STANDUP', version: '2026-08-14T09:00:00.000Z' },
      ],
    };

    expect(
      await reconcileAgendaProjection(
        client,
        {
          activityId: 'act_STANDUP',
          version: '2026-08-14T10:00:00.000Z',
        },
        async () => stale,
        async () => {},
      ),
    ).toBe(false);

    projectActivityWrite(client, deleteKey, { activityId: 'act_STANDUP' });
    const current: AgendaData = {
      days: [{ date: TODAY, schedule: [], anytime: [], earlier: [] }],
      warnings: [],
      projectionVersions: [],
    };

    expect(guardAgendaResponse(client, KEY, current)).toBe(current);
  });
});

/**
 * The writes that are deliberately unprojected. Named here so the opt-out stays a decision:
 * snooze projects itself from the agenda screen, and reminder writes touch no agenda window.
 */
describe('writes that deliberately project nothing', () => {
  it.each([['snooze'], ['unsnooze'], ['reminder-create'], ['reminder-delete']])(
    '%s leaves the cached agenda untouched',
    (tag) => {
      const client = seeded();
      const before = client.getQueryData<AgendaData>(KEY);

      expect(
        projectActivityWrite(client, ['activity', tag], { activityId: 'act_STANDUP' }),
      ).toBe(false);

      expect(client.getQueryData<AgendaData>(KEY)).toBe(before);
    },
  );

  it('ignores a mutation key that is not an activity write at all', () => {
    const client = seeded();

    expect(projectActivityWrite(client, ['list', 'create'], { activityId: 'x' })).toBe(
      false,
    );
  });
});

/**
 * Rescheduling one occurrence of a series.
 *
 * Reachable only since the detail screen started sending `occurrenceDate` — before that the
 * server rejected the write. `applyReschedule` matches `activityId` *and* `occurrenceDate`, and
 * the projector passed none, so no row matched, the `applyCreate` fallback fired, and the
 * window gained a **second** row: "I somehow managed to duplicate a task on UI".
 */
describe('a recurring occurrence rescheduled to a new time', () => {
  const scheduleKey = ['activity', 'schedule'];

  /** META is untouched by an occurrence override, so the response still carries the anchor. */
  const seriesResponse = {
    activityId: 'act_STANDUP',
    type: 'task',
    title: 'Stand-up',
    status: 'scheduled',
    schedule: { date: TODAY, time: '09:30', timezone: 'America/New_York' },
    recurrence: {
      mode: 'fixed',
      segments: [{ freq: 'daily', effectiveFrom: TODAY, time: '09:30' }],
    },
  };

  const rowsFor = (client: QueryClient) => {
    const agenda = client.getQueryData<AgendaData>(KEY);
    return (agenda?.days ?? []).flatMap((day) =>
      [...day.schedule, ...day.anytime, ...day.earlier].filter(
        (item) => item.activityId === 'act_STANDUP',
      ),
    );
  };

  it('moves the occurrence instead of adding a second row', () => {
    const client = seeded(row({ isRecurring: true, occurrenceDate: TODAY }));

    projectActivityWrite(client, scheduleKey, seriesResponse, {
      activityId: 'act_STANDUP',
      input: { date: TODAY, time: '18:00', occurrenceDate: TODAY },
    });

    const rows = rowsFor(client);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.time).toBe('18:00');
    expect(rows[0]?.occurrenceDate).toBe(TODAY);
  });

  it('leaves the other occurrences of the series where they are', () => {
    const client = new QueryClient();
    client.setQueryData(KEY, {
      days: [
        {
          date: TODAY,
          schedule: [
            row({ isRecurring: true, occurrenceDate: TODAY }),
            row({ isRecurring: true, occurrenceDate: '2026-08-14', time: '09:30' }),
          ],
          anytime: [],
          earlier: [],
        },
      ],
      warnings: [],
    } satisfies AgendaData);

    projectActivityWrite(client, scheduleKey, seriesResponse, {
      activityId: 'act_STANDUP',
      input: { date: TODAY, time: '18:00', occurrenceDate: TODAY },
    });

    const rows = rowsFor(client);
    expect(rows).toHaveLength(2);
    expect(rows.find((item) => item.occurrenceDate === '2026-08-14')?.time).toBe('09:30');
  });
});

/**
 * A created or duplicated recurring activity is an occurrence too.
 *
 * `applyCreate` set `isRecurring` and no `occurrenceDate`, so the projected row named a
 * series without naming a day. The Today checkbox reads that field to scope its write, so
 * ticking the row sent an *unscoped* complete — which sets the status on the series row, and
 * `agendaService.mergeNominal` renders every un-overridden occurrence with the series status.
 * One tick, whole series crossed off.
 */
describe('a created recurring activity carries its occurrence date', () => {
  /** The row lands in whichever bucket its time implies, so look in all three. */
  const createdRow = (client: QueryClient): AgendaItem | undefined => {
    const agenda = client.getQueryData<AgendaData>(KEY);
    for (const day of agenda?.days ?? []) {
      for (const item of [...day.schedule, ...day.anytime, ...day.earlier]) {
        if (item.activityId === 'act_NEW') return item;
      }
    }
    return undefined;
  };

  it('names the day it was placed on', () => {
    const client = new QueryClient();
    client.setQueryData(KEY, {
      days: [{ date: TODAY, schedule: [], anytime: [], earlier: [] }],
      warnings: [],
    } satisfies AgendaData);

    projectActivityWrite(client, ['activity', 'create'], {
      activityId: 'act_NEW',
      type: 'task',
      title: 'Stand-up',
      status: 'scheduled',
      schedule: { date: TODAY, time: '09:30', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TODAY, time: '09:30' }],
      },
    });

    expect(createdRow(client)?.isRecurring).toBe(true);
    expect(createdRow(client)?.occurrenceDate).toBe(TODAY);
  });

  it('leaves a one-off without one', () => {
    const client = new QueryClient();
    client.setQueryData(KEY, {
      days: [{ date: TODAY, schedule: [], anytime: [], earlier: [] }],
      warnings: [],
    } satisfies AgendaData);

    projectActivityWrite(client, ['activity', 'create'], {
      activityId: 'act_NEW',
      type: 'task',
      title: 'Buy milk',
      status: 'scheduled',
      schedule: { date: TODAY, time: '09:30', timezone: 'America/New_York' },
    });

    expect(createdRow(client)?.occurrenceDate).toBeUndefined();
  });
});

/**
 * A legacy recurrence-removal PATCH cannot be projected from one cached window.
 *
 * The surviving one-off used to be chosen by comparing each row's day to
 * `activity.schedule.date` — the series **anchor**, which is where the series started, not the
 * occurrence anyone is looking at. Every row in a window that did not contain the anchor was
 * therefore dropped, so stopping a repeat while looking at today made the task vanish, against
 * the confirmation's own promise that it "keeps the activity".
 */
describe('stopping a repeat keeps the activity', () => {
  const patchKey = ['activity', 'patch'];

  /** The server's answer: a one-off, still anchored on its original schedule date. */
  const flattened = {
    activityId: 'act_STANDUP',
    type: 'task',
    title: 'Stand-up',
    status: 'scheduled',
    schedule: { date: '2026-08-01', time: '09:30', timezone: 'America/New_York' },
  };

  const rowsOf = (client: QueryClient) => {
    const agenda = client.getQueryData<AgendaData>(KEY);
    return (agenda?.days ?? []).flatMap((day) =>
      [...day.schedule, ...day.anytime, ...day.earlier].filter(
        (item) => item.activityId === 'act_STANDUP',
      ),
    );
  };

  it('leaves the row untouched until the conversion response is projected', () => {
    const client = seeded(row({ isRecurring: true, occurrenceDate: TODAY }));

    projectActivityWrite(client, patchKey, flattened);

    const rows = rowsOf(client);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isRecurring).toBe(true);
    expect(rows[0]?.occurrenceDate).toBe(TODAY);
  });

  /** Still exactly one per day bucket, since clearing the occurrence collapses identities. */
  it('does not guess which occurrence survives', () => {
    const client = new QueryClient();
    client.setQueryData(KEY, {
      days: [
        {
          date: TODAY,
          schedule: [
            row({ isRecurring: true, occurrenceDate: TODAY }),
            row({ isRecurring: true, occurrenceDate: '2026-08-14', time: '09:31' }),
          ],
          anytime: [],
          earlier: [],
        },
      ],
      warnings: [],
    } satisfies AgendaData);

    projectActivityWrite(client, patchKey, flattened);

    expect(rowsOf(client)).toHaveLength(2);
  });
});

/**
 * Ending a series remains a recurrence PATCH, but its expanded rows are server-owned.
 *
 * `endDate` is inclusive (`expand.ts`), so the day it names survives and everything after it
 * stops. Without projecting that, "stop repeating" left every future occurrence on screen: the
 * patch said nothing about the end, and `refreshActivityLists` marks the agenda stale with
 * `refetchType: 'none'`, so nothing refetched to correct it.
 */
describe('ending a series drops the occurrences after its last day', () => {
  const patchKey = ['activity', 'patch'];
  const laterDays = ['2026-08-14', '2026-08-15'];

  const endedOn = (endDate: string) => ({
    activityId: 'act_STANDUP',
    type: 'task',
    title: 'Stand-up',
    status: 'scheduled',
    schedule: { date: '2026-08-01', time: '09:30', timezone: 'America/New_York' },
    recurrence: {
      mode: 'fixed',
      segments: [{ freq: 'daily', effectiveFrom: '2026-08-01', time: '09:30' }],
      endDate,
    },
  });

  const seededWindow = () => {
    const client = new QueryClient();
    client.setQueryData(KEY, {
      days: [TODAY, ...laterDays].map((date) => ({
        date,
        schedule: [row({ isRecurring: true, occurrenceDate: date })],
        anytime: [],
        earlier: [],
      })),
      warnings: [],
    } satisfies AgendaData);
    return client;
  };

  const remaining = (client: QueryClient) => {
    const agenda = client.getQueryData<AgendaData>(KEY);
    return (agenda?.days ?? []).flatMap((day) =>
      [...day.schedule, ...day.anytime, ...day.earlier]
        .filter((item) => item.activityId === 'act_STANDUP')
        .map((item) => item.occurrenceDate),
    );
  };

  it('waits for canonical expansion before removing later days', () => {
    const client = seededWindow();

    projectActivityWrite(client, patchKey, endedOn(TODAY));

    expect(remaining(client)).toEqual([TODAY, ...laterDays]);
  });

  it('leaves a series with no end date untouched', () => {
    const client = seededWindow();
    const open = endedOn(TODAY);
    const { endDate: _dropped, ...openRule } = open.recurrence;

    projectActivityWrite(client, patchKey, { ...open, recurrence: openRule });

    expect(remaining(client)).toEqual([TODAY, ...laterDays]);
  });

  /** The row on the end date is still a series row; ending is not flattening. */
  it('leaves the surviving occurrence recurring', () => {
    const client = seededWindow();

    projectActivityWrite(client, patchKey, endedOn(TODAY));

    const agenda = client.getQueryData<AgendaData>(KEY);
    const survivor = agenda?.days[0]?.schedule[0];
    expect(survivor?.isRecurring).toBe(true);
    expect(survivor?.occurrenceDate).toBe(TODAY);
  });
});

/**
 * A declined outcome is stored as a skip, and the response says so. Reported from the built
 * app: answering `Didn't go` on Today settled on a struck-through row reading `Attended` —
 * `resolvePassed` projected the skip correctly and this overwrote it a moment later.
 */
describe('a declined outcome projects as a skip, not a completion', () => {
  it.each(['didnt_go', 'didnt_happen'] as const)('projects %s as skipped', (outcome) => {
    const client = seeded();

    projectActivityWrite(
      client,
      ['activity', 'complete'],
      { ...completion('act_STANDUP', 'skipped'), outcome },
      { activityId: 'act_STANDUP' },
    );

    expect(statusOf(client, 'act_STANDUP')).toBe('skipped');
  });

  it.each(['attended', 'done', 'had_it', 'watched'] as const)(
    'leaves %s projecting as a completion',
    (outcome) => {
      const client = seeded();

      projectActivityWrite(
        client,
        ['activity', 'complete'],
        { ...completion('act_STANDUP', 'completed'), outcome },
        { activityId: 'act_STANDUP' },
      );

      expect(statusOf(client, 'act_STANDUP')).toBe('completed');
    },
  );

  /** No outcome at all — the checkbox path — still completes. */
  it('projects a completion with no outcome as a completion', () => {
    const client = seeded();

    projectActivityWrite(
      client,
      ['activity', 'complete'],
      completion('act_STANDUP', 'completed'),
      { activityId: 'act_STANDUP' },
    );

    expect(statusOf(client, 'act_STANDUP')).toBe('completed');
  });
});

/**
 * The server's authoritative occurrence, written into the entry an occurrence-targeted detail
 * screen actually reads. Dropping it left the resolved state existing only as that screen's own
 * local projection, which a racing refetch could quietly replace.
 */
describe('an occurrence resolution reaches the occurrence detail entry', () => {
  const occurrenceKey = ['activity', 'act_STANDUP', 'occurrence', TODAY];

  const seedDetail = (client: QueryClient) => {
    client.setQueryData(occurrenceKey, {
      activity: { activityId: 'act_STANDUP' },
      reminders: [],
      occurrence: {
        nominalDate: TODAY,
        date: TODAY,
        time: '09:30',
        status: 'scheduled',
        isSnoozed: false,
      },
    });
  };

  it('writes a skipped occurrence status, in the projection’s own vocabulary', () => {
    const client = seeded(row({ isRecurring: true, occurrenceDate: TODAY }));
    seedDetail(client);

    projectActivityWrite(
      client,
      ['activity', 'skip'],
      {
        ...completion('act_STANDUP', 'scheduled'),
        occurrenceDate: TODAY,
        occurrence: { activityId: 'act_STANDUP', date: TODAY, status: 'skipped' },
      },
      { activityId: 'act_STANDUP', input: { occurrenceDate: TODAY } },
    );

    expect(
      client.getQueryData<{ occurrence: { status: string } }>(occurrenceKey)?.occurrence
        .status,
    ).toBe('skipped_occurrence');
  });

  /**
   * The other direction, which is what made the disagreement durable. An occurrence
   * `uncomplete` deletes the row and returns no `occurrence`, so reading the response alone
   * left the cache still claiming `skipped_occurrence` after the skip had been undone.
   */
  it('clears the status when an uncomplete deletes the occurrence', () => {
    const client = seeded(row({ isRecurring: true, occurrenceDate: TODAY }));
    client.setQueryData(occurrenceKey, {
      activity: { activityId: 'act_STANDUP' },
      reminders: [],
      occurrence: {
        nominalDate: TODAY,
        date: TODAY,
        time: '09:30',
        status: 'skipped_occurrence',
        isSnoozed: true,
      },
    });

    projectActivityWrite(
      client,
      ['activity', 'uncomplete'],
      { ...completion('act_STANDUP', 'scheduled'), occurrenceDate: TODAY },
      { activityId: 'act_STANDUP', input: { occurrenceDate: TODAY } },
    );

    const occurrence = client.getQueryData<{
      occurrence: { status: string; isSnoozed: boolean };
    }>(occurrenceKey)?.occurrence;
    expect(occurrence?.status).toBe('scheduled');
    expect(occurrence?.isSnoozed).toBe(false);
  });

  /** Uncompleting something that was only snoozed deletes nothing, so nothing is cleared. */
  it('leaves a snoozed occurrence alone when the uncomplete returns it', () => {
    const client = seeded(row({ isRecurring: true, occurrenceDate: TODAY }));
    client.setQueryData(occurrenceKey, {
      activity: { activityId: 'act_STANDUP' },
      reminders: [],
      occurrence: {
        nominalDate: TODAY,
        date: TODAY,
        time: '10:30',
        status: 'scheduled',
        isSnoozed: true,
      },
    });

    projectActivityWrite(
      client,
      ['activity', 'uncomplete'],
      {
        ...completion('act_STANDUP', 'scheduled'),
        occurrenceDate: TODAY,
        occurrence: { activityId: 'act_STANDUP', date: TODAY, status: 'snoozed' },
      },
      { activityId: 'act_STANDUP', input: { occurrenceDate: TODAY } },
    );

    expect(
      client.getQueryData<{ occurrence: { isSnoozed: boolean } }>(occurrenceKey)
        ?.occurrence.isSnoozed,
    ).toBe(true);
  });

  /** A snooze is not a resolution and must not be written as one. */
  it('leaves the status alone for a snoozed occurrence', () => {
    const client = seeded(row({ isRecurring: true, occurrenceDate: TODAY }));
    seedDetail(client);

    projectActivityWrite(
      client,
      ['activity', 'skip'],
      {
        ...completion('act_STANDUP', 'scheduled'),
        occurrenceDate: TODAY,
        occurrence: { activityId: 'act_STANDUP', date: TODAY, status: 'snoozed' },
      },
      { activityId: 'act_STANDUP', input: { occurrenceDate: TODAY } },
    );

    expect(
      client.getQueryData<{ occurrence: { status: string } }>(occurrenceKey)?.occurrence
        .status,
    ).toBe('scheduled');
  });
});

/**
 * The snooze projection and its rollback, at the layer where they are deterministic.
 *
 * This began as a component test that drove a failing write and watched the header go back.
 * It was flaky: the rollback runs on a rejected promise inside a detached handler, so whether
 * `waitFor` observed the restored state depended on scheduling, and the assertion it settled on
 * was also satisfiable by the *initial* state. A test that can pass without the behaviour
 * happening, and fail when it does, is worse than no test — `testing.md` §10 rule 2. The
 * closure is a pure function of the cache; asserted here it needs no clock, no fetch and no
 * React.
 */
describe('a snooze projects into both cache shapes and rolls both back', () => {
  const occurrenceKey = ['activity', 'act_STANDUP', 'occurrence', TODAY];
  const seriesKey = ['activity', 'act_STANDUP'];

  it('moves an occurrence’s time and puts it back', () => {
    const client = seeded(row({ isRecurring: true, occurrenceDate: TODAY }));
    client.setQueryData(occurrenceKey, {
      activity: { activityId: 'act_STANDUP' },
      reminders: [],
      occurrence: {
        nominalDate: TODAY,
        date: TODAY,
        time: '09:30',
        status: 'scheduled',
        isSnoozed: false,
      },
    });

    const rollback = projectOptimisticSnooze(client, {
      activityId: 'act_STANDUP',
      occurrenceDate: TODAY,
      date: TODAY,
      time: '10:00',
    });

    const current = () =>
      client.getQueryData<{ occurrence: { time: string; isSnoozed: boolean } }>(
        occurrenceKey,
      )?.occurrence;
    expect(current()).toMatchObject({ time: '10:00', isSnoozed: true });

    rollback();
    expect(current()).toMatchObject({ time: '09:30', isSnoozed: false });
  });

  /** The one-off shape stores it on the Activity, and must roll back just as completely. */
  it('moves a one-off’s snoozedUntil and puts it back', () => {
    const client = seeded();
    client.setQueryData(seriesKey, {
      activity: { activityId: 'act_STANDUP' },
      reminders: [],
    });

    const rollback = projectOptimisticSnooze(client, {
      activityId: 'act_STANDUP',
      date: TODAY,
      time: '10:00',
    });

    const current = () =>
      client.getQueryData<{ activity: { snoozedUntil?: string } }>(seriesKey)?.activity;
    expect(current()?.snoozedUntil).toBe('10:00');

    rollback();
    expect(current()?.snoozedUntil).toBeUndefined();
  });

  it('restores the agenda row as well as the detail entry', () => {
    const client = seeded(row({ time: '09:30' }));

    const rollback = projectOptimisticSnooze(client, {
      activityId: 'act_STANDUP',
      date: TODAY,
      time: '10:00',
    });

    const timeOf = () => client.getQueryData<AgendaData>(KEY)?.days[0]?.schedule[0]?.time;
    expect(timeOf()).toBe('10:00');

    rollback();
    expect(timeOf()).toBe('09:30');
  });
});

/**
 * Reported: create a Meal that repeats daily and only today's occurrence appears, without the
 * repeat glyph. Reproduced against the local API, which returned all seven days correctly for
 * the same activity — so the row was right on the wire and wrong in the cache.
 *
 * `applyCreate` writes one row on the activity's own date, which is all a one-off has and the
 * first day of all a series has. Nothing asked for the rest, and the glyph is driven by
 * `recurrenceDescription`, which the server authors and an optimistic row cannot invent.
 */
describe('creating a series asks for the expansion it cannot derive', () => {
  const series = {
    activityId: 'act_STANDUP',
    objectKind: 'plan',
    type: 'meal',
    title: 'Dinner plan',
    status: 'scheduled',
    schedule: { date: TODAY, time: '18:00', timezone: 'UTC' },
    recurrence: { mode: 'fixed', segments: [{ freq: 'daily', effectiveFrom: TODAY }] },
    updatedAt: '2026-08-14T10:00:00.000Z',
  };

  it('projects the first day immediately and reconciles the rest', async () => {
    const client = seeded();
    const expanded: AgendaData = {
      days: [
        {
          date: TODAY,
          schedule: [row({ title: 'Dinner plan' })],
          anytime: [],
          earlier: [],
        },
      ],
      warnings: [],
      projectionVersions: [{ activityId: 'act_STANDUP', version: series.updatedAt }],
    };

    projectActivityWrite(client, ['activity', 'create'], { activity: series }, {});

    // The optimistic row is there at once, on its own date.
    expect(
      client.getQueryData<AgendaData>(KEY)?.days[0]?.schedule.map((r) => r.activityId),
    ).toContain('act_STANDUP');

    // And the canonical expansion is requested rather than waited for.
    const reconciled = await reconcileAgendaProjection(
      client,
      { activityId: 'act_STANDUP', version: series.updatedAt },
      async () => expanded,
      async () => {},
    );
    expect(reconciled).toBe(true);
  });

  /** A one-off has nothing to expand, so it must not pay for a reconciliation round trip. */
  it('does not reconcile a one-off create', () => {
    const client = seeded();
    const { recurrence: _recurrence, ...oneOff } = series;

    expect(
      projectActivityWrite(client, ['activity', 'create'], { activity: oneOff }, {}),
    ).toBe(true);
    expect(guardAgendaResponse(client, KEY, { days: [], warnings: [] })).toEqual({
      days: [],
      warnings: [],
    });
  });
});
