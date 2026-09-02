import type { AgendaData, AgendaItem } from '@od/shared/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completionCommitGateFor,
  completionTargetKey,
} from '@/features/agenda/completionCommitGate';
import { useToast } from '@/stores/toast';
import { useAgendaActivityActions } from './useAgendaActivityActions.native';
import { useCompletionCommitState } from './useCompletionCommitLock.native';

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
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
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
      commitRevision: number;
    }>();
    const complete = vi.fn(() => pending.promise);
    const coordinator = { complete, undoCompletion: vi.fn() };
    nativeState.current = {
      coordinator,
    };
    const gate = completionCommitGateFor(coordinator);
    const scheduled = task();
    const mounted = renderHook(
      ({ data }: { data: AgendaData }) => ({
        ...useAgendaActivityActions(options(data)),
        completion: useCompletionCommitState(scheduled),
      }),
      { initialProps: { data: agenda(scheduled) } },
    );

    act(() => {
      mounted.result.current.toggleComplete(scheduled, true);
      mounted.result.current.toggleComplete(scheduled, true);
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(gate.isLocked(scheduled)).toBe(true);
    expect(mounted.result.current.completion).toEqual({
      locked: true,
      checkedOverride: true,
    });

    await act(async () => {
      pending.resolve({
        kind: 'accepted',
        status: 'queued',
        intent: { intentId: 'completion-1' },
        commitRevision: 1,
      });
      await pending.promise;
    });
    expect(gate.isLocked(scheduled)).toBe(true);

    mounted.rerender({ data: agenda(task('completed')) });
    act(() => gate.reconcile(agenda(task('completed')), 1));
    await waitFor(() => expect(gate.isLocked(scheduled)).toBe(false));
  });

  it('projects an inverse tap immediately while the first transaction is committing', async () => {
    const pending = deferred<{
      kind: 'accepted';
      status: 'queued';
      intent: { intentId: string };
      commitRevision: number;
    }>();
    const complete = vi.fn(() => pending.promise);
    const undoCompletion = vi.fn(async () => ({
      kind: 'accepted' as const,
      status: 'queued' as const,
      intent: { intentId: 'completion-2' },
      commitRevision: 2,
    }));
    const coordinator = { complete, undoCompletion };
    nativeState.current = { coordinator };
    const gate = completionCommitGateFor(coordinator);
    const scheduled = task();
    const mounted = renderHook(() =>
      useAgendaActivityActions(options(agenda(scheduled))),
    );
    let inverseAccepted = false;

    act(() => {
      mounted.result.current.toggleComplete(scheduled, true);
      inverseAccepted = mounted.result.current.toggleComplete(scheduled, false);
    });

    expect(inverseAccepted).toBe(true);
    expect(gate.snapshotForKey(completionTargetKey(scheduled))).toBe(
      'committing-unchecked',
    );
    await act(async () => {
      pending.resolve({
        kind: 'accepted',
        status: 'queued',
        intent: { intentId: 'completion-1' },
        commitRevision: 1,
      });
      await pending.promise;
    });
    await waitFor(() => expect(undoCompletion).toHaveBeenCalledOnce());
    expect(undoCompletion).toHaveBeenCalledWith(
      'completion-1',
      {
        activityId: scheduled.activityId,
        idempotencyKey: 'completion-2',
        input: {},
      },
      false,
      'scheduled',
      expect.any(Object),
    );
    expect(gate.snapshotForKey(completionTargetKey(scheduled))).toBe(
      'committed-unchecked',
    );
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

  it('rolls the immediate value back when the SQLite promise rejects', async () => {
    const complete = vi.fn(async () => {
      throw new Error('database closed');
    });
    const coordinator = { complete, undoCompletion: vi.fn() };
    nativeState.current = { coordinator };
    const scheduled = task();
    const gate = completionCommitGateFor(coordinator);
    const mounted = renderHook(() =>
      useAgendaActivityActions(options(agenda(scheduled))),
    );

    act(() => mounted.result.current.toggleComplete(scheduled, true));
    expect(gate.snapshotForKey(completionTargetKey(scheduled))).toBe(
      'committing-checked',
    );
    await waitFor(() => expect(gate.isLocked(scheduled)).toBe(false));
  });

  it('assigns undated completion ownership to the Anytime projection', async () => {
    const complete = vi.fn(async () => ({
      kind: 'accepted' as const,
      status: 'queued' as const,
      intent: { intentId: 'anytime-complete' },
      commitRevision: 3,
    }));
    const coordinator = { complete, undoCompletion: vi.fn() };
    nativeState.current = { coordinator };
    const saved = task('saved');
    const gate = completionCommitGateFor(coordinator);
    const mounted = renderHook(() =>
      useAgendaActivityActions({
        today: '2026-08-20',
        currentMinute: '12:00',
        timezone: 'America/New_York',
        completionProjection: 'anytime',
      }),
    );

    act(() => mounted.result.current.toggleComplete(saved, true));
    await waitFor(() =>
      expect(gate.snapshotForKey(completionTargetKey(saved))).toBe('committed-checked'),
    );
    gate.reconcile(agenda(task('completed')), 3);
    expect(gate.isLocked(saved)).toBe(true);
    gate.reconcileAnytime([], 3);
    expect(gate.isLocked(saved)).toBe(false);
  });

  it('settles the old gate without presenting session-stale feedback', async () => {
    const pending = deferred<{
      kind: 'accepted';
      status: 'queued';
      intent: { intentId: string };
      commitRevision: number;
    }>();
    const complete = vi.fn(() => pending.promise);
    const coordinator = { complete, undoCompletion: vi.fn() };
    const oldState = { coordinator };
    nativeState.current = oldState;
    const scheduled = task();
    const gate = completionCommitGateFor(coordinator);
    const mounted = renderHook(() =>
      useAgendaActivityActions(options(agenda(scheduled))),
    );

    act(() => mounted.result.current.toggleComplete(scheduled, true));
    nativeState.current = { coordinator: {} };
    await act(async () => {
      pending.resolve({
        kind: 'accepted',
        status: 'queued',
        intent: { intentId: 'completion-1' },
        commitRevision: 1,
      });
      await pending.promise;
    });

    expect(gate.isLocked(scheduled)).toBe(true);
    expect(useToast.getState().current).toBeUndefined();
  });

  it('finishes the session-owned gate after the initiating row unmounts', async () => {
    const pending = deferred<{
      kind: 'accepted';
      status: 'queued';
      intent: { intentId: string };
      commitRevision: number;
    }>();
    const complete = vi.fn(() => pending.promise);
    const coordinator = { complete, undoCompletion: vi.fn() };
    nativeState.current = { coordinator };
    const scheduled = task();
    const gate = completionCommitGateFor(coordinator);
    const mounted = renderHook(() =>
      useAgendaActivityActions(options(agenda(scheduled))),
    );

    act(() => mounted.result.current.toggleComplete(scheduled, true));
    mounted.unmount();
    await act(async () => {
      pending.resolve({
        kind: 'accepted',
        status: 'queued',
        intent: { intentId: 'completion-1' },
        commitRevision: 4,
      });
      await pending.promise;
    });

    expect(gate.snapshotForKey(completionTargetKey(scheduled))).toBe('committed-checked');
  });

  it('unlocks when the SQLite projection refresh arrives before the transaction settles', async () => {
    const pending = deferred<{
      kind: 'accepted';
      status: 'queued';
      intent: { intentId: string };
      commitRevision: number;
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
    act(() => gate.reconcile(agenda(task('completed')), 1));
    expect(gate.isLocked(scheduled)).toBe(true);

    await act(async () => {
      pending.resolve({
        kind: 'accepted',
        status: 'queued',
        intent: { intentId: 'completion-1' },
        commitRevision: 1,
      });
      await pending.promise;
    });
    expect(gate.isLocked(scheduled)).toBe(false);
  });
});
