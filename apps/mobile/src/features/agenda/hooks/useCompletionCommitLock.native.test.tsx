import type { AgendaData, AgendaItem } from '@od/shared/types';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completionCommitGateFor } from '@/features/agenda/completionCommitGate';
import {
  useCompletionCommitLock,
  useCompletionCommitState,
} from './useCompletionCommitLock.native';

const nativeState = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('@/lib/sqlite/nativeState', () => ({
  requireActiveNativeState: () => nativeState.current,
}));

const task: AgendaItem = {
  activityId: 'act_lock_subscription',
  type: 'task',
  title: 'Call the dentist',
  status: 'scheduled',
  time: '18:15',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: false, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
};

const completed: AgendaData = {
  days: [
    {
      date: '2026-08-20',
      schedule: [{ ...task, status: 'completed' }],
      anytime: [],
      earlier: [],
    },
  ],
  warnings: [],
};

afterEach(() => {
  nativeState.current = undefined;
});

describe('native completion lock subscription', () => {
  it('updates the target row when its local commit locks and reconciles', () => {
    const coordinator = {};
    nativeState.current = { coordinator };
    const gate = completionCommitGateFor(coordinator);
    const mounted = renderHook(() => useCompletionCommitLock(task));
    expect(mounted.result.current).toBe(false);

    act(() => {
      gate.begin(task, true, undefined, '2026-08-20');
    });
    expect(mounted.result.current).toBe(true);

    act(() => {
      gate.settle(task, true, true, 1);
      gate.reconcile(completed, 1);
    });
    expect(mounted.result.current).toBe(false);
  });

  it('exposes the requested value immediately, then retains it through projection', () => {
    const coordinator = {};
    nativeState.current = { coordinator };
    const gate = completionCommitGateFor(coordinator);
    const mounted = renderHook(() => useCompletionCommitState(task));
    expect(mounted.result.current).toEqual({
      locked: false,
      checkedOverride: undefined,
    });

    act(() => {
      gate.begin(task, true, undefined, '2026-08-20');
    });
    expect(mounted.result.current).toEqual({
      locked: true,
      checkedOverride: true,
    });

    act(() => {
      gate.settle(task, true, true, 1);
    });
    expect(mounted.result.current).toEqual({ locked: true, checkedOverride: true });

    act(() => {
      gate.reconcile(completed, 1);
    });
    expect(mounted.result.current).toEqual({
      locked: false,
      checkedOverride: undefined,
    });
  });

  it('shows an uncompletion immediately and restores the committed check on refusal', () => {
    const coordinator = {};
    nativeState.current = { coordinator };
    const completedTask = { ...task, status: 'completed' as const };
    const gate = completionCommitGateFor(coordinator);
    const mounted = renderHook(() => useCompletionCommitState(completedTask));

    act(() => {
      gate.begin(completedTask, false, 'inverse', '2026-08-20');
    });
    expect(mounted.result.current).toEqual({
      locked: true,
      checkedOverride: false,
    });

    act(() => {
      gate.settle(completedTask, false, false);
    });
    expect(mounted.result.current).toEqual({
      locked: false,
      checkedOverride: undefined,
    });
  });
});
