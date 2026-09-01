import type { WallDate } from '@od/shared/time';
import type { AgendaItem } from '@od/shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { activityMutationKeys } from '@/lib/mutationKeys';
import { raisePlanActivityFloor } from '@/stores/planActivityFloor';
import { type NeedsDateRowData, usePlans } from './usePlans';

/**
 * The Plans store's two write-side seams: the §P3-40 monotonic `lastActivityAt` merge, and
 * the mutation-cache lifecycle that projects completions (`pending`), restores the **exact**
 * prior statuses (`error`), and maps a negative passed-plan outcome to skipped, never
 * completed. The client is stable per test — a wrapper that rebuilt it each render would
 * resubscribe the hook to a cache nothing else writes to.
 */

const A = 'act_01J8PANA000000000000000000';
const B = 'act_01J8PANB000000000000000000';
const TODAY = '2026-08-06' as WallDate;

function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

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

const upcomingRow = (
  activityId: string,
  status: AgendaItem['status'],
  occurrenceDate?: string,
) => ({
  activityId,
  type: 'task',
  title: activityId,
  status,
  isRecurring: occurrenceDate !== undefined,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: false, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
  ...(occurrenceDate === undefined ? {} : { occurrenceDate }),
});

interface BodyOverrides {
  needsDate?: unknown[];
  upcoming?: { date: string; items: unknown[] }[];
}

const body = (overrides: BodyOverrides = {}) => ({
  data: {
    mode: 'initial',
    needsDate: overrides.needsDate ?? [],
    upcoming: overrides.upcoming ?? [],
    upcomingWindow: { from: '2026-08-06', through: '2026-10-06', nextFrom: null },
    past: [],
    pastPage: {},
    warnings: [],
  },
  meta: { requestId: 'req_plans' },
});

function stubFetch(payload: unknown) {
  vi.stubGlobal('fetch', () =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(payload),
      text: () => Promise.resolve(JSON.stringify(payload)),
    }),
  );
}

