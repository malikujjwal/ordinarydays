import type { AgendaData, AgendaItem } from '@od/shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerActivityMutationDefaults } from '@/lib/mutationDefaults';
import { useToast } from '@/stores/toast';
import { useAgendaActivityActions } from './useAgendaActivityActions';

const clientCalls = vi.hoisted(() => ({
  complete: vi.fn(),
  uncomplete: vi.fn(),
  snooze: vi.fn(),
  unsnooze: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock('@od/shared/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@od/shared/client')>()),
  completeActivity: clientCalls.complete,
  uncompleteActivity: clientCalls.uncomplete,
  snoozeActivity: clientCalls.snooze,
  unsnoozeActivity: clientCalls.unsnooze,
  scheduleActivity: clientCalls.schedule,
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'idem-test-key' }));

const first: AgendaItem = {
  activityId: 'act_FIRST',
  type: 'task',
  title: 'First',
  status: 'scheduled',
  time: '17:00',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: false, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
};
const second = { ...first, activityId: 'act_SECOND', title: 'Second', time: '19:00' };
const cached: AgendaData = {
  days: [
    {
      date: '2026-08-11',
      upNext: first,
      schedule: [first, second],
      anytime: [],
      earlier: [],
    },
  ],
  warnings: [],
};

function setup(restoreScrollOffset = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false, networkMode: 'always' } },
  });
  registerActivityMutationDefaults(client);
  const key = ['agenda', '2026-08-11'];
  const anytimeKey = ['activities', 'saved'];
  client.setQueryData(key, cached);
  client.setQueryData(anytimeKey, {
    pages: [
      {
        data: [
          {
            activityId: first.activityId,
            type: 'task',
            title: first.title,
            status: 'saved',
            isRecurring: false,
            participantCount: 0,
          },
        ],
        meta: { requestId: 'req_saved' },
      },
    ],
    pageParams: [undefined],
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () =>
      useAgendaActivityActions({
        today: '2026-08-11',
        currentMinute: '15:00',
        timezone: 'UTC',
        getScrollOffset: () => 240,
        restoreScrollOffset,
      }),
    { wrapper },
  );
  return { ...hook, client, key, anytimeKey, restoreScrollOffset };
}

beforeEach(() => {
  clientCalls.complete.mockReset();
  clientCalls.uncomplete.mockReset();
  clientCalls.snooze.mockReset();
  clientCalls.unsnooze.mockReset();
  clientCalls.schedule.mockReset();
  useToast.setState({ current: undefined });
});

