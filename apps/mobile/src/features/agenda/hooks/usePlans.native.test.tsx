import type { WallDate } from '@od/shared/time';
import type { AgendaItem } from '@od/shared/types';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completionCommitGateFor } from '@/features/agenda/completionCommitGate';
import type { NativePlansProjection } from '@/lib/sqlite/plansRepository';
import { usePlans } from './usePlans.native';

const nativeState = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('@/lib/sqlite/nativeState', () => ({
  requireActiveNativeState: () => nativeState.current,
}));

const DATE = '2026-08-10' as WallDate;
const TASK: AgendaItem = {
  activityId: 'act_01J0000000000000000000000A',
  type: 'task',
  title: 'Book venue',
  status: 'scheduled',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: true, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
};

function projection(item: AgendaItem): NativePlansProjection {
  return {
    needsDate: [],
    store: {
      byDate: new Map([[DATE, [item]]]),
      covered: [{ from: DATE, through: DATE }],
    },
    upcomingWindow: { from: DATE, through: DATE, nextFrom: null },
    pastCursor: undefined,
  };
}

describe('native Plans completion reconciliation', () => {
  afterEach(() => {
    nativeState.current = undefined;
    vi.restoreAllMocks();
  });

  it('unlocks a completion after the committed Plans snapshot contains it', async () => {
    const completed = { ...TASK, status: 'completed' as const };
    const coordinator = {};
    nativeState.current = {
      coordinator,
      plans: {
        subscribe: () => () => undefined,
        version: () => 0,
        read: vi.fn().mockResolvedValue(projection(completed)),
        readSnapshot: vi.fn().mockResolvedValue({
          data: projection(completed),
          commitRevision: 5,
        }),
      },
      sync: { pullPlans: () => new Promise<never>(() => undefined) },
    };
    const gate = completionCommitGateFor(coordinator);
    gate.begin(TASK, true, 'complete-task', DATE);
    gate.settle(TASK, true, true, 5);

    const mounted = renderHook(() => usePlans('America/New_York', DATE, '12:00'));
    await waitFor(() => expect(mounted.result.current.status).toBe('success'));

    expect(gate.isLocked(TASK)).toBe(false);
    mounted.unmount();
  });

  it('drops a stale completed override after Activity detail commits a later Undo', async () => {
    const coordinator = {};
    nativeState.current = {
      coordinator,
      plans: {
        subscribe: () => () => undefined,
        version: () => 0,
        read: vi.fn().mockResolvedValue(projection(TASK)),
        readSnapshot: vi.fn().mockResolvedValue({
          data: projection(TASK),
          commitRevision: 6,
        }),
      },
      sync: { pullPlans: () => new Promise<never>(() => undefined) },
    };
    const gate = completionCommitGateFor(coordinator);
    gate.begin(TASK, true, 'completed-on-plans', DATE);
    gate.settle(TASK, true, true, 5);

    const mounted = renderHook(() => usePlans('America/New_York', DATE, '12:00'));
    await waitFor(() => expect(mounted.result.current.status).toBe('success'));

    expect(gate.isLocked(TASK)).toBe(false);
    expect(mounted.result.current.store.byDate.get(DATE)).toEqual([TASK]);
    mounted.unmount();
  });
});