/** Drives one mutation through the same cache the hook subscribes to. */
async function runMutation(
  client: QueryClient,
  key: readonly string[],
  variables: unknown,
  outcome: 'resolve' | 'reject',
) {
  const mutation = client.getMutationCache().build(client, {
    mutationKey: [...key],
    mutationFn:
      outcome === 'resolve'
        ? () => Promise.resolve({})
        : () => Promise.reject(new Error('boom')),
  });
  await act(async () => {
    await mutation.execute(variables).catch(() => {});
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('moves a row up when the floor rises and holds it against a stale refetch', async () => {
  stubFetch(
    body({
      needsDate: [
        needsDateRow(B, '2026-08-02T10:00:00.000Z'),
        needsDateRow(A, '2026-08-01T10:00:00.000Z'),
      ],
    }),
  );
  const { client, wrapper } = harness();
  const { result } = renderHook(() => usePlans('America/New_York', TODAY, '12:00'), {
    wrapper,
  });
  await waitFor(() => expect(result.current.status).toBe('success'));
  expect(result.current.needsDate.map((row) => row.activityId)).toEqual([B, A]);

  act(() => {
    raisePlanActivityFloor(client, A, '2026-08-03T09:00:00.000Z');
  });
  await waitFor(() =>
    expect(result.current.needsDate.map((row) => row.activityId)).toEqual([A, B]),
  );

  act(() => {
    result.current.refetch();
  });
  await waitFor(() => expect(result.current.isRefreshing).toBe(false));
  expect(result.current.needsDate.map((row) => row.activityId)).toEqual([A, B]);
  expect(result.current.needsDate[0]?.lastActivityAt).toBe('2026-08-03T09:00:00.000Z');
});

it('lets a genuinely newer server value win over an older floor', async () => {
  stubFetch(body({ needsDate: [needsDateRow(B, '2026-08-02T10:00:00.000Z')] }));
  const { client, wrapper } = harness();
  raisePlanActivityFloor(client, B, '2026-08-01T00:00:00.000Z');
  const { result } = renderHook(() => usePlans('America/New_York', TODAY, '12:00'), {
    wrapper,
  });
  await waitFor(() => expect(result.current.status).toBe('success'));
  expect(result.current.needsDate[0]?.lastActivityAt).toBe('2026-08-02T10:00:00.000Z');
});

it('projects a completion on pending and restores the exact status on error', async () => {
  stubFetch(
    body({
      upcoming: [{ date: '2026-08-08', items: [upcomingRow(A, 'scheduled')] }],
    }),
  );
  const { client, wrapper } = harness();
  const { result } = renderHook(() => usePlans('America/New_York', TODAY, '12:00'), {
    wrapper,
  });
  await waitFor(() => expect(result.current.status).toBe('success'));

  await runMutation(
    client,
    activityMutationKeys.complete,
    { activityId: A, input: {}, idempotencyKey: 'k1' },
    'reject',
  );
  // Projected on pending, restored — not fabricated — on error.
  const row = result.current.store.byDate.get('2026-08-08' as WallDate)?.[0];
  expect(row?.status).toBe('scheduled');
});

it('restores a skipped occurrence on a failed undoSkip, never a fabricated status', async () => {
  stubFetch(
    body({
      upcoming: [
        {
          date: '2026-08-08',
          items: [upcomingRow(A, 'skipped_occurrence', '2026-08-08')],
        },
      ],
    }),
  );
  const { client, wrapper } = harness();
  const { result } = renderHook(() => usePlans('America/New_York', TODAY, '12:00'), {
    wrapper,
  });
  await waitFor(() => expect(result.current.status).toBe('success'));

  await runMutation(
    client,
    activityMutationKeys.uncomplete,
    { activityId: A, input: { occurrenceDate: '2026-08-08' }, idempotencyKey: 'k2' },
    'reject',
  );
  const row = result.current.store.byDate.get('2026-08-08' as WallDate)?.[0];
  expect(row?.status).toBe('skipped_occurrence');
});

it('moves a rescheduled one-off to its new date from the authoritative response', async () => {
  stubFetch(
    body({
      upcoming: [{ date: '2026-08-08', items: [upcomingRow(A, 'scheduled')] }],
    }),
  );
  const { client, wrapper } = harness();
  const { result } = renderHook(() => usePlans('America/New_York', TODAY, '12:00'), {
    wrapper,
  });
  await waitFor(() => expect(result.current.status).toBe('success'));

  const rescheduled = {
    activityId: A,
    ownerId: 'usr_local_dev',
    objectKind: 'plan',
    type: 'event',
    status: 'scheduled',
    title: A,
    schedule: { date: '2026-08-20', time: '19:00', timezone: 'America/New_York' },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    details: { kind: 'event' },
    icsSequence: 1,
    createdAt: '2026-08-01T10:00:00.000Z',
    lastActivityAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
    schemaVersion: 1,
  };
  const mutation = client.getMutationCache().build(client, {
    mutationKey: [...activityMutationKeys.schedule],
    mutationFn: () => Promise.resolve(rescheduled),
  });
  await act(async () => {
    await mutation.execute({
      activityId: A,
      input: { date: '2026-08-20' },
      idempotencyKey: 'k4',
    });
  });

  await waitFor(() =>
    expect(result.current.store.byDate.get('2026-08-08' as WallDate)).toEqual([]),
  );
  expect(result.current.store.byDate.get('2026-08-20' as WallDate)?.[0]?.activityId).toBe(
    A,
  );
});

it('projects a negative passed-plan outcome as skipped, not completed', async () => {
  stubFetch(
    body({
      upcoming: [{ date: '2026-08-05', items: [upcomingRow(A, 'scheduled')] }],
    }),
  );
  const { client, wrapper } = harness();
  const { result } = renderHook(() => usePlans('America/New_York', TODAY, '12:00'), {
    wrapper,
  });
  await waitFor(() => expect(result.current.status).toBe('success'));

  await runMutation(
    client,
    activityMutationKeys.complete,
    { activityId: A, input: { outcome: 'didnt_happen' }, idempotencyKey: 'k3' },
    'resolve',
  );
  await waitFor(() => {
    const row = result.current.store.byDate.get('2026-08-05' as WallDate)?.[0];
    expect(row?.status).toBe('skipped');
  });
});
