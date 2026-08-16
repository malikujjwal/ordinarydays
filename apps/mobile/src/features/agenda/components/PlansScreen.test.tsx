import { fixedClock, type Instant } from '@od/shared/time';
import type { AgendaData, AgendaItem } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { afterEach, expect, it, vi } from 'vitest';
import { ClockProvider } from '@/hooks/useClock';
import { PlansScreen } from './PlansScreen';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'idem-plans-test' }));

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const row = (index: number, patch: Partial<AgendaItem> = {}): AgendaItem => ({
  activityId: `act_01J8SEED${'0'.repeat(16)}${CROCKFORD[index % CROCKFORD.length]}${CROCKFORD[(index * 7) % CROCKFORD.length]}`,
  type: 'event',
  title: `Plan ${index}`,
  status: 'scheduled',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: false,
  capabilities: { complete: true, skip: false, snooze: false },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
  ...patch,
});

const day = (date: string, items: AgendaItem[] = []) => ({
  date,
  schedule: items.filter((item) => item.time !== undefined),
  anytime: items.filter((item) => item.time === undefined),
  earlier: [],
});

const response = (days: AgendaData['days']) => ({
  data: { days, warnings: [] },
  meta: { requestId: 'req_plans' },
});

interface FetchCall {
  url: string;
  method: string;
}

function stubFetch(body: unknown, activitiesBody?: unknown): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    const selected = url.includes('/v1/activities') ? activitiesBody : body;
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(selected),
      text: () => Promise.resolve(JSON.stringify(selected)),
    });
  });
  return calls;
}

function stubFailure(): void {
  vi.stubGlobal('fetch', () =>
    Promise.resolve({
      ok: false,
      status: 500,
      headers: { get: () => null },
      json: () =>
        Promise.resolve({
          error: { code: 'internal', message: 'boom', requestId: 'req_plans_error' },
        }),
      text: () => Promise.resolve(''),
    }),
  );
}