describe('useAgendaActivityActions completion undo', () => {
  it('restores the exact cache order and scroll offset, then compensates', async () => {
    let finishComplete!: () => void;
    clientCalls.complete.mockReturnValue(
      new Promise<void>((resolve) => {
        finishComplete = resolve;
      }),
    );
    clientCalls.uncomplete.mockResolvedValue(undefined);
    const mounted = setup();

    act(() => mounted.result.current.toggleComplete(first, true));
    expect(mounted.client.getQueryData<AgendaData>(mounted.key)).toEqual({
      ...cached,
      days: [
        {
          date: '2026-08-11',
          upNext: second,
          schedule: [second],
          anytime: [],
          earlier: [{ ...first, status: 'completed' }],
        },
      ],
    });
    await waitFor(() => expect(clientCalls.complete).toHaveBeenCalledOnce());
    expect(
      mounted.client.getQueryData<{ pages: Array<{ data: AgendaItem[] }> }>(
        mounted.anytimeKey,
      )?.pages[0]?.data[0]?.status,
    ).toBe('completed');

    act(() => useToast.getState().undo());
    expect(mounted.client.getQueryData(mounted.key)).toEqual(cached);
    expect(
      mounted.client.getQueryData<{ pages: Array<{ data: AgendaItem[] }> }>(
        mounted.anytimeKey,
      )?.pages[0]?.data[0]?.status,
    ).toBe('saved');
    expect(mounted.restoreScrollOffset).toHaveBeenCalledExactlyOnceWith(240);
    expect(clientCalls.uncomplete).not.toHaveBeenCalled();

    finishComplete();
    await waitFor(() => expect(clientCalls.uncomplete).toHaveBeenCalledOnce());
  });

  it('reverts a failed original and replaces Undo with Retry', async () => {
    clientCalls.complete.mockRejectedValue(new Error('network'));
    const mounted = setup();

    act(() => mounted.result.current.toggleComplete(first, true));

    await waitFor(() =>
      expect(useToast.getState().current).toMatchObject({
        kind: 'message',
        tone: 'error',
        message: "Couldn't complete this task.",
        action: { label: 'Retry' },
      }),
    );
    expect(mounted.client.getQueryData(mounted.key)).toEqual(cached);
  });

  it('records an exact passed-plan outcome and Undo compensates the same occurrence', async () => {
    clientCalls.complete.mockResolvedValue(undefined);
    clientCalls.uncomplete.mockResolvedValue(undefined);
    const mounted = setup();
    const passed: AgendaItem = {
      ...first,
      type: 'event',
      title: 'Dentist appointment',
      hasCheckbox: false,
      time: '10:00',
      occurrenceDate: '2026-08-11',
      isRecurring: true,
      isPast: true,
    };
    mounted.client.setQueryData<AgendaData>(mounted.key, {
      days: [
        {
          date: '2026-08-11',
          schedule: [],
          anytime: [],
          earlier: [passed],
        },
      ],
      warnings: [],
    });

    act(() => mounted.result.current.resolvePassed(passed, 'didnt_go'));

    await waitFor(() => expect(clientCalls.complete).toHaveBeenCalledOnce());
    expect(clientCalls.complete).toHaveBeenCalledWith(
      expect.anything(),
      passed.activityId,
      { occurrenceDate: '2026-08-11', outcome: 'didnt_go' },
      'idem-test-key',
    );
    expect(
      mounted.client.getQueryData<AgendaData>(mounted.key)?.days[0]?.earlier[0]?.status,
    ).toBe('skipped_occurrence');

    act(() => useToast.getState().undo());
    await waitFor(() => expect(clientCalls.uncomplete).toHaveBeenCalledOnce());
    expect(clientCalls.uncomplete).toHaveBeenCalledWith(
      expect.anything(),
      passed.activityId,
      { occurrenceDate: '2026-08-11' },
      'idem-test-key',
    );
    expect(
      mounted.client.getQueryData<AgendaData>(mounted.key)?.days[0]?.earlier[0]?.status,
    ).toBe('scheduled');
  });

  it('snoozes a one-off without occurrenceDate and undo unsnoozes the same scope', async () => {
    clientCalls.snooze.mockResolvedValue(undefined);
    clientCalls.unsnooze.mockResolvedValue(undefined);
    const mounted = setup();

    act(() => mounted.result.current.snooze(first, '18:00'));
    await waitFor(() => expect(clientCalls.snooze).toHaveBeenCalledOnce());

    expect(clientCalls.snooze).toHaveBeenCalledWith(
      expect.anything(),
      first.activityId,
      { until: '18:00' },
      'idem-test-key',
    );
    expect(
      mounted.client.getQueryData<AgendaData>(mounted.key)?.days[0]?.schedule[0],
    ).toMatchObject({ time: '18:00', originalTime: '17:00', isSnoozed: true });

    act(() => useToast.getState().undo());
    await waitFor(() => expect(clientCalls.unsnooze).toHaveBeenCalledOnce());
    expect(clientCalls.unsnooze).toHaveBeenCalledWith(
      expect.anything(),
      first.activityId,
      {},
      'idem-test-key',
    );
  });

  it('always scopes recurring snooze and undo to the occurrence', async () => {
    clientCalls.snooze.mockResolvedValue(undefined);
    clientCalls.unsnooze.mockResolvedValue(undefined);
    const mounted = setup();
    const occurrence = {
      ...first,
      isRecurring: true,
      occurrenceDate: '2026-08-11',
    };

    act(() => mounted.result.current.snooze(occurrence, '18:00'));
    await waitFor(() => expect(clientCalls.snooze).toHaveBeenCalledOnce());
    expect(clientCalls.snooze.mock.calls[0]?.[2]).toEqual({
      occurrenceDate: '2026-08-11',
      until: '18:00',
    });

    act(() => useToast.getState().undo());
    await waitFor(() => expect(clientCalls.unsnooze).toHaveBeenCalledOnce());
    expect(clientCalls.unsnooze.mock.calls[0]?.[2]).toEqual({
      occurrenceDate: '2026-08-11',
    });
  });

  it('moves Tomorrow through schedule with the unchanged time, never snooze', async () => {
    clientCalls.schedule.mockResolvedValue(undefined);
    const mounted = setup();

    act(() => mounted.result.current.moveToTomorrow(first));
    await waitFor(() => expect(clientCalls.schedule).toHaveBeenCalledOnce());

    expect(clientCalls.schedule).toHaveBeenCalledWith(
      expect.anything(),
      first.activityId,
      { date: '2026-08-12', time: '17:00', timezone: 'UTC' },
      'idem-test-key',
    );
    expect(clientCalls.snooze).not.toHaveBeenCalled();

    act(() => useToast.getState().undo());
    await waitFor(() => expect(clientCalls.schedule).toHaveBeenCalledTimes(2));
    expect(clientCalls.schedule.mock.calls[1]?.[2]).toEqual({
      date: '2026-08-11',
      time: '17:00',
      timezone: 'UTC',
    });
  });
});

