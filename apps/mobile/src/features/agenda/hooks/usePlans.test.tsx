import type { WallDate } from '@od/shared/time';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePlanActivityFloor } from '@/stores/planActivityFloor';
import { type NeedsDateRowData, usePlans } from './usePlans';

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })
    }
  >
    {children}
  </QueryClientProvider>
);

/**
 * The §P3-40 monotonic merge in the needs-a-date stage: the authoritative `lastActivityAt` a
 * POST answered with moves the row immediately, and a stale eventually-consistent refetch
 * cannot move it back — GSI1 may answer with a projection older than the write the caller
 * just made, and that projection reconciles, it does not win.
 */

const A = 'act_01J8PANA000000000000000000';
const B = 'act_01J8PANB000000000000000000';

const needsDateRow = (activityId: string, lastActivityAt: string): NeedsDateRowData =>
  ({
    activityId,
    type: 'custom',
    title: activityId,
    status: 'scheduled',
    isRecurring: false,
    isSnoozed: false,
    hasCheckbox: false,
    capabilities: { complete: true, skip: false, snooze: false },
    participantAvatars: [],
    participantCount: 0,
    isPast: false,
    lastActivityAt,
    suggestionCount: 0,
    rsvpSummary: {
      interested: { count: 0, names: [] },
      maybe: { count: 0, names: [] },
      pass: { count: 0, names: [] },
      pending: { count: 0, names: [] },
    },
  }) as unknown as NeedsDateRowData;

/** The server's (stale) view: B is the most recently touched plan. */
const staleBody = () => ({
  data: {
    mode: 'initial',
    needsDate: [
      needsDateRow(B, '2026-08-02T10:00:00.000Z'),
      needsDateRow(A, '2026-08-01T10:00:00.000Z'),
    ],
    upcoming: [],
    upcomingWindow: { from: '2026-08-06', through: '2026-10-06', nextFrom: null },
    past: [],
    pastPage: {},
    warnings: [],
  },
  meta: { requestId: 'req_plans' },
});

beforeEach(() => {
  usePlanActivityFloor.setState({ floors: {} });
  vi.stubGlobal('fetch', () =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(staleBody()),
      text: () => Promise.resolve(JSON.stringify(staleBody())),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('moves a row up when the floor rises and holds it against a stale refetch', async () => {
  const { result } = renderHook(
    () => usePlans('America/New_York', '2026-08-06' as WallDate),
    {
      wrapper,
    },
  );
  await waitFor(() => expect(result.current.status).toBe('success'));
  expect(result.current.needsDate.map((row) => row.activityId)).toEqual([B, A]);

  // The POST response's authoritative value: A was just touched, newer than everything.
  act(() => {
    usePlanActivityFloor.getState().raise(A, '2026-08-03T09:00:00.000Z');
  });
  expect(result.current.needsDate.map((row) => row.activityId)).toEqual([A, B]);
  expect(result.current.needsDate[0]?.lastActivityAt).toBe('2026-08-03T09:00:00.000Z');

  // The refetch still answers with the pre-write projection; the floor clamps it.
  act(() => {
    result.current.refetch();
  });
  await waitFor(() => expect(result.current.isRefreshing).toBe(false));
  expect(result.current.needsDate.map((row) => row.activityId)).toEqual([A, B]);
  expect(result.current.needsDate[0]?.lastActivityAt).toBe('2026-08-03T09:00:00.000Z');
});

it('lets a genuinely newer server value win over an older floor', async () => {
  usePlanActivityFloor.getState().raise(B, '2026-08-01T00:00:00.000Z');
  const { result } = renderHook(
    () => usePlans('America/New_York', '2026-08-06' as WallDate),
    {
      wrapper,
    },
  );
  await waitFor(() => expect(result.current.status).toBe('success'));

  const rowB = result.current.needsDate.find((row) => row.activityId === B);
  expect(rowB?.lastActivityAt).toBe('2026-08-02T10:00:00.000Z');
});
