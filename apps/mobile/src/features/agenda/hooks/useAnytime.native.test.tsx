import type { ActivityListItem, AgendaItem } from '@od/shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completionCommitGateFor,
  completionTargetKey,
} from '@/features/agenda/completionCommitGate';
import type { RepositoryInvalidationMetadata } from '@/lib/sqlite/subscriptions';
import { useAnytime } from './useAnytime.native';

const nativeState = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('@/lib/sqlite/nativeState', () => ({
  requireActiveNativeState: () => nativeState.current,
}));

vi.mock('@/hooks/usePendingIntents', () => ({
  useIsOffline: () => false,
}));

vi.mock('expo-router', async () => {
  const react = await import('react');
  return {
    useFocusEffect: (effect: React.EffectCallback) => react.useEffect(effect, [effect]),
  };
});

const activityId = 'act_01J0000000000000000000000A';
const savedItem: ActivityListItem = {
  activityId,
  type: 'task',
  title: 'Read sometime',
  status: 'saved',
  isRecurring: false,
  participantCount: 0,
};
const savedAgendaItem: AgendaItem = {
  ...savedItem,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: false, snooze: false },
  participantAvatars: [],
  isPast: false,
};

function mount() {
  const client = new QueryClient();
  client.setQueryData(['me'], { timezone: 'UTC' });
  return renderHook(() => useAnytime(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

describe('native Anytime completion reconciliation', () => {
  afterEach(() => {
    nativeState.current = undefined;
    vi.restoreAllMocks();
  });

  it('revision-fences the restored row and unlocks Undo without an Agenda projection', async () => {
    let listener: ((metadata: RepositoryInvalidationMetadata) => void) | undefined;
    const snapshots = [
      { items: [] as readonly ActivityListItem[], commitRevision: 1 },
      { items: [] as readonly ActivityListItem[], commitRevision: 1 },
      { items: [savedItem] as readonly ActivityListItem[], commitRevision: 2 },
    ];
    const readSnapshot = vi.fn(async () => {
      const snapshot = snapshots.shift();
      if (snapshot === undefined) throw new Error('Unexpected Anytime read.');
      return snapshot;
    });
    const coordinator = {};
    const state = {
      coordinator,
      anytime: {
        readSnapshot,
        subscribe: (next: (metadata: RepositoryInvalidationMetadata) => void) => {
          listener = next;
          return () => {
            if (listener === next) listener = undefined;
          };
        },
      },
      sync: { pullAnytime: () => new Promise<never>(() => undefined) },
    };
    nativeState.current = state;
    const gate = completionCommitGateFor(coordinator);

    gate.begin(savedAgendaItem, true, 'complete-anytime', undefined);
    gate.settle(savedAgendaItem, true, true, 1);
    const mounted = mount();
    await waitFor(() => expect(gate.isLocked(savedAgendaItem)).toBe(false));

    act(() => {
      gate.begin(savedAgendaItem, false, 'undo-anytime', undefined);
      gate.settle(savedAgendaItem, false, true, 2);
      listener?.({ scope: 'anytime', commitRevision: 2 });
    });
    expect(gate.snapshotForKey(completionTargetKey(savedAgendaItem))).toBe(
      'committed-unchecked',
    );

    await waitFor(() => expect(readSnapshot).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(gate.isLocked(savedAgendaItem)).toBe(false));
    expect(mounted.result.current.items).toEqual([savedItem]);
    mounted.unmount();
    expect(listener).toBeUndefined();
  });
});
