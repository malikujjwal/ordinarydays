import { fixedClock, type Instant } from '@od/shared/time';
import type { AgendaData } from '@od/shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClockProvider } from '@/hooks/useClock';
import { useAgenda } from './useAgenda.native';

const nativeState = vi.hoisted(() => ({ current: undefined as unknown }));
const focusState = vi.hoisted(() => {
  const state = {
    cleanup: undefined as (() => void) | undefined,
    focused: true,
    navigation: undefined as unknown as { isFocused: () => boolean },
  };
  state.navigation = { isFocused: () => state.focused };
  return state;
});

vi.mock('@/lib/sqlite/nativeState', () => ({
  requireActiveNativeState: () => nativeState.current,
}));

vi.mock('expo-router', async () => {
  const react = await import('react');
  return {
    useNavigation: () => focusState.navigation,
    useFocusEffect: (effect: React.EffectCallback) =>
      react.useEffect(() => {
        const cleanup = effect();
        focusState.cleanup = cleanup ?? undefined;
        return () => {
          if (focusState.cleanup === cleanup) focusState.cleanup = undefined;
          cleanup?.();
        };
      }, [effect]),
  };
});

const NOW = '2026-08-19T12:00:00.000Z' as Instant;

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('native useAgenda', () => {
  afterEach(() => {
    vi.useRealTimers();
    nativeState.current = undefined;
    focusState.cleanup = undefined;
    focusState.focused = true;
    vi.restoreAllMocks();
  });

  it('re-reads committed SQLite after a mixed sync failure instead of restoring a stale error', async () => {
    let covered = false;
    const installed: AgendaData = {
      days: [
        {
          date: '2026-08-19',
          schedule: [],
          anytime: [],
          earlier: [],
        },
        {
          date: '2026-08-20',
          schedule: [],
          anytime: [],
          earlier: [],
        },
      ],
      warnings: [],
    };
    const empty: AgendaData = { days: [], warnings: [] };
    const pullAgenda = vi.fn(async () => {
      // This requested coverage installed, but another known coverage failed the cycle.
      covered = true;
      throw new Error('another coverage failed');
    });
    const recordSyncError = vi.fn(async () => undefined);
    nativeState.current = {
      agenda: {
        subscribe: () => () => undefined,
        version: () => 0,
        scope: () => 'agenda:test',
        read: async () => (covered ? installed : empty),
        hasCoverage: async () => covered,
        recordSyncError,
      },
      sync: { pullAgenda },
      account: {
        transactions: {
          run: async (operation: (transaction: never) => Promise<void>) =>
            operation(undefined as never),
        },
      },
    };
    const client = new QueryClient();
    client.setQueryData(['me'], { timezone: 'UTC' });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ClockProvider clock={fixedClock(NOW)}>{children}</ClockProvider>
      </QueryClientProvider>
    );

    const mounted = renderHook(() => useAgenda({ now: NOW }), { wrapper });

    await waitFor(() => expect(mounted.result.current.status).toBe('success'));
    expect(mounted.result.current.data).toEqual(installed);
    expect(mounted.result.current.error).toMatchObject({
      message: 'another coverage failed',
    });
    expect(pullAgenda).toHaveBeenCalledTimes(1);
    expect(recordSyncError).toHaveBeenCalledTimes(1);
    mounted.unmount();
    client.clear();
  });

  it('uses the same visible-state include domain for a multi-day Plans window', async () => {
    const pullAgenda = vi.fn(async () => ({ days: [], warnings: [] }));
    nativeState.current = {
      agenda: {
        subscribe: () => () => undefined,
        scope: () => 'agenda:plans',
        read: async () => ({ days: [], warnings: [] }),
        hasCoverage: async () => false,
        recordSyncError: async () => undefined,
      },
      sync: { pullAgenda },
      account: {
        transactions: {
          run: async (operation: (transaction: never) => Promise<void>) =>
            operation(undefined as never),
        },
      },
    };
    const client = new QueryClient();
    client.setQueryData(['me'], { timezone: 'UTC' });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ClockProvider clock={fixedClock(NOW)}>{children}</ClockProvider>
      </QueryClientProvider>
    );

    const mounted = renderHook(() => useAgenda({ days: 62, now: NOW }), { wrapper });

    await waitFor(() => expect(pullAgenda).toHaveBeenCalledTimes(1));
    expect(pullAgenda).toHaveBeenCalledWith({
      from: '2026-08-19',
      to: '2026-10-19',
      tz: 'UTC',
      include: 'anytime_unscheduled,overdue',
    });
    mounted.unmount();
    client.clear();
  });

  it('stops native Agenda reads when its tab loses focus', async () => {
    let listener: (() => void) | undefined;
    const stopAgenda = vi.fn();
    const read = vi.fn(async () => ({ days: [], warnings: [] }));
    nativeState.current = {
      agenda: {
        subscribe: (_coverage: unknown, next: () => void) => {
          listener = next;
          return stopAgenda;
        },
        scope: () => 'agenda:focused',
        read,
        hasCoverage: async () => true,
        recordSyncError: async () => undefined,
      },
      sync: { pullAgenda: vi.fn() },
      account: {
        transactions: {
          run: async (operation: (transaction: never) => Promise<void>) =>
            operation(undefined as never),
        },
      },
    };
    const client = new QueryClient();
    client.setQueryData(['me'], { timezone: 'UTC' });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ClockProvider clock={fixedClock(NOW)}>{children}</ClockProvider>
      </QueryClientProvider>
    );
    const mounted = renderHook(() => useAgenda({ now: NOW }), { wrapper });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    focusState.cleanup?.();
    expect(stopAgenda).toHaveBeenCalledTimes(1);
    listener?.();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);

    mounted.unmount();
    client.clear();
  });

  it('keeps a retained listener inert when a frozen tab loses focus before cleanup', async () => {
    let listener: (() => void) | undefined;
    const read = vi.fn(async () => ({ days: [], warnings: [] }));
    nativeState.current = {
      agenda: {
        subscribe: (_coverage: unknown, next: () => void) => {
          listener = next;
          return () => undefined;
        },
        scope: () => 'agenda:frozen-tab',
        read,
        hasCoverage: async () => true,
        recordSyncError: async () => undefined,
      },
      sync: { pullAgenda: vi.fn() },
      account: {
        transactions: {
          run: async (operation: (transaction: never) => Promise<void>) =>
            operation(undefined as never),
        },
      },
    };
    const client = new QueryClient();
    client.setQueryData(['me'], { timezone: 'UTC' });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ClockProvider clock={fixedClock(NOW)}>{children}</ClockProvider>
      </QueryClientProvider>
    );
    const mounted = renderHook(() => useAgenda({ now: NOW }), { wrapper });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    focusState.focused = false;
    listener?.();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);

    mounted.unmount();
    client.clear();
  });

  it('reconciles a Plans local write by day while an immediate correction stays full-window', async () => {
    type Invalidation =
      | { readonly kind: 'immediate' }
      | { readonly kind: 'local-day'; readonly date: string };
    let listener: ((invalidation?: Invalidation) => void) | undefined;
    const unchangedDay = {
      date: '2026-08-20',
      schedule: [],
      anytime: [],
      earlier: [],
    };
    const initial: AgendaData = {
      days: [
        { date: '2026-08-19', schedule: [], anytime: [], earlier: [] },
        unchangedDay,
      ],
      warnings: ['duplicate_occurrence:preserved'],
      projectionVersions: [{ activityId: 'act_1', version: 'v1' }],
    };
    const refreshedDay = {
      date: '2026-08-19',
      schedule: [],
      anytime: [],
      earlier: [],
    };
    const read = vi.fn(async () => initial);
    const readDays = vi.fn(async () => [refreshedDay]);
    nativeState.current = {
      agenda: {
        subscribe: (_coverage: unknown, next: (invalidation?: Invalidation) => void) => {
          listener = next;
          return () => undefined;
        },
        scope: () => 'agenda:incremental-plans',
        read,
        readDays,
        hasCoverage: async () => true,
        recordSyncError: async () => undefined,
      },
      sync: { pullAgenda: vi.fn() },
      account: {
        transactions: {
          run: async (operation: (transaction: never) => Promise<void>) =>
            operation(undefined as never),
        },
      },
    };
    const client = new QueryClient();
    client.setQueryData(['me'], { timezone: 'UTC' });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ClockProvider clock={fixedClock(NOW)}>{children}</ClockProvider>
      </QueryClientProvider>
    );
    const mounted = renderHook(
      () =>
        useAgenda({
          days: 62,
          now: NOW,
          incrementalLocalTargetReconciliation: true,
        }),
      { wrapper },
    );
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    act(() => listener?.({ kind: 'local-day', date: '2026-08-19' }));
    await waitFor(() => expect(readDays).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mounted.result.current.data?.days[0]).toBe(refreshedDay));
    expect(readDays).toHaveBeenCalledWith(expect.any(Object), ['2026-08-19']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(mounted.result.current.data?.days[1]).toBe(unchangedDay);
    expect(mounted.result.current.data?.warnings).toEqual([
      'duplicate_occurrence:preserved',
    ]);
    expect(mounted.result.current.data?.projectionVersions).toEqual([
      { activityId: 'act_1', version: 'v1' },
    ]);

    act(() => listener?.({ kind: 'immediate' }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(readDays).toHaveBeenCalledTimes(1);

    mounted.unmount();
    client.clear();
  });

  it('does not let an older local-day read overwrite a server correction', async () => {
    type Invalidation =
      | { readonly kind: 'immediate' }
      | { readonly kind: 'local-day'; readonly date: string };
    let listener: ((invalidation: Invalidation) => void) | undefined;
    const staleLocalDays = deferred<AgendaData['days']>();
    const initial: AgendaData = {
      days: [{ date: '2026-08-19', schedule: [], anytime: [], earlier: [] }],
      warnings: ['duplicate_occurrence:initial'],
    };
    const corrected: AgendaData = {
      days: [{ date: '2026-08-19', schedule: [], anytime: [], earlier: [] }],
      warnings: ['duplicate_occurrence:server-corrected'],
    };
    const read = vi
      .fn<() => Promise<AgendaData>>()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(corrected);
    nativeState.current = {
      agenda: {
        subscribe: (_coverage: unknown, next: (invalidation: Invalidation) => void) => {
          listener = next;
          return () => undefined;
        },
        scope: () => 'agenda:server-correction-race',
        read,
        readDays: vi.fn(() => staleLocalDays.promise),
        hasCoverage: async () => true,
        recordSyncError: async () => undefined,
      },
      sync: { pullAgenda: vi.fn() },
      account: {
        transactions: {
          run: async (operation: (transaction: never) => Promise<void>) =>
            operation(undefined as never),
        },
      },
    };
    const client = new QueryClient();
    client.setQueryData(['me'], { timezone: 'UTC' });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ClockProvider clock={fixedClock(NOW)}>{children}</ClockProvider>
      </QueryClientProvider>
    );
    const mounted = renderHook(
      () =>
        useAgenda({
          days: 62,
          now: NOW,
          incrementalLocalTargetReconciliation: true,
        }),
      { wrapper },
    );
    await waitFor(() => expect(mounted.result.current.data).toBe(initial));

    act(() => listener?.({ kind: 'local-day', date: '2026-08-19' }));
    act(() => listener?.({ kind: 'immediate' }));
    await waitFor(() => expect(mounted.result.current.data).toBe(corrected));

    await act(async () => {
      staleLocalDays.resolve([
        { date: '2026-08-19', schedule: [], anytime: [], earlier: [] },
      ]);
      await staleLocalDays.promise;
    });
    expect(mounted.result.current.data).toBe(corrected);

    mounted.unmount();
    client.clear();
  });

  it('coalesces local-day publications received during a narrow Plans read', async () => {
    type Invalidation = { readonly kind: 'local-day'; readonly date: string };
    let listener: ((invalidation: Invalidation) => void) | undefined;
    const firstDays = deferred<AgendaData['days']>();
    const readDays = vi
      .fn<(coverage: unknown, dates: readonly string[]) => Promise<AgendaData['days']>>()
      .mockImplementationOnce(() => firstDays.promise)
      .mockResolvedValueOnce([
        { date: '2026-08-21', schedule: [], anytime: [], earlier: [] },
      ]);
    nativeState.current = {
      agenda: {
        subscribe: (_coverage: unknown, next: (invalidation: Invalidation) => void) => {
          listener = next;
          return () => undefined;
        },
        scope: () => 'agenda:incremental-burst',
        read: vi.fn(async () => ({
          days: [
            { date: '2026-08-19', schedule: [], anytime: [], earlier: [] },
            { date: '2026-08-20', schedule: [], anytime: [], earlier: [] },
            { date: '2026-08-21', schedule: [], anytime: [], earlier: [] },
          ],
          warnings: [],
        })),
        readDays,
        hasCoverage: async () => true,
        recordSyncError: async () => undefined,
      },
      sync: { pullAgenda: vi.fn() },
      account: {
        transactions: {
          run: async (operation: (transaction: never) => Promise<void>) =>
            operation(undefined as never),
        },
      },
    };
    const client = new QueryClient();
    client.setQueryData(['me'], { timezone: 'UTC' });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ClockProvider clock={fixedClock(NOW)}>{children}</ClockProvider>
      </QueryClientProvider>
    );
    const mounted = renderHook(
      () =>
        useAgenda({
          days: 62,
          now: NOW,
          incrementalLocalTargetReconciliation: true,
        }),
      { wrapper },
    );
    await waitFor(() => expect(mounted.result.current.status).toBe('success'));

    act(() => listener?.({ kind: 'local-day', date: '2026-08-19' }));
    await waitFor(() => expect(readDays).toHaveBeenCalledTimes(1));
    act(() => {
      listener?.({ kind: 'local-day', date: '2026-08-20' });
      listener?.({ kind: 'local-day', date: '2026-08-21' });
      listener?.({ kind: 'local-day', date: '2026-08-20' });
    });
    expect(readDays).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstDays.resolve([{ date: '2026-08-19', schedule: [], anytime: [], earlier: [] }]);
      await firstDays.promise;
    });
    await waitFor(() => expect(readDays).toHaveBeenCalledTimes(2));
    expect(readDays.mock.calls[1]?.[1]).toEqual(['2026-08-20', '2026-08-21']);

    mounted.unmount();
    client.clear();
  });

  it('coalesces a publication burst into one trailing read of the latest committed state', async () => {
    let listener: (() => void) | undefined;
    const firstRead = deferred<AgendaData>();
    const trailingRead = deferred<AgendaData>();
    const finalRead = deferred<AgendaData>();
    const first: AgendaData = {
      days: [{ date: '2026-08-19', schedule: [], anytime: [], earlier: [] }],
      warnings: ['duplicate_occurrence:first'],
    };
    const latest: AgendaData = {
      days: [{ date: '2026-08-19', schedule: [], anytime: [], earlier: [] }],
      warnings: ['duplicate_occurrence:latest'],
    };
    const final: AgendaData = {
      days: [{ date: '2026-08-19', schedule: [], anytime: [], earlier: [] }],
      warnings: ['duplicate_occurrence:final'],
    };
    const read = vi
      .fn<() => Promise<AgendaData>>()
      .mockImplementationOnce(() => firstRead.promise)
      .mockImplementationOnce(() => trailingRead.promise)
      .mockImplementationOnce(() => finalRead.promise);
    nativeState.current = {
      agenda: {
        subscribe: (_coverage: unknown, next: () => void) => {
          listener = next;
          return () => undefined;
        },
        scope: () => 'agenda:coalesced',
        read,
        hasCoverage: async () => true,
        recordSyncError: async () => undefined,
      },
      sync: { pullAgenda: vi.fn() },
      account: {
        transactions: {
          run: async (operation: (transaction: never) => Promise<void>) =>
            operation(undefined as never),
        },
      },
    };
    const client = new QueryClient();
    client.setQueryData(['me'], { timezone: 'UTC' });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ClockProvider clock={fixedClock(NOW)}>{children}</ClockProvider>
      </QueryClientProvider>
    );
    const mounted = renderHook(() => useAgenda({ now: NOW }), { wrapper });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    act(() => {
      listener?.();
      listener?.();
      listener?.();
    });
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstRead.resolve(first);
      await firstRead.promise;
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read).toHaveBeenCalledTimes(2);

    act(() => {
      listener?.();
      listener?.();
    });
    expect(read).toHaveBeenCalledTimes(2);

    await act(async () => {
      trailingRead.resolve(latest);
      await trailingRead.promise;
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));

    await act(async () => {
      finalRead.resolve(final);
      await finalRead.promise;
    });
    await waitFor(() => expect(mounted.result.current.data).toEqual(final));
    expect(read).toHaveBeenCalledTimes(3);

    mounted.unmount();
    client.clear();
  });

  it('does not publish or start a trailing read after losing focus mid-read', async () => {
    let listener: (() => void) | undefined;
    const pending = deferred<AgendaData>();
    const read = vi.fn(() => pending.promise);
    nativeState.current = {
      agenda: {
        subscribe: (_coverage: unknown, next: () => void) => {
          listener = next;
          return () => undefined;
        },
        scope: () => 'agenda:focus-cleanup',
        read,
        hasCoverage: async () => true,
        recordSyncError: async () => undefined,
      },
      sync: { pullAgenda: vi.fn() },
      account: {
        transactions: {
          run: async (operation: (transaction: never) => Promise<void>) =>
            operation(undefined as never),
        },
      },
    };
    const client = new QueryClient();
    client.setQueryData(['me'], { timezone: 'UTC' });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ClockProvider clock={fixedClock(NOW)}>{children}</ClockProvider>
      </QueryClientProvider>
    );
    const mounted = renderHook(() => useAgenda({ now: NOW }), { wrapper });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    focusState.cleanup?.();
    listener?.();
    await act(async () => {
      pending.resolve({
        days: [{ date: '2026-08-19', schedule: [], anytime: [], earlier: [] }],
        warnings: ['duplicate_occurrence:must-not-publish'],
      });
      await pending.promise;
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(mounted.result.current.status).toBe('pending');
    expect(mounted.result.current.data).toBeUndefined();
    mounted.unmount();
    client.clear();
  });

  it('recovers on the trailing publication when an in-flight read fails', async () => {
    let listener: (() => void) | undefined;
    const failed = deferred<AgendaData>();
    const recovered: AgendaData = {
      days: [{ date: '2026-08-19', schedule: [], anytime: [], earlier: [] }],
      warnings: ['duplicate_occurrence:recovered'],
    };
    const read = vi
      .fn<() => Promise<AgendaData>>()
      .mockImplementationOnce(() => failed.promise)
      .mockResolvedValueOnce(recovered);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    nativeState.current = {
      agenda: {
        subscribe: (_coverage: unknown, next: () => void) => {
          listener = next;
          return () => undefined;
        },
        scope: () => 'agenda:read-recovery',
        read,
        hasCoverage: async () => true,
        recordSyncError: async () => undefined,
      },
      sync: { pullAgenda: vi.fn() },
      account: {
        transactions: {
          run: async (operation: (transaction: never) => Promise<void>) =>
            operation(undefined as never),
        },
      },
    };
    const client = new QueryClient();
    client.setQueryData(['me'], { timezone: 'UTC' });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ClockProvider clock={fixedClock(NOW)}>{children}</ClockProvider>
      </QueryClientProvider>
    );
    const mounted = renderHook(() => useAgenda({ now: NOW }), { wrapper });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    listener?.();
    await act(async () => {
      failed.reject(new Error('temporary SQLite read failure'));
      await expect(failed.promise).rejects.toThrow('temporary SQLite read failure');
    });

    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mounted.result.current.data).toEqual(recovered));
    expect(warn).toHaveBeenCalledWith('native_agenda_reload_failed', {
      message: 'temporary SQLite read failure',
    });
    mounted.unmount();
    client.clear();
  });

  it('shares an in-flight focused read with a concurrent manual refresh', async () => {
    const pending = deferred<AgendaData>();
    const committed: AgendaData = {
      days: [{ date: '2026-08-19', schedule: [], anytime: [], earlier: [] }],
      warnings: [],
    };
    const read = vi.fn(() => pending.promise);
    const pullAgenda = vi.fn(async () => committed);
    nativeState.current = {
      agenda: {
        subscribe: () => () => undefined,
        scope: () => 'agenda:shared-read',
        read,
        hasCoverage: async () => true,
        recordSyncError: async () => undefined,
      },
      sync: { pullAgenda },
      account: {
        transactions: {
          run: async (operation: (transaction: never) => Promise<void>) =>
            operation(undefined as never),
        },
      },
    };
    const client = new QueryClient();
    client.setQueryData(['me'], { timezone: 'UTC' });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ClockProvider clock={fixedClock(NOW)}>{children}</ClockProvider>
      </QueryClientProvider>
    );
    const mounted = renderHook(() => useAgenda({ now: NOW }), { wrapper });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    let refresh!: ReturnType<typeof mounted.result.current.refetch>;
    act(() => {
      refresh = mounted.result.current.refetch();
    });
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(committed);
      await refresh;
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(pullAgenda).toHaveBeenCalledTimes(1);
    expect(mounted.result.current.data).toEqual(committed);
    mounted.unmount();
    client.clear();
  });
});
