import { fixedClock, type Instant } from '@od/shared/time';
import type { AgendaData } from '@od/shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClockProvider } from '@/hooks/useClock';
import { useAgenda } from './useAgenda.native';

const nativeState = vi.hoisted(() => ({ current: undefined as unknown }));
const focusState = vi.hoisted(() => ({ cleanup: undefined as (() => void) | undefined }));

vi.mock('@/lib/sqlite/nativeState', () => ({
  requireActiveNativeState: () => nativeState.current,
}));

vi.mock('expo-router', async () => {
  const react = await import('react');
  return {
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

describe('native useAgenda', () => {
  afterEach(() => {
    nativeState.current = undefined;
    focusState.cleanup = undefined;
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
});
