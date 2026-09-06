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
        hasInstalledDetail: async () => installed,
        detailHydrationState: async () => (installed ? 'installed' : 'missing'),
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
        hasInstalledDetail: async () => false,
        detailHydrationState: async () => 'deferred',
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

  it('revalidates an installed detail on entry and removes an authoritative deleted Plan', async () => {
    let deleted = false;
    const pullActivity = vi.fn(async () => {
      deleted = true;
      throw new ApiError('not_found', 'Activity not found.', 404, 'req_deleted');
    });
    nativeState.current = {
      activities: {
        subscribe: () => () => undefined,
        version: () => 0,
        read: async () => (deleted ? undefined : canonical),
        hasInstalledDetail: async () => true,
        detailHydrationState: async () => 'installed',
      },
      outbox: { forEntity: async () => [] },
      sync: { pullActivity },
      coordinator: {},
    };

    const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });

    await waitFor(() => expect(mounted.result.current.status).toBe('error'));
    expect(mounted.result.current.detail).toBeUndefined();
    expect(pullActivity).toHaveBeenCalledTimes(1);
    mounted.unmount();
  });

  it('clears cached detail when a 404 publishes deletion during entry revalidation', async () => {
    let deleted = false;
    let version = 0;
    let listener: (() => void) | undefined;
    let reject!: (error: Error) => void;
    const response = new Promise<ActivityDetail>((_resolve, onReject) => {
      reject = onReject;
    });
    const pullActivity = vi.fn(() => response);
    nativeState.current = {
      activities: {
        subscribe: (_activityId: string, callback: () => void) => {
          listener = callback;
          return () => undefined;
        },
        version: () => version,
        read: async () => (deleted ? undefined : canonical),
        hasInstalledDetail: async () => !deleted,
        detailHydrationState: async () => (deleted ? 'missing' : 'installed'),
      },
      sync: { pullActivity },
      coordinator: {},
    };
    const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });
    await waitFor(() => expect(pullActivity).toHaveBeenCalledTimes(1));
    await act(async () => {
      deleted = true;
      version += 1;
      listener?.();
    });
    await act(async () => {
      reject(new ApiError('not_found', 'Activity not found.', 404, 'req_gone'));
    });
    await waitFor(() => expect(mounted.result.current.status).toBe('error'));
    expect(mounted.result.current.detail).toBeUndefined();
    mounted.unmount();
  });

  it('revalidates installed detail once on entry without repeating on render', async () => {
    const pullActivity = vi.fn(async () => canonical);
    nativeState.current = {
      activities: {
        subscribe: () => () => undefined,
        version: () => 0,
        read: async () => canonical,
        hasInstalledDetail: async () => true,
        detailHydrationState: async () => 'installed',
      },
      outbox: { forEntity: async () => [] },
      sync: { pullActivity },
      coordinator: {},
    };

    const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });

    await waitFor(() => expect(mounted.result.current.status).toBe('success'));
    await waitFor(() => expect(pullActivity).toHaveBeenCalledTimes(1));
    mounted.rerender();
    expect(pullActivity).toHaveBeenCalledTimes(1);
    mounted.unmount();
  });

  it('hydrates and exposes attachments when an existing Plan predates their projection', async () => {
    const attachment = {
      attachmentId: 'att_01J0000000000000000000000A',
      activityId: ACTIVITY,
      key: 'u/usr_01J0000000000000000000000A/photo.jpg',
      contentType: 'image/jpeg' as const,
      byteSize: 1024,
      createdAt: NOW,
      schemaVersion: 1 as const,
    };
    const cachedPlan: ActivityDetail = {
      ...canonical,
      activity: {
        ...canonical.activity,
        objectKind: 'plan',
        type: 'custom',
        details: { kind: 'custom' },
      },
    };
    const hydratedPlan: ActivityDetail = {
      ...cachedPlan,
      attachments: [attachment],
    };
    let installed = false;
    const pullActivity = vi.fn(async () => {
      installed = true;
      return hydratedPlan;
    });
    nativeState.current = {
      activities: {
        subscribe: () => () => undefined,
        version: () => 0,
        read: async () => (installed ? hydratedPlan : cachedPlan),
        hasInstalledDetail: async () => installed,
        detailHydrationState: async () => (installed ? 'installed' : 'missing'),
      },
      outbox: { forEntity: async () => [] },
      sync: { pullActivity },
      coordinator: {},
    };

    const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });

    await waitFor(() =>
      expect(mounted.result.current.detail?.attachments).toEqual([attachment]),
    );
    expect(pullActivity).toHaveBeenCalledTimes(1);
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
          hasInstalledDetail: async () => true,
          detailHydrationState: async () => 'installed',
        },
        outbox: { forEntity: async () => [] },
        sync: { pullActivity },
        coordinator: {},
      };

      const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });

      await waitFor(() => expect(mounted.result.current.status).toBe('success'));
      expect(mounted.result.current.detail?.capabilities?.complete).toBe(true);
      expect(mounted.result.current.editError).toBeUndefined();
      expect(pullActivity).toHaveBeenCalledTimes(1);
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
        hasInstalledDetail: async () => hydrationState === 'installed',
        detailHydrationState: async () => hydrationState,
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
        hasInstalledDetail: async () => false,
        detailHydrationState: async () => 'missing',
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
        hasInstalledDetail: async () => true,
        detailHydrationState: async () => 'installed',
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

  it('shows a clean validation message without enqueueing an invalid recurrence patch', async () => {
    const patch = vi.fn();
    nativeState.current = {
      activities: {
        subscribe: () => () => undefined,
        version: () => 0,
        read: async () => canonical,
        hasInstalledDetail: async () => true,
        detailHydrationState: async () => 'installed',
      },
      outbox: { forEntity: async () => [] },
      sync: { pullActivity: vi.fn(async () => canonical) },
      coordinator: { patch },
    };

    const mounted = renderHook(() => useActivityDetail(ACTIVITY), { wrapper });
    await waitFor(() => expect(mounted.result.current.detail).toBeDefined());
    await act(async () => {
      expect(
        await mounted.result.current.patch({
          recurrence: {
            mode: 'fixed',
            segments: [
              { freq: 'daily', effectiveFrom: '2026-08-21', time: '09:00' },
              { freq: 'daily', effectiveFrom: '2026-08-21', time: '10:30' },
            ],
          },
          editedFromDate: '2026-08-21',
        }),
      ).toBe(false);
    });

    expect(patch).not.toHaveBeenCalled();
    expect(mounted.result.current.editError).toBe(
      'Recurrence segments must be ordered by effectiveFrom, strictly ascending.',
    );
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
        hasInstalledDetail: async () => installed,
        detailHydrationState: async () => (installed ? 'installed' : 'missing'),
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

  it.each([false, true])(
    'retries a failed detail hydration (installed=%s)',
    async (initiallyInstalled) => {
      let installed = initiallyInstalled;
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
          hasInstalledDetail: async () => installed,
          detailHydrationState: async () => (installed ? 'installed' : 'missing'),
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
    },
  );

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
        hasInstalledDetail: async () => false,
        detailHydrationState: async () => 'missing',
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
        hasInstalledDetail: async () => installed,
        detailHydrationState: async () => (installed ? 'installed' : 'missing'),
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
        hasInstalledDetail: async () => readCount > 1,
        detailHydrationState: async () => (readCount > 1 ? 'installed' : 'missing'),
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
        hasInstalledDetail: async () => false,
        detailHydrationState: async () => 'missing',
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
