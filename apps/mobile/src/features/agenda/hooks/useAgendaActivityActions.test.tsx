import type { AgendaData, AgendaItem } from '@od/shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