/**
 * A series row with no day is not something this checkbox may complete.
 *
 * `snooze` has always refused it. `toggleComplete` merely omitted `occurrenceDate` when the
 * row had none, which turns a tick into an unscoped `POST /complete` — that sets the status on
 * the series row, and `agendaService.mergeNominal` renders every un-overridden occurrence with
 * the series status. One tick crossed off the whole series.
 */
describe('useAgendaActivityActions recurring scope', () => {
  const seriesRow: AgendaItem = {
    ...first,
    activityId: 'act_SERIES',
    title: 'Stand-up',
    isRecurring: true,
    capabilities: { complete: true, skip: true, snooze: true },
  };

  /** The row has to be in the cached window, or nothing writes for an unrelated reason. */
  const withSeries = (item: AgendaItem) => {
    const mounted = setup();
    mounted.client.setQueryData(mounted.key, {
      ...cached,
      days: [{ ...cached.days[0], date: '2026-08-11', schedule: [item] }],
    });
    return mounted;
  };

  it('still completes a recurring row that names its day, scoped to it', async () => {
    clientCalls.complete.mockResolvedValue(undefined);
    const scoped = { ...seriesRow, occurrenceDate: '2026-08-11' };
    const mounted = withSeries(scoped);

    act(() => mounted.result.current.toggleComplete(scoped, true));

    await waitFor(() => expect(clientCalls.complete).toHaveBeenCalledOnce());
    expect(clientCalls.complete).toHaveBeenCalledWith(
      expect.anything(),
      'act_SERIES',
      expect.objectContaining({ occurrenceDate: '2026-08-11' }),
      expect.anything(),
    );
  });

  it('completes a future recurring occurrence with its explicit date', async () => {
    clientCalls.complete.mockResolvedValue(undefined);
    const future = { ...seriesRow, occurrenceDate: '2026-08-12' };
    const mounted = withSeries(future);

    act(() => mounted.result.current.toggleComplete(future, true));

    await waitFor(() => expect(clientCalls.complete).toHaveBeenCalledOnce());
    expect(clientCalls.complete).toHaveBeenCalledWith(
      expect.anything(),
      'act_SERIES',
      expect.objectContaining({ occurrenceDate: '2026-08-12' }),
      expect.anything(),
    );
  });

  /**
   * Asserted against the scoped case above: that one reaches the transport, so this one
   * failing to is the guard and not the harness.
   */
  it('writes nothing when a recurring row carries no occurrence date', async () => {
    clientCalls.complete.mockResolvedValue(undefined);
    const mounted = withSeries(seriesRow);

    act(() => mounted.result.current.toggleComplete(seriesRow, true));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(clientCalls.complete).not.toHaveBeenCalled();
  });
});
