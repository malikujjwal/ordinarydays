import { ApiError, NetworkError } from '@od/shared/client';
import { fixedClock, type Instant } from '@od/shared/time';
import type { ActivityDetail } from '@od/shared/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClockProvider } from '@/hooks/useClock';
import { CanonicalActivityInstallDeferredError } from '@/lib/sqlite/syncEngine';
import { useActivityDetail } from './useActivity.native';

const nativeState = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-mutation-id' }));

vi.mock('@/lib/sqlite/nativeState', () => ({
  getActiveNativeState: () => nativeState.current,
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('hydrates missing server capabilities after a local create is acknowledged', async () => {
    let installed = false;
    const pullActivity = vi.fn(async () => {
      installed = true;
      return canonical;
    });
    nativeState.current = {
      activities: {
        subscribe: () => () => undefined,
        version: () => 0,
        read: async () => (installed ? canonical : committed),
        hasInstalledCapabilities: async () => installed,
        capabilityHydrationState: async () => (installed ? 'installed' : 'missing'),
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
        hasInstalledCapabilities: async () => false,
        capabilityHydrationState: async () => 'deferred',
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
        hasInstalledCapabilities: async () => true,
        capabilityHydrationState: async () => 'installed',
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

  it.each([
    {
      label: 'Task',
      detail: {
        ...canonical,
        activity: {
          ...canonical.activity,
          recurrence: {
            mode: 'fixed' as const,
            segments: [
              {
                freq: 'daily' as const,
                interval: 1,
                effectiveFrom: '2026-08-19',
              },
            ],
          },
        },
      },
    },
    {
      label: 'Plan',
      detail: {
        ...canonical,
        activity: {
          ...canonical.activity,
          objectKind: 'plan' as const,
          type: 'event' as const,
          details: { kind: 'event' as const },
          recurrence: {
            mode: 'fixed' as const,
            segments: [
              {
                freq: 'weekly' as const,
                interval: 1,
                effectiveFrom: '2026-08-19',
              },
            ],
          },
        },
      },
    },
  ])(
    'keeps a recurring $label capability projection during local reconciliation',
    async ({ detail }) => {
      const pullActivity = vi.fn(async () => detail);
      nativeState.current = {
        activities: {
          subscribe: () => () => undefined,
          version: () => 0,
          read: async () => detail,
          hasInstalledCapabilities: async () => true,
          capabilityHydrationState: async () => 'installed',
        },
        outbox: { forEntity: async () => [] },
        sync: { pullActivity },
        coordinator: {},
      };

      const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });

      await waitFor(() => expect(mounted.result.current.status).toBe('success'));
      expect(mounted.result.current.detail?.capabilities?.complete).toBe(true);
      expect(mounted.result.current.editError).toBeUndefined();
      expect(pullActivity).not.toHaveBeenCalled();
      mounted.unmount();
    },
  );

  it('defers missing capability hydration until protected local work settles', async () => {
    let listener: (() => void) | undefined;
    let version = 0;
    let hydrationState: 'deferred' | 'missing' | 'installed' = 'deferred';
    const pullActivity = vi.fn(async () => {
      hydrationState = 'installed';
      return canonical;
    });
    nativeState.current = {
      activities: {
        subscribe: (_activityId: string, next: () => void) => {
          listener = next;
          return () => undefined;
        },
        version: () => version,
        read: async () => (hydrationState === 'installed' ? canonical : committed),
        hasInstalledCapabilities: async () => hydrationState === 'installed',
        capabilityHydrationState: async () => hydrationState,
      },
      outbox: { forEntity: async () => [] },
      sync: { pullActivity },
      coordinator: {},
    };

    const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });
    await waitFor(() => expect(mounted.result.current.status).toBe('success'));
    expect(pullActivity).not.toHaveBeenCalled();

    await act(async () => {
      hydrationState = 'missing';
      version += 1;
      listener?.();
    });

    await waitFor(() => expect(pullActivity).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(mounted.result.current.detail?.capabilities?.complete).toBe(true),
    );
    mounted.unmount();
  });

  it('retains committed detail without surfacing a refused background install as edit error', async () => {
    const pullActivity = vi.fn(async () => {
      throw new CanonicalActivityInstallDeferredError(ACTIVITY);
    });
    nativeState.current = {
      activities: {
        subscribe: () => () => undefined,
        version: () => 0,
        read: async () => committed,
        hasInstalledCapabilities: async () => false,
        capabilityHydrationState: async () => 'missing',
      },
      outbox: { forEntity: async () => [] },
      sync: { pullActivity },
      coordinator: {},
    };

    const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });
    await waitFor(() => expect(pullActivity).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mounted.result.current.status).toBe('success'));

    expect(mounted.result.current.detail?.activity.activityId).toBe(ACTIVITY);
    expect(mounted.result.current.editError).toBeUndefined();
    expect(mounted.result.current.message).toBeUndefined();
    mounted.unmount();
  });

  it('keeps an explicit edit refusal visible', async () => {
    nativeState.current = {
      activities: {
        subscribe: () => () => undefined,
        version: () => 0,
        read: async () => canonical,
        hasInstalledCapabilities: async () => true,
        capabilityHydrationState: async () => 'installed',
      },
      outbox: { forEntity: async () => [] },
      sync: { pullActivity: vi.fn(async () => canonical) },
      coordinator: {
        patch: vi.fn(async () => ({
          kind: 'refused',
          error: new Error('The recurrence edit was rejected.'),
        })),
      },
    };

    const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });
    await waitFor(() => expect(mounted.result.current.detail).toBeDefined());
    await act(async () => {
      expect(await mounted.result.current.patch({ title: 'Edited title' })).toBe(false);
    });

    expect(mounted.result.current.editError).toBe('The recurrence edit was rejected.');
    mounted.unmount();
  });

  it('does not clear an explicit edit error when background hydration later succeeds', async () => {
    let installed = false;
    let release: ((detail: ActivityDetail) => void) | undefined;
    const pending = new Promise<ActivityDetail>((resolve) => {
      release = resolve;
    });
    nativeState.current = {
      activities: {
        subscribe: () => () => undefined,
        version: () => 0,
        read: async () => (installed ? canonical : committed),
        hasInstalledCapabilities: async () => installed,
        capabilityHydrationState: async () => (installed ? 'installed' : 'missing'),
      },
      outbox: { forEntity: async () => [] },
      sync: {
        pullActivity: vi.fn(async () => {
          const result = await pending;
          installed = true;
          return result;
        }),
      },
      coordinator: {
        patch: vi.fn(async () => ({
          kind: 'refused',
          error: new Error('The title edit was rejected.'),
        })),
      },
    };

    const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });
    await waitFor(() => expect(mounted.result.current.detail).toBeDefined());
    await act(async () => {
      await mounted.result.current.patch({ title: 'Edited title' });
    });
    expect(mounted.result.current.editError).toBe('The title edit was rejected.');

    await act(async () => {
      release?.(canonical);
      await pending;
    });
    await waitFor(() =>
      expect(mounted.result.current.detail?.capabilities?.complete).toBe(true),
    );
    expect(mounted.result.current.editError).toBe('The title edit was rejected.');
    mounted.unmount();
  });

  it('retries a failed capability hydration and records success only after installation', async () => {
    let installed = false;
    let activePulls = 0;
    let maxActivePulls = 0;
    let pullCount = 0;
    const pullActivity = vi.fn<() => Promise<ActivityDetail>>(async () => {
      activePulls += 1;
      maxActivePulls = Math.max(maxActivePulls, activePulls);
      pullCount += 1;
      try {
        if (pullCount === 1) {
          throw new NetworkError('detail not ready', new Error('offline'));
        }
        installed = true;
        return canonical;
      } finally {
        activePulls -= 1;
      }
    });
    nativeState.current = {
      activities: {
        subscribe: () => () => undefined,
        version: () => 0,
        read: async () => (installed ? canonical : committed),
        hasInstalledCapabilities: async () => installed,
        capabilityHydrationState: async () => (installed ? 'installed' : 'missing'),
      },
      outbox: { forEntity: async () => [] },
      sync: { pullActivity },
      coordinator: {},
    };

    const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });

    await waitFor(() => expect(pullActivity).toHaveBeenCalledTimes(2), {
      timeout: 2_000,
    });
    await waitFor(() =>
      expect(mounted.result.current.detail?.capabilities?.complete).toBe(true),
    );
    expect(maxActivePulls).toBe(1);
    mounted.unmount();
  });

  it('settles a permanent hydration failure without scheduling another pull', async () => {
    vi.useFakeTimers();
    let observedAttempt: (() => void) | undefined;
    const attempted = new Promise<void>((resolve) => {
      observedAttempt = resolve;
    });
    const pullActivity = vi.fn(async () => {
      observedAttempt?.();
      throw new ApiError('forbidden', 'You no longer have access.', 403, 'req_denied');
    });
    nativeState.current = {
      activities: {
        subscribe: () => () => undefined,
        version: () => 0,
        read: async () => committed,
        hasInstalledCapabilities: async () => false,
        capabilityHydrationState: async () => 'missing',
      },
      outbox: { forEntity: async () => [] },
      sync: { pullActivity },
      coordinator: {},
    };

    const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });
    await act(async () => {
      await attempted;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pullActivity).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(pullActivity).toHaveBeenCalledTimes(1);
    expect(mounted.result.current.status).toBe('success');
    expect(mounted.result.current.editError).toBeUndefined();
    mounted.unmount();
  });

  it('retries when an installed canonical detail still omits capabilities', async () => {
    let installed = false;
    const pullActivity = vi
      .fn<() => Promise<ActivityDetail>>()
      .mockResolvedValueOnce(committed)
      .mockImplementationOnce(async () => {
        installed = true;
        return canonical;
      });
    nativeState.current = {
      activities: {
        subscribe: () => () => undefined,
        version: () => 0,
        read: async () => (installed ? canonical : committed),
        hasInstalledCapabilities: async () => installed,
        capabilityHydrationState: async () => (installed ? 'installed' : 'missing'),
      },
      outbox: { forEntity: async () => [] },
      sync: { pullActivity },
      coordinator: {},
    };

    const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });

    await waitFor(() => expect(pullActivity).toHaveBeenCalledTimes(2), {
      timeout: 2_000,
    });
    await waitFor(() =>
      expect(mounted.result.current.detail?.capabilities?.complete).toBe(true),
    );
    mounted.unmount();
  });

  it('does not let an older asynchronous detail pull overwrite a newer projection', async () => {
    let listener: (() => void) | undefined;
    let version = 0;
    let readCount = 0;
    let releaseOlder: ((detail: ActivityDetail) => void) | undefined;
    const olderPull = new Promise<ActivityDetail>((resolve) => {
      releaseOlder = resolve;
    });
    const newer = {
      ...canonical,
      activity: {
        ...canonical.activity,
        title: 'Newer canonical detail',
        updatedAt: '2026-08-19T13:00:00.000Z' as Instant,
      },
    };
    nativeState.current = {
      activities: {
        subscribe: (_activityId: string, next: () => void) => {
          listener = next;
          return () => undefined;
        },
        version: () => version,
        read: async () => {
          readCount += 1;
          return readCount === 1 ? committed : newer;
        },
        hasInstalledCapabilities: async () => readCount > 1,
        capabilityHydrationState: async () => (readCount > 1 ? 'installed' : 'missing'),
      },
      outbox: { forEntity: async () => [] },
      sync: { pullActivity: () => olderPull },
      coordinator: {},
    };

    const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });
    await waitFor(() => expect(readCount).toBe(1));
    await act(async () => {
      version += 1;
      listener?.();
    });
    await waitFor(() =>
      expect(mounted.result.current.detail?.activity.title).toBe(
        'Newer canonical detail',
      ),
    );

    await act(async () => {
      releaseOlder?.(canonical);
      await olderPull;
    });
    expect(mounted.result.current.detail?.activity.title).toBe('Newer canonical detail');
    mounted.unmount();
  });

  it('does not apply a detail response after the native session changes', async () => {
    let release: ((detail: ActivityDetail) => void) | undefined;
    const pending = new Promise<ActivityDetail>((resolve) => {
      release = resolve;
    });
    const pullActivity = vi.fn(() => pending);
    const originalState = {
      sessionId: 'old-session',
      activities: {
        subscribe: () => () => undefined,
        version: () => 0,
        read: async () => committed,
        hasInstalledCapabilities: async () => false,
        capabilityHydrationState: async () => 'missing',
      },
      outbox: { forEntity: async () => [] },
      sync: { pullActivity },
      coordinator: {},
    };
    nativeState.current = originalState;
    const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });
    await waitFor(() => expect(pullActivity).toHaveBeenCalledTimes(1));

    nativeState.current = { ...originalState, sessionId: 'new-session' };
    await act(async () => {
      release?.(canonical);
      await pending;
    });

    expect(mounted.result.current.detail?.capabilities).toBeUndefined();
    mounted.unmount();
  });
});
