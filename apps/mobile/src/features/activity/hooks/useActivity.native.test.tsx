import { fixedClock, type Instant } from '@od/shared/time';
import type { ActivityDetail } from '@od/shared/types';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClockProvider } from '@/hooks/useClock';
import { useActivityDetail } from './useActivity.native';

const nativeState = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-mutation-id' }));

vi.mock('@/lib/sqlite/nativeState', () => ({
  requireActiveNativeState: () => nativeState.current,
}));

const ACTIVITY = 'act_01J0000000000000000000000A';
const NOW = '2026-08-19T12:00:00.000Z' as Instant;
const committed: ActivityDetail = {
  activity: {
    activityId: ACTIVITY,
    ownerId: 'usr_01J0000000000000000000000A',
    objectKind: 'task',
    type: 'task',
    status: 'scheduled',
    title: 'New task',
    schedule: {
      date: '2026-08-19',
      time: '13:00',
      timezone: 'America/New_York',
    },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    details: { kind: 'task' },
    icsSequence: 0,
    createdAt: NOW,
    lastActivityAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  },
  reminders: [],
};

const canonical: ActivityDetail = {
  ...committed,
  capabilities: { complete: true, skip: true, snooze: true },
};

function wrapper({ children }: { children: ReactNode }) {
  return <ClockProvider clock={fixedClock(NOW)}>{children}</ClockProvider>;
}

describe('native useActivityDetail', () => {
  afterEach(() => {
    nativeState.current = undefined;
    vi.restoreAllMocks();
  });

  it('hydrates missing server capabilities after a local create is acknowledged', async () => {
    const pullActivity = vi.fn(async () => canonical);
    nativeState.current = {
      activities: {
        subscribe: () => () => undefined,
        version: () => 0,
        read: async () => committed,
        hasCanonicalCapabilities: async () => false,
      },
      outbox: {
        forEntity: async () => [
          {
            mutationKey: ['activity', 'create'],
            status: 'acknowledged',
          },
        ],
      },
      sync: { pullActivity },
      coordinator: {},
    };

    const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });

    await waitFor(() =>
      expect(mounted.result.current.detail?.capabilities?.complete).toBe(true),
    );
    expect(pullActivity).toHaveBeenCalledTimes(1);
    mounted.unmount();
  });

  it('does not probe server capabilities while an offline create is unresolved', async () => {
    const pullActivity = vi.fn(async () => canonical);
    nativeState.current = {
      activities: {
        subscribe: () => () => undefined,
        version: () => 0,
        read: async () => committed,
        hasCanonicalCapabilities: async () => false,
      },
      outbox: {
        forEntity: async () => [
          {
            mutationKey: ['activity', 'create'],
            status: 'queued',
          },
        ],
      },
      sync: { pullActivity },
      coordinator: {},
    };

    const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });

    await waitFor(() => expect(mounted.result.current.status).toBe('success'));
    expect(pullActivity).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it('does not repeat the targeted read once canonical capabilities are installed', async () => {
    const pullActivity = vi.fn(async () => canonical);
    nativeState.current = {
      activities: {
        subscribe: () => () => undefined,
        version: () => 0,
        read: async () => canonical,
        hasCanonicalCapabilities: async () => true,
      },
      outbox: { forEntity: async () => [] },
      sync: { pullActivity },
      coordinator: {},
    };

    const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });

    await waitFor(() => expect(mounted.result.current.status).toBe('success'));
    expect(pullActivity).not.toHaveBeenCalled();
    mounted.unmount();
  });
});
