import { fixedClock, type Instant } from '@od/shared/time';
import type { AgendaItem } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { afterEach, expect, it, vi } from 'vitest';
import { ClockProvider } from '@/hooks/useClock';
import type { NeedsDateRowData } from '../hooks/usePlans';
import { PlansScreen } from './PlansScreen';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'idem-plans-test' }));

/**
 * The three-stage Plans tab (P3-36, `plans-and-lists.md` §1.3).
 *
 * Today is pinned to 2026-08-06 UTC. Every fixture speaks the `/v1/plans` contract — the
 * screen replaced the P2-32 agenda read, and these tests replaced that file's fixtures with
 * it. §1.3.2's prohibitions each appear below as an assertion, not a comment.
 */

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

const zeroGroups = {
  interested: { count: 0, names: [] },
  maybe: { count: 0, names: [] },
  pass: { count: 0, names: [] },
  pending: { count: 0, names: [] },
};

const needsDateRow = (
  index: number,
  patch: Partial<NeedsDateRowData> = {},
): NeedsDateRowData => ({
  ...row(index),
  lastActivityAt: '2026-08-01T10:00:00.000Z',
  rsvpSummary: zeroGroups,
  suggestionCount: 0,
  ...patch,
});

const plansDay = (date: string, items: AgendaItem[]) => ({ date, items });

interface InitialOverrides {
  needsDate?: NeedsDateRowData[];
  upcoming?: ReturnType<typeof plansDay>[];
  upcomingWindow?: { from: string; through: string; nextFrom: string | null };
  past?: ReturnType<typeof plansDay>[];
  pastPage?: { nextCursor?: string };
}

const initialBody = (overrides: InitialOverrides = {}) => ({
  data: {
    mode: 'initial',
    needsDate: overrides.needsDate ?? [],
    upcoming: overrides.upcoming ?? [],
    upcomingWindow: overrides.upcomingWindow ?? {
      from: '2026-08-06',
      through: '2026-10-06',
      nextFrom: null,
    },
    past: overrides.past ?? [],
    pastPage: overrides.pastPage ?? {},
    warnings: [],
  },
  meta: { requestId: 'req_plans' },
});

interface FetchCall {
  url: string;
  method: string;
}

