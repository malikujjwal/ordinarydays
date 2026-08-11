import type { User } from '@od/shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/apiClient';
import { TODAY_AGENDA_INCLUDE } from '../keys';
import { useAgenda } from './useAgenda';

const PROFILE: User = {
  userId: 'usr_local_dev',
  displayName: 'Local developer',
  timezone: 'America/New_York',
  currency: 'USD',
  weekStartsOn: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  schemaVersion: 1,
};

const agendaBody = (date: string) => ({
  data: {
    days: [{ date, schedule: [], anytime: [], earlier: [] }],
    warnings: [],
  },
  meta: { requestId: 'req_agenda' },
});

interface FetchOutcome {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(...outcomes: FetchOutcome[]) {
  const calls: FetchCall[] = [];
  const text = vi.fn<typeof Response.prototype.text>();
  vi.stubGlobal('fetch', (url: string, init?: { headers?: Record<string, string> }) => {
    const outcome = outcomes[Math.min(calls.length, outcomes.length - 1)];
    if (outcome === undefined) throw new Error('No fetch outcome was configured.');
    calls.push({ url, headers: init?.headers ?? {} });
    return Promise.resolve({
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      headers: { get: (name: string) => outcome.headers?.[name] ?? null },
      json: () => Promise.resolve(outcome.body),
      text: () => {
        text();
        return Promise.resolve(
          outcome.body === undefined ? '' : JSON.stringify(outcome.body),
        );
      },
    });
  });
  return { calls, text };
}

function testClient(timezone = PROFILE.timezone) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, networkMode: 'always' } },
  });
  queryClient.setQueryData(['me'], { ...PROFILE, timezone });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function emptyTestClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, networkMode: 'always' } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper };
}

beforeEach(() => apiClient.clearCache());

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useAgenda', () => {
  it('issues exactly the one product-owned Today request', async () => {
    const { calls } = stubFetch({ status: 200, body: agendaBody('2026-08-06') });
    const { wrapper } = testClient();

    const { result } = renderHook(
      () => useAgenda({ now: new Date('2026-08-06T16:00:00.000Z') }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(calls).toEqual([
      {
        url: `http://localhost:3000/v1/agenda?from=2026-08-06&to=2026-08-06&tz=America%2FNew_York&include=${encodeURIComponent(TODAY_AGENDA_INCLUDE)}`,
        headers: expect.any(Object),
      },
    ]);
  });

  it('falls back to the device timezone without fetching the unloaded profile', async () => {
    const instant = new Date('2026-08-06T16:00:00.000Z');
    const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const deviceDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: deviceTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
    const { calls } = stubFetch({ status: 200, body: agendaBody(deviceDate) });
    const { wrapper } = emptyTestClient();

    const { result } = renderHook(() => useAgenda({ now: instant }), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `http://localhost:3000/v1/agenda?from=${deviceDate}&to=${deviceDate}&tz=${encodeURIComponent(deviceTimezone)}&include=${encodeURIComponent(TODAY_AGENDA_INCLUDE)}`,
    );
  });

  it('surfaces schema drift as the query error instead of partial data', async () => {
    stubFetch({
      status: 200,
      body: { data: { days: [{ date: '2026-08-06' }], warnings: [] }, meta: {} },
    });
    const { wrapper } = testClient();

    const { result } = renderHook(
      () => useAgenda({ now: new Date('2026-08-06T16:00:00.000Z') }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toMatchObject({ name: 'ResponseValidationError' });
  });

  it('re-keys from the profile-zone date when the ticker crosses midnight', async () => {
    const { calls } = stubFetch(
      { status: 200, body: agendaBody('2026-08-06') },
      { status: 200, body: agendaBody('2026-08-07') },
    );
    const { queryClient, wrapper } = testClient('UTC');
    const { result, rerender } = renderHook(
      ({ now }: { now: Date }) => useAgenda({ now }),
      {
        initialProps: { now: new Date('2026-08-06T23:59:00.000Z') },
        wrapper,
      },
    );
    await waitFor(() => expect(result.current.data?.days[0]?.date).toBe('2026-08-06'));

    rerender({ now: new Date('2026-08-07T00:00:00.000Z') });

    await waitFor(() => expect(result.current.data?.days[0]?.date).toBe('2026-08-07'));
    expect(calls).toHaveLength(2);
    expect(
      queryClient.getQueryData([
        'agenda',
        '2026-08-06',
        '2026-08-06',
        'UTC',
        TODAY_AGENDA_INCLUDE,
      ]),
    ).toBeDefined();
  });

  it('exposes the same successful data after a cached 304 as after a fresh 200', async () => {
    const { calls, text } = stubFetch(
      {
        status: 200,
        body: agendaBody('2026-08-06'),
        headers: { ETag: '"agenda-a"' },
      },
      { status: 304 },
    );
    const { wrapper } = testClient();
    const { result } = renderHook(
      () => useAgenda({ now: new Date('2026-08-06T16:00:00.000Z') }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.status).toBe('success'));
    const fresh = result.current.data;

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.status).toBe('success');
    expect(result.current.data).toEqual(fresh);
    expect(calls[1]?.headers['If-None-Match']).toBe('"agenda-a"');
    expect(text).toHaveBeenCalledTimes(1);
  });

  it('refetches the current key when the app returns to the foreground', async () => {
    type ChangeHandler = Parameters<typeof AppState.addEventListener>[1];
    let onChange: ChangeHandler | undefined;
    const remove = vi.fn();
    vi.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
      onChange = handler;
      return { remove };
    });
    const { calls } = stubFetch(
      { status: 200, body: agendaBody('2026-08-06') },
      { status: 200, body: agendaBody('2026-08-06') },
    );
    const { wrapper } = testClient();
    const mounted = renderHook(
      () => useAgenda({ now: new Date('2026-08-06T16:00:00.000Z') }),
      { wrapper },
    );
    await waitFor(() => expect(mounted.result.current.status).toBe('success'));

    act(() => onChange?.('active'));

    await waitFor(() => expect(calls).toHaveLength(2));
    mounted.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('uses one parameterised hook for a multi-day window with no Today include tokens', async () => {
    const { calls } = stubFetch({ status: 200, body: agendaBody('2026-08-06') });
    const { wrapper } = testClient('UTC');

    const { result } = renderHook(
      () =>
        useAgenda({
          window: { from: '2026-08-06', to: '2026-08-12' },
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(calls[0]?.url).toBe(
      'http://localhost:3000/v1/agenda?from=2026-08-06&to=2026-08-12&tz=UTC',
    );
  });
});