function mount(onOpen = () => {}, onAdd = () => {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, networkMode: 'always' } },
  });
  client.setQueryData(['me'], { timezone: 'UTC' });
  return render(
    <SafeAreaProvider>
      <ClockProvider clock={fixedClock('2026-08-06T15:10:00.000Z' as Instant)}>
        <ThemeProvider scheme="light">
          <QueryClientProvider client={client}>
            <PlansScreen onOpen={onOpen} onAdd={onAdd} />
          </QueryClientProvider>
        </ThemeProvider>
      </ClockProvider>
    </SafeAreaProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('shows the loading state while the agenda request is pending', () => {
  vi.stubGlobal('fetch', () => new Promise(() => {}));
  mount();

  expect(screen.getByTestId('plans-loading')).toBeDefined();
});

it('requests the inclusive 62-day agenda window without Anytime and never reads undated Plans', async () => {
  const undatedSharedPlan = row(30, { title: 'Undated shared plan' });
  const calls = stubFetch(response([day('2026-08-06')]), {
    data: [undatedSharedPlan],
    meta: { requestId: 'req_wrong_endpoint' },
  });
  mount();

  await waitFor(() => expect(screen.getByTestId('plans-empty')).toBeDefined());
  expect(calls).toEqual([
    {
      url: 'http://localhost:3000/v1/agenda?from=2026-08-06&to=2026-10-06&tz=UTC',
      method: 'GET',
    },
  ]);
  expect(screen.queryByText('Undated shared plan')).toBeNull();
});

it('uses the canonical empty-state copy and global Add action', async () => {
  const onAdd = vi.fn();
  stubFetch(response([day('2026-08-06')]));
  mount(() => {}, onAdd);

  await screen.findByText('No upcoming plans');
  expect(screen.getByText('Anything with a date shows up here.')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect(onAdd).toHaveBeenCalledOnce();
});

it('shows the standard retry surface when the agenda request fails', async () => {
  stubFailure();
  mount();

  await screen.findByTestId('plans-error', {}, { timeout: 10_000 });
  expect(screen.getByText('Something went wrong.')).toBeDefined();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
}, 15_000);

it('renders one card per recurring occurrence across a seven-day response', async () => {
  const recurringDays = Array.from({ length: 7 }, (_, index) => {
    const date = `2026-08-${String(6 + index).padStart(2, '0')}`;
    return day(date, [
      row(index, {
        title: 'Daily walk',
        occurrenceDate: date,
        isRecurring: true,
        recurrenceDescription: 'Every day',
        time: '18:00',
      }),
    ]);
  });
  stubFetch(response(recurringDays));
  mount();

  await waitFor(() => expect(screen.getByTestId('plans-list')).toBeDefined());
  expect(screen.getAllByText('Daily walk')).toHaveLength(7);
});

it("disables a future recurring task's checkbox until its occurrence date", async () => {
  stubFetch(
    response([
      day('2026-08-07', [
        row(1, {
          type: 'task',
          title: 'Tomorrow stand-up',
          occurrenceDate: '2026-08-07',
          isRecurring: true,
          hasCheckbox: true,
          time: '09:00',
        }),
      ]),
    ]),
  );
  mount();

  const checkbox = await screen.findByRole('checkbox', {
    name: 'Tomorrow stand-up, not completed',
  });
  expect(checkbox.getAttribute('aria-disabled')).toBe('true');
});

it('renders exact gap copy and opens a date picker pre-set to the first date without writing', async () => {
  const calls = stubFetch(
    response([
      day('2026-08-19', [row(1)]),
      day('2026-08-20'),
      day('2026-08-21'),
      day('2026-08-22'),
      day('2026-08-23'),
      day('2026-08-24'),
      day('2026-08-25', [row(2)]),
    ]),
  );
  mount();

  const gap = await screen.findByRole('button', {
    name: 'Aug 20 – 24 · nothing planned',
  });
  const requestsBeforeTap = calls.length;
  expect(gap.style.minHeight).toBe('44px');
  expect(gap.style.width).toBe('100%');
  expect(screen.getByText('Aug 20 – 24 · nothing planned').style.fontSize).toBe('13px');
  fireEvent.click(gap);

  expect(screen.getByTestId('plans-gap-date-picker')).toBeDefined();
  expect(screen.getByText('Thu, Aug 20')).toBeDefined();
  expect(calls).toHaveLength(requestsBeforeTap);
  expect(calls.every(({ method }) => method === 'GET')).toBe(true);
});

it('uses sticky month sections and replaces August with September in document order', async () => {
  stubFetch(response([day('2026-08-29', [row(1)]), day('2026-09-03', [row(2)])]));
  mount();

  const august = await screen.findByTestId('plans-month-2026-08');
  const september = screen.getByTestId('plans-month-2026-09');
  expect(screen.getByRole('heading', { name: 'August 2026' })).toBeDefined();
  expect(screen.getByRole('heading', { name: 'September 2026' })).toBeDefined();
  expect(
    august.compareDocumentPosition(september) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

  fireEvent.scroll(screen.getByTestId('plans-list'), {
    target: { scrollTop: 1_000 },
  });
  expect(screen.getByTestId('plans-month-2026-09')).toBeDefined();
});

it("opens today's recurring task with its occurrence scope", async () => {
  const onOpen = vi.fn();
  const todayOccurrence = row(1, {
    type: 'task',
    title: 'Today stand-up',
    occurrenceDate: '2026-08-06',
    isRecurring: true,
    hasCheckbox: true,
  });
  const calls = stubFetch(response([day('2026-08-06', [todayOccurrence])]));
  mount(onOpen);

  const cardBody = await screen.findByRole('button', { name: /Today stand-up/ });
  fireEvent.click(cardBody);
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(todayOccurrence);
  expect(calls).toHaveLength(1);
});

/**
 * Reported: a recurring plan shows only today's occurrence, none of the later ones.
 *
 * Plans asks for the full 62-day window and the server expands a recurring plan across it
 * (`agendaService.test.ts`), so this closes the last untested link — that the screen renders
 * every occurrence rather than collapsing a series to one row. `buildUpcomingSections` keys
 * items by `activityId:occurrenceDate`, and a series shares one `activityId` across every day.
 */
it('renders one row per occurrence of a recurring plan across the window', async () => {
  const occurrence = (date: string): AgendaItem =>
    row(1, {
      title: 'Book club',
      time: '18:00',
      isRecurring: true,
      occurrenceDate: date,
      recurrenceDescription: 'Every day',
    });
  const dates = ['2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09'];
  stubFetch(response(dates.map((date) => day(date, [occurrence(date)]))));

  mount();

  for (const date of dates) {
    expect(await screen.findByTestId(`plans-date-${date}`)).toBeDefined();
  }
  // One card per day, each carrying the occurrence's own date in its key.
  for (const date of dates) {
    expect(
      screen.getByTestId(`plans-card-${occurrence(date).activityId}:${date}`),
    ).toBeDefined();
  }
  expect(screen.getAllByText('Book club')).toHaveLength(dates.length);
});
