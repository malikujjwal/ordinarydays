import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  pendingCreateAllowsOpen,
  useAgendaRowIntentState,
  usePendingCreate,
  usePendingIntents,
} from './usePendingIntents.native';

const nativeState = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('@/lib/sqlite/nativeState', () => ({
  requireActiveNativeState: () => nativeState.current,
}));

describe('native pending intent selectors', () => {
  afterEach(() => {
    nativeState.current = undefined;
    vi.restoreAllMocks();
  });

  it('shares one SQLite outbox snapshot across every selector for a committed version', async () => {
    let version = 0;
    const listeners = new Set<() => void>();
    const all = vi.fn(async () => []);
    const forEntity = vi.fn(async () => []);
    nativeState.current = {
      account: {
        subscriptions: {
          subscribe: (_scope: string, listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          version: () => version,
        },
      },
      outbox: { all, forEntity },
      coordinator: { ownerUserId: 'usr_01J0000000000000000000000A' },
    };

    const mounted = renderHook(() => ({
      first: usePendingCreate('act_01J0000000000000000000000A'),
      second: usePendingCreate('act_01J0000000000000000000000B'),
      all: usePendingIntents(),
    }));

    await waitFor(() => expect(all).toHaveBeenCalledTimes(1));
    expect(forEntity).not.toHaveBeenCalled();

    act(() => {
      version += 1;
      for (const listener of listeners) listener();
    });
    await waitFor(() => expect(all).toHaveBeenCalledTimes(2));
    expect(forEntity).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it('derives both agenda-row gates from one entity subscription', async () => {
    const listeners = new Set<() => void>();
    const all = vi.fn(async () => [
      {
        intentId: 'intent-create',
        mutationKey: ['activity', 'create'],
        variables: {},
        entityId: 'act_01J0000000000000000000000A',
        orderingKey: 'activity:act_01J0000000000000000000000A',
        status: 'queued',
        createdAt: 1_787_097_600_000,
        seq: 1,
        attempts: 0,
      },
    ]);
    nativeState.current = {
      account: {
        subscriptions: {
          subscribe: (_scope: string, listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          version: () => 0,
        },
      },
      outbox: { all },
      coordinator: { ownerUserId: 'usr_01J0000000000000000000000A' },
    };

    const mounted = renderHook(() =>
      useAgendaRowIntentState('act_01J0000000000000000000000A'),
    );

    await waitFor(() => expect(mounted.result.current.pendingCreate.pending).toBe(true));
    expect(mounted.result.current.mutationInert).toBe(true);
    expect(mounted.result.current.recurrenceEdit.status).toBe('idle');
    expect(pendingCreateAllowsOpen).toBe(true);
    expect(all).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(1);
    mounted.unmount();
  });
});
