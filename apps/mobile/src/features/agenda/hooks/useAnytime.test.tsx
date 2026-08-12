import type { ActivityListItem } from '@od/shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnytime } from './useAnytime';

const item = (activityId: string, title: string): ActivityListItem => ({
  activityId,
  type: 'task',
  title,
  status: 'saved',
  isRecurring: false,
  participantCount: 0,
});

const page = (items: ActivityListItem[], nextCursor?: string) => ({
  data: items,
  meta: { requestId: 'req_saved', ...(nextCursor === undefined ? {} : { nextCursor }) },
});

const sent: string[] = [];

function stubFetch(...bodies: unknown[]) {
  let call = 0;
  vi.stubGlobal('fetch', (url: string) => {
    sent.push(url);
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  });
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['me'], { timezone: 'UTC' });
  return renderHook(() => useAnytime(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

beforeEach(() => {
  sent.length = 0;
});

afterEach(() => vi.unstubAllGlobals());

describe('useAnytime', () => {
  it('requests exactly the saved stage and preserves server order', async () => {
    const newest = item('act_01J0000000000000000000000B', 'Newest');
    const older = item('act_01J0000000000000000000000A', 'Older');
    stubFetch(page([newest, older]));
    const { result } = mount();

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(sent).toEqual(['http://localhost:3000/v1/activities?filter=saved']);
    expect(result.current.items).toEqual([newest, older]);
  });

  it('pages from the server cursor even when the first page is short', async () => {
    stubFetch(
      page([item('act_01J0000000000000000000000B', 'Newest')], 'cursor-2'),
      page([item('act_01J0000000000000000000000A', 'Older')]),
    );
    const { result } = mount();

    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    expect(sent[1]).toBe(
      'http://localhost:3000/v1/activities?filter=saved&cursor=cursor-2',
    );
    expect(result.current.items.map(({ title }) => title)).toEqual(['Newest', 'Older']);
  });
});
