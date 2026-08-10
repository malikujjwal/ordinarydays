import type { ActivityListItem } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlansScreen } from './PlansScreen';

/**
 * The Plans tab's flat list (P1-23, reading P1-16).
 *
 * Every case drives a stubbed `fetch` returning bodies that satisfy the **real shared
 * schemas** — `strictResponses` is on under Vitest, so a fixture that drifted from the
 * contract fails the test rather than rendering.
 */
const row = (patch: Partial<ActivityListItem> = {}): ActivityListItem => ({
  activityId: 'act_01J0000000000000000000000A',
  type: 'event',
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

function mount(onOpen = () => {}, onAdd = () => {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (ui: ReactNode) => (
    <SafeAreaProvider>
      <ThemeProvider scheme="light">
        <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
  return render(wrap(<PlansScreen onOpen={onOpen} onAdd={onAdd} />));
}

beforeEach(() => {
  sent.length = 0;
});

afterEach(() => vi.unstubAllGlobals());

describe('reading', () => {
  it('asks for one stage of one bucket, naming the filter', async () => {
    stubFetch({ status: 200, body: page([row()]) });
    mount();

    await waitFor(() => expect(screen.getByTestId('plans-list')).toBeDefined());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('/v1/activities?filter=upcoming');
  });

  it('renders a row per activity, with its time and subtitle', async () => {
    stubFetch({
      status: 200,
      body: page([row({ time: '19:30', subtitle: 'Zahav' })]),
    });
    mount();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Dinner at Zahav/ })).toBeDefined(),
    );
    expect(screen.getByText('7:30 PM · Zahav')).toBeDefined();
  });

  /** U1: tapping the body opens the detail. It never mutates and never writes. */
  it('opens a row rather than changing it', async () => {
    const onOpen = vi.fn();
    stubFetch({ status: 200, body: page([row()]) });
    mount(onOpen);

    await waitFor(() => expect(screen.getByTestId('plans-list')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /Dinner at Zahav/ }));

    expect(onOpen).toHaveBeenCalledExactlyOnceWith('act_01J0000000000000000000000A');
    // One GET, and nothing else — no write left this screen.
    expect(sent).toHaveLength(1);
  });

  /**
   * A recurring series is one row carrying `isRecurring`, never one row per occurrence
   * (`CLAUDE.md` rule 3), and what the marker says out loud is in the row's own name.
   */
  it('marks a series once, and says so in its accessible name', async () => {
    stubFetch({ status: 200, body: page([row({ isRecurring: true })]) });
    mount();

    await waitFor(() => expect(screen.getByTestId('plans-list')).toBeDefined());
    expect(screen.getAllByText('Dinner at Zahav')).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: 'Dinner at Zahav · Repeats' }),
    ).toBeDefined();
  });
});

describe('the four states (interaction-contract.md §5)', () => {
  it('shows skeleton rows on first load, not a spinner', () => {
    stubFetch({ status: 200, body: page([]) });
    mount();
    expect(screen.getByTestId('plans-loading')).toBeDefined();
  });

  it('shows §5.2 empty copy with the global Add action', async () => {
    const onAdd = vi.fn();
    stubFetch({ status: 200, body: page([]) });
    mount(() => {}, onAdd);

    await waitFor(() => expect(screen.getByTestId('plans-empty')).toBeDefined());
    expect(screen.getByText('No upcoming plans')).toBeDefined();
    expect(screen.getByText('Anything with a date shows up here.')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it('shows the §5.3 failure with a request id and a Try again', async () => {
    stubFetch({
      status: 500,
      body: { error: { code: 'internal', message: 'boom', requestId: 'req_boom' } },
    });
    mount();

    /**
     * Longer than the default second on purpose: a 5xx is retryable, so the transport makes
     * four attempts with jittered backoff before the query ever sees a failure
     * (`client/http.ts`). That is as much the behaviour under test as the copy is — the screen
     * must not show its error state until the retries are actually exhausted.
     */
    await waitFor(() => expect(screen.getByTestId('plans-error')).toBeDefined(), {
      timeout: 10_000,
    });
    expect(screen.getByText('Something went wrong.')).toBeDefined();
    expect(screen.getByText('req_boom')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
  });
});

/**
 * Paging policy is asserted against `usePlans` in `../hooks/usePlans.test.tsx`, not through a
 * synthetic scroll here. `onEndReached` depends on layout measurements that are all zero under
 * jsdom, so a scroll test would be asserting React Native Web's emulation rather than this
 * screen's behaviour — and the rule it has to hold (follow the cursor, never the page length)
 * lives in the hook either way.
 */
