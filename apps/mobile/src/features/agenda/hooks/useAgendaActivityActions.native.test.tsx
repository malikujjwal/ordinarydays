import type { AgendaData, AgendaItem } from '@od/shared/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completionCommitGateFor } from '@/features/agenda/completionCommitGate';
import { useToast } from '@/stores/toast';
import { useAgendaActivityActions } from './useAgendaActivityActions.native';

const nativeState = vi.hoisted(() => ({ current: undefined as unknown }));
let nextId = 0;

vi.mock('@/lib/sqlite/nativeState', () => ({
  requireActiveNativeState: () => nativeState.current,
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => `completion-${++nextId}`,
}));

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const task = (status: AgendaItem['status'] = 'scheduled'): AgendaItem => ({
  activityId: 'act_completion_gate',
  type: 'task',
  title: 'Call the dentist',
  status,
  time: '18:15',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: false, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
});

const agenda = (row: AgendaItem): AgendaData => ({
  days: [
    {
      date: '2026-08-20',
      schedule: [row],
      anytime: [],
      earlier: [],
    },
  ],
  warnings: [],
});

const options = (agendaData: AgendaData) => ({
  today: '2026-08-20',
  currentMinute: '12:00',
  timezone: 'America/New_York',
  agendaData,
});

afterEach(() => {
  nativeState.current = undefined;
  nextId = 0;
  useToast.setState({ current: undefined });
  vi.restoreAllMocks();
});

describe('native Agenda completion gate', () => {
  it('submits one transaction for repeated taps and waits for SQLite projection to unlock', async () => {
    const pending = deferred<{
      kind: 'accepted';
      status: 'queued';
      intent: { intentId: string };
    }>();
    const complete = vi.fn(() => pending.promise);
    const coordinator = { complete, undoCompletion: vi.fn() };
    nativeState.current = {
      coordinator,
    };
    const gate = completionCommitGateFor(coordinator);
    const scheduled = task();
    const mounted = renderHook(
      ({ data }: { data: AgendaData }) => useAgendaActivityActions(options(data)),
      { initialProps: { data: agenda(scheduled) } },
    );

    act(() => {
      mounted.result.current.toggleComplete(scheduled, true);
      mounted.result.current.toggleComplete(scheduled, true);
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(gate.isLocked(scheduled)).toBe(true);

    await act(async () => {
      pending.resolve({
        kind: 'accepted',
        status: 'queued',
        intent: { intentId: 'completion-1' },
      });
      await pending.promise;
    });
    expect(gate.isLocked(scheduled)).toBe(true);

    mounted.rerender({ data: agenda(task('completed')) });
    await waitFor(() => expect(gate.isLocked(scheduled)).toBe(false));
  });

  it('unlocks immediately when SQLite refuses the action so the user can retry', async () => {
    const complete = vi.fn(async () => ({
      kind: 'refused' as const,
      error: new Error('temporary SQLite failure'),
    }));
    const coordinator = { complete, undoCompletion: vi.fn() };
    nativeState.current = {
      coordinator,
    };
    const gate = completionCommitGateFor(coordinator);
    const scheduled = task();
    const mounted = renderHook(() =>
      useAgendaActivityActions(options(agenda(scheduled))),
    );

    act(() => mounted.result.current.toggleComplete(scheduled, true));
    await waitFor(() => expect(gate.isLocked(scheduled)).toBe(false));
    act(() => mounted.result.current.toggleComplete(scheduled, true));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
  });

  it('unlocks when the SQLite projection refresh arrives before the transaction settles', async () => {
    const pending = deferred<{
      kind: 'accepted';
      status: 'queued';
      intent: { intentId: string };
    }>();
    const complete = vi.fn(() => pending.promise);
    const coordinator = { complete, undoCompletion: vi.fn() };
    nativeState.current = { coordinator };
    const gate = completionCommitGateFor(coordinator);
    const scheduled = task();
    const mounted = renderHook(
      ({ data }: { data: AgendaData }) => useAgendaActivityActions(options(data)),
      { initialProps: { data: agenda(scheduled) } },
    );

    act(() => mounted.result.current.toggleComplete(scheduled, true));
    mounted.rerender({ data: agenda(task('completed')) });
    expect(gate.isLocked(scheduled)).toBe(true);

    await act(async () => {
      pending.resolve({
        kind: 'accepted',
        status: 'queued',
        intent: { intentId: 'completion-1' },
      });
      await pending.promise;
    });
    expect(gate.isLocked(scheduled)).toBe(false);
  });
});