/** Serves `/v1/plans` by arrival order; the first body answers every later call too. */
function stubFetch(...bodies: unknown[]): FetchCall[] {
  const calls: FetchCall[] = [];
  let plansCall = 0;
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    const body = url.includes('/v1/plans')
      ? (bodies[Math.min(plansCall++, bodies.length - 1)] ?? initialBody())
      : { data: {}, meta: { requestId: 'req_other' } };
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
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

const openStage = (label: string) =>
  fireEvent.click(screen.getByRole('tab', { name: label }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('shows the loading state while the initial request is pending', () => {
  vi.stubGlobal('fetch', () => new Promise(() => {}));
  mount();

  expect(screen.getByTestId('plans-loading')).toBeDefined();
});

it('renders the whole screen from one initial /v1/plans request', async () => {
  const calls = stubFetch(
    initialBody({
      needsDate: [needsDateRow(1, { title: 'Poconos trip' })],
      upcoming: [plansDay('2026-08-08', [row(2, { title: 'Dinner', time: '19:00' })])],
      past: [plansDay('2026-08-01', [row(3, { title: 'Old lunch', isPast: true })])],
    }),
  );
  mount();

  await screen.findByText('Dinner');
  expect(calls.filter(({ url }) => url.includes('/v1/plans'))).toHaveLength(1);
  expect(calls[0]?.url).toContain('mode=initial');
  expect(calls[0]?.url).toContain('tz=UTC');

  // Every stage is one tap away, and no request accompanies the tap.
  openStage('Needs a date');
  expect(screen.getByText('Poconos trip')).toBeDefined();
  openStage('Past');
  expect(screen.getByText('Old lunch')).toBeDefined();
  expect(calls.filter(({ url }) => url.includes('/v1/plans'))).toHaveLength(1);
});

it('carries exactly the three stage words on the switcher, no counts', async () => {
  stubFetch(
    initialBody({
      needsDate: [needsDateRow(1), needsDateRow(2), needsDateRow(3)],
      upcoming: [plansDay('2026-08-08', [row(4, { time: '19:00' })])],
    }),
  );
  mount();

  await screen.findByTestId('plans-stage-switcher');
  const tabs = screen.getAllByRole('tab');
  // §1.3.2 rules 1 and 2: the heading is the words and nothing else — no `(3)`, no badge.
  expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual([
    'Needs a date',
    'Upcoming',
    'Past',
  ]);
});

it.each(['custom', 'meal', 'watch', 'event'] as const)(
  'renders a %s needs-a-date card with no checkbox and no date chip',
  async (type) => {
    stubFetch(
      initialBody({
        needsDate: [needsDateRow(1, { type, title: 'Undecided plan' })],
      }),
    );
    mount();

    await screen.findByTestId('plans-stage-switcher');
    openStage('Needs a date');
    expect(screen.getByText('Undecided plan')).toBeDefined();
    expect(screen.getByText('No date yet')).toBeDefined();
    // The second line is the RSVP summary, always rendered (§1.3.1).
    expect(screen.getByText('Just you')).toBeDefined();
    expect(screen.queryByRole('checkbox')).toBeNull();
  },
);

it('renders needsDate in exactly the order the server sent, unsorted', async () => {
  stubFetch(
    initialBody({
      needsDate: [
        needsDateRow(3, {
          title: 'Zebra plan',
          lastActivityAt: '2026-08-01T00:00:00.000Z',
        }),
        needsDateRow(1, {
          title: 'Alpha plan',
          lastActivityAt: '2026-08-03T00:00:00.000Z',
        }),
        needsDateRow(2, {
          title: 'Middle plan',
          lastActivityAt: '2026-08-02T00:00:00.000Z',
        }),
      ],
    }),
  );
  mount();

  await screen.findByTestId('plans-stage-switcher');
  openStage('Needs a date');
  const [zebra, alpha, middle] = ['Zebra plan', 'Alpha plan', 'Middle plan'].map(
    (title) => screen.getByText(title),
  );
  if (zebra === undefined || alpha === undefined || middle === undefined) {
    throw new Error('All three fixtures must render.');
  }
  expect(zebra.compareDocumentPosition(alpha) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  expect(alpha.compareDocumentPosition(middle) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

it('renders the suggestion count as card content, never stage chrome', async () => {
  stubFetch(
    initialBody({
      needsDate: [needsDateRow(1, { title: 'Zahav dinner', suggestionCount: 2 })],
    }),
  );
  mount();

  await screen.findByTestId('plans-stage-switcher');
  openStage('Needs a date');
  expect(screen.getByText('No date yet — 2 suggestions')).toBeDefined();
  expect(screen.getByRole('tab', { name: 'Needs a date' }).textContent).toBe(
    'Needs a date',
  );
});

it('shows each empty stage line, and the single No plans state only when all three are empty', async () => {
  const onAdd = vi.fn();
  stubFetch(initialBody());
  mount(() => {}, onAdd);

  await screen.findByTestId('plans-all-empty');
  expect(screen.getByText('No plans')).toBeDefined();
  expect(
    screen.getByText('Add something you want to do, on its own or with someone.'),
  ).toBeDefined();
  expect(screen.queryByTestId('plans-stage-switcher')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect(onAdd).toHaveBeenCalledOnce();
});

it('renders per-stage empty lines when only one stage has content', async () => {
  stubFetch(
    initialBody({
      needsDate: [needsDateRow(1, { title: 'Only undated' })],
    }),
  );
  mount();

  await screen.findByTestId('plans-stage-switcher');
  // Upcoming (the landing stage) is empty: its own §1.3.3 line, with the Add action.
  expect(screen.getByText('No upcoming plans')).toBeDefined();
  expect(screen.getByText('Anything with a date shows up here.')).toBeDefined();
  openStage('Past');
  expect(screen.getByText('Nothing here')).toBeDefined();
  expect(screen.getByText('Plans that have happened show up here.')).toBeDefined();
  openStage('Needs a date');
  expect(screen.getByText('Only undated')).toBeDefined();
});

it('shows the standard retry surface when the initial request fails', async () => {
  stubFailure();
  mount();

  await screen.findByTestId('plans-error', {}, { timeout: 10_000 });
  expect(screen.getByText('Something went wrong.')).toBeDefined();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
}, 15_000);

it('groups Upcoming into day cards with gap lines and sticky month sections', async () => {
  stubFetch(
    initialBody({
      upcoming: [
        plansDay('2026-08-19', [
          row(1, { title: 'Trip start', time: '09:00' }),
          row(2, { title: 'Same-day task', type: 'task', hasCheckbox: true }),
        ]),
        plansDay('2026-08-25', [row(3, { title: 'Later dinner', time: '19:00' })]),
        plansDay('2026-09-03', [row(4, { title: 'September plan', time: '12:00' })]),
      ],
    }),
  );
  mount();

  await screen.findByText('Trip start');
  // One card per day: two rows share the 19 Aug card, and each day has exactly one frame.
  expect(screen.getByTestId('plans-day-2026-08-19')).toBeDefined();
  expect(screen.getByTestId('plans-day-2026-08-25')).toBeDefined();
  expect(
    screen.getByRole('button', { name: 'Aug 20 – 24 · nothing planned' }),
  ).toBeDefined();
  expect(screen.getByRole('heading', { name: 'August 2026' })).toBeDefined();
  expect(screen.getByRole('heading', { name: 'September 2026' })).toBeDefined();
});

it('opens the gap date picker pre-set to the first day without writing anything', async () => {
  const calls = stubFetch(
    initialBody({
      upcoming: [
        plansDay('2026-08-19', [row(1, { time: '09:00' })]),
        plansDay('2026-08-25', [row(2, { time: '19:00' })]),
      ],
    }),
  );
  mount();

  const gap = await screen.findByRole('button', {
    name: 'Aug 20 – 24 · nothing planned',
  });
  const requestsBeforeTap = calls.length;
  fireEvent.click(gap);

  expect(screen.getByTestId('plans-gap-date-picker')).toBeDefined();
  expect(screen.getByText('Thu, Aug 20')).toBeDefined();
  expect(calls).toHaveLength(requestsBeforeTap);
  expect(calls.every(({ method }) => method === 'GET')).toBe(true);
});

it('reaches a far-future plan through the nextFrom sentinel with exactly one window load', async () => {
  const calls = stubFetch(
    initialBody({
      upcomingWindow: {
        from: '2026-08-06',
        through: '2026-10-06',
        nextFrom: '2027-02-10',
      },
    }),
    {
      data: {
        mode: 'upcoming_window',
        upcoming: [
          plansDay('2027-02-10', [row(1, { title: 'Far future', time: '18:00' })]),
        ],
        upcomingWindow: { from: '2027-02-10', through: '2027-04-12', nextFrom: null },
        warnings: [],
      },
      meta: { requestId: 'req_plans_window' },
    },
  );
  mount();

  await screen.findByText('Far future');
  const plansCalls = calls.filter(({ url }) => url.includes('/v1/plans'));
  expect(plansCalls).toHaveLength(2);
  expect(plansCalls[1]?.url).toContain('mode=upcoming_window');
  expect(plansCalls[1]?.url).toContain('upcomingFrom=2027-02-10');
});

it('renders Past de-emphasised under month headings while Needs a date is not', async () => {
  stubFetch(
    initialBody({
      needsDate: [needsDateRow(1, { title: 'Fresh idea' })],
      past: [
        plansDay('2026-08-01', [
          row(2, {
            title: 'Past dinner',
            time: '19:00',
            isPast: true,
            status: 'completed',
          }),
        ]),
        plansDay('2026-07-25', [row(3, { title: 'July trip', isPast: true })]),
      ],
    }),
  );
  mount();

  await screen.findByTestId('plans-stage-switcher');
  openStage('Past');
  await screen.findByText('Past dinner');
  expect(screen.getByRole('heading', { name: 'August' })).toBeDefined();
  expect(screen.getByRole('heading', { name: 'July' })).toBeDefined();
  // De-emphasis is the row's own past treatment: subhead title in muted ink.
  const pastTitle = screen.getByText('Past dinner');
  expect(pastTitle.style.fontSize).toBe('15px');

  openStage('Needs a date');
  const freshTitle = screen.getByText('Fresh idea');
  // The undated card is not aged or de-emphasised (§1.3.2 rule 4): full heading treatment.
  expect(freshTitle.style.fontSize).toBe('16px');
});

it("opens a recurring row's detail with its occurrence scope", async () => {
  const onOpen = vi.fn();
  const occurrence = row(1, {
    type: 'task',
    title: 'Today stand-up',
    occurrenceDate: '2026-08-08',
    isRecurring: true,
    hasCheckbox: true,
    time: '09:00',
  });
  stubFetch(initialBody({ upcoming: [plansDay('2026-08-08', [occurrence])] }));
  mount(onOpen);

  const body = await screen.findByRole('button', { name: /Today stand-up/ });
  fireEvent.click(body);
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(occurrence);
});
