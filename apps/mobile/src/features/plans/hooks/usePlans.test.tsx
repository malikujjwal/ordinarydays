import type { ActivityListItem } from '@od/shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlans } from './usePlans';

/**
 * The Plans read and its paging policy (P1-23, reading P1-16).
 *
 * Asserted on the hook rather than through the list's `onEndReached`, because every layout
 * measurement is zero under jsdom: a scroll-driven test would be asserting React Native Web's
 * emulation, and the rule under test — **page until the cursor is absent, never until a page
 * is short** (`api-contract.md` §2.2a) — is the hook's, not the list's.
 */
const row = (patch: Partial<ActivityListItem> = {}): ActivityListItem => ({
  activityId: 'act_01J0000000000000000000000A',
  type: 'outing',
  title: 'Dinner at Zahav',
  status: 'scheduled',
  isRecurring: false,
  participantCount: 0,
  ...patch,
});

const page = (items: ActivityListItem[], nextCursor?: string) => ({
  data: items,
  meta: { requestId: 'req_test', ...(nextCursor === undefined ? {} : { nextCursor }) },
});

const sent: string[] = [];

function stubFetch(...responses: Array<{ status: number; body: unknown }>) {
  let call = 0;
  vi.stubGlobal('fetch', (url: string) => {
    sent.push(url);
    const outcome = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (outcome === undefined) throw new Error('no outcome');
    return Promise.resolve({
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      headers: { get: () => null },
      json: () => Promise.resolve(outcome.body),
      text: () => Promise.resolve(JSON.stringify(outcome.body)),
    });
  });
}

function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderHook(() => usePlans('upcoming'), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

beforeEach(() => {
  sent.length = 0;
});

afterEach(() => vi.unstubAllGlobals());

describe('usePlans', () => {
  it('asks for one stage of one bucket, naming the filter and no cursor', async () => {
    stubFetch({ status: 200, body: page([row()]) });
    const { result } = mount();

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(sent).toEqual(['http://localhost:3000/v1/activities?filter=upcoming']);
    expect(result.current.items).toHaveLength(1);
  });

  /**
   * The page that carried the cursor holds **one** row — far short of the 50 default. A client
   * that stopped on a short page would silently lose every row after it, which is exactly the
   * failure `api-contract.md` §2.2a warns about, because `type` narrows a page after the Query.
   */
  it('follows the cursor even when the page that carried it was short', async () => {
    stubFetch(
      { status: 200, body: page([row()], 'Y3Vyc29yLTE') },
      {
        status: 200,
        body: page([row({ activityId: 'act_01J0000000000000000000000B' })]),
      },
    );
    const { result } = mount();

    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(sent[1]).toContain('cursor=Y3Vyc29yLTE');
    expect(result.current.hasMore).toBe(false);
  });

  it('asks for nothing more once the cursor is absent', async () => {
    stubFetch({ status: 200, body: page([row()]) });
    const { result } = mount();

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.hasMore).toBe(false);

    act(() => result.current.loadMore());
    expect(sent).toHaveLength(1);
  });

  it('surfaces the §5.3 failure copy and its request id', async () => {
    stubFetch({
      status: 500,
      body: { error: { code: 'internal', message: 'boom', requestId: 'req_boom' } },
    });
    const { result } = mount();

    // Four attempts with jittered backoff before the query sees a failure (`client/http.ts`).
    await waitFor(() => expect(result.current.status).toBe('error'), { timeout: 10_000 });
    expect(result.current.message).toBe('Something went wrong.');
    expect(result.current.requestId).toBe('req_boom');
  });
});
