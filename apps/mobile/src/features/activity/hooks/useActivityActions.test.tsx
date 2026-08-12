import type { AgendaData, AgendaItem } from '@od/shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '@/stores/toast';
import { useAgendaActivityActions } from './useActivityActions';

const clientCalls = vi.hoisted(() => ({
  complete: vi.fn(),
  uncomplete: vi.fn(),
}));

vi.mock('@od/shared/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@od/shared/client')>()),
  completeActivity: clientCalls.complete,
  uncompleteActivity: clientCalls.uncomplete,
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
  client.setQueryData(key, cached);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () =>
      useAgendaActivityActions({
        today: '2026-08-11',
        currentMinute: '15:00',
        getScrollOffset: () => 240,
        restoreScrollOffset,
      }),
    { wrapper },
  );
  return { ...hook, client, key, restoreScrollOffset };
}

beforeEach(() => {
  clientCalls.complete.mockReset();
  clientCalls.uncomplete.mockReset();
  useToast.setState({ current: undefined });
});

describe('useActivityActions completion undo', () => {
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

    act(() => useToast.getState().undo());
    expect(mounted.client.getQueryData(mounted.key)).toEqual(cached);
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
});
