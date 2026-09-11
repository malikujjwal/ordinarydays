import { fixedClock, type Instant } from '@od/shared/time';
import type { AgendaItem } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccessibilityInfo, Animated, Platform, SectionList } from 'react-native';
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

interface LayoutAwareElement extends Element {
  __reactLayoutHandler?: (event: {
    nativeEvent: {
      layout: { x: number; y: number; width: number; height: number };
    };
  }) => void;
}

function reportCalendarHeight(height: number): void {
  const content = screen.getByTestId('plans-calendar')
    .firstElementChild as LayoutAwareElement;
  expect(content.__reactLayoutHandler).toBeTypeOf('function');
  act(() => {
    content.__reactLayoutHandler?.({
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height } },
    });
  });
}

function reportLayout(testID: string, height: number): void {
  const element = screen.getByTestId(testID) as LayoutAwareElement;
  expect(element.__reactLayoutHandler).toBeTypeOf('function');
  act(() => {
    element.__reactLayoutHandler?.({
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height } },
    });
  });
}

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
  const result = render(
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
  return { ...result, client };
}

const openStage = (label: string) =>
  fireEvent.click(screen.getByRole('tab', { name: label }));

afterEach(() => {
  Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('shows the loading state while the initial request is pending', () => {
  vi.stubGlobal('fetch', () => new Promise(() => {}));
  mount();

  expect(screen.getByTestId('plans-loading')).toBeDefined();
  expect(screen.getByRole('progressbar', { name: 'Loading plans' })).toBeDefined();
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

it('reserves only the space needed to land a short final day below the calendar', async () => {
  stubFetch(initialBody({ upcoming: [plansDay('2026-09-04', [row(2)])] }));
  mount();
  await screen.findByTestId('plans-date-2026-09-04');
  reportCalendarHeight(144);
  reportLayout('plans-viewport', 800);
  reportLayout('plans-date-2026-09-04', 160);
  const content = screen.getByTestId('plans-list').firstElementChild as HTMLElement;
  expect(content.style.paddingBottom).toBe('496px');
  // A tall final card already supplies the scroll range; keep only the existing chrome gap.
  reportLayout('plans-date-2026-09-04', 720);
  expect(content.style.paddingBottom).toBe('156px');
});

it('lands a calendar day on that exact Upcoming card', async () => {
  const scrollToLocation = vi
    .spyOn(SectionList.prototype, 'scrollToLocation')
    .mockImplementation(() => undefined);
  stubFetch(
    initialBody({
      upcoming: [
        plansDay('2026-09-03', [row(1, { title: 'September third' })]),
        plansDay('2026-09-04', [row(2, { title: 'September fourth' })]),
      ],
    }),
  );
  mount();

  await screen.findByText('September fourth');
  reportCalendarHeight(144);
  fireEvent.click(screen.getByRole('button', { name: 'Expand calendar' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  fireEvent.click(screen.getByTestId('calendar-cell-2026-09-04'));

  await waitFor(() =>
    expect(scrollToLocation).toHaveBeenCalledWith(
      expect.objectContaining({ sectionIndex: 0, itemIndex: 2, viewOffset: 144 }),
    ),
  );
});

it('updates an active calendar landing when the visible header is remeasured', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1_000);
  const scrollToLocation = vi
    .spyOn(SectionList.prototype, 'scrollToLocation')
    .mockImplementation(() => undefined);
  stubFetch(initialBody({ upcoming: [plansDay('2026-09-04', [row(2)])] }));
  mount();
  await screen.findByTestId('plans-date-2026-09-04');
  reportLayout('plans-header', 544);
  const expand = screen.queryByRole('button', { name: 'Expand calendar' });
  if (expand) fireEvent.click(expand);
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  fireEvent.click(screen.getByTestId('calendar-cell-2026-09-04'));
  expect(scrollToLocation).toHaveBeenLastCalledWith(
    expect.objectContaining({ viewOffset: 544 }),
  );
  reportLayout('plans-header', 158);
  expect(scrollToLocation).toHaveBeenLastCalledWith(
    expect.objectContaining({ viewOffset: 158 }),
  );
  clock.mockReturnValue(1_257);
  reportLayout('plans-header', 200);
  expect(scrollToLocation).toHaveBeenLastCalledWith(
    expect.objectContaining({ viewOffset: 158 }),
  );
});

it('waits for compact chrome measurements instead of combining expanded and compact geometry', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(1_000);
  const scrollToLocation = vi
    .spyOn(SectionList.prototype, 'scrollToLocation')
    .mockImplementation(() => undefined);
  stubFetch(initialBody({ upcoming: [plansDay('2026-09-04', [row(2)])] }));
  mount();
  await screen.findByTestId('plans-date-2026-09-04');
  reportLayout('plans-header', 544);
  reportLayout('plans-compact-chrome', 420);
  const expand = screen.queryByRole('button', { name: 'Expand calendar' });
  if (expand) fireEvent.click(expand);
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  fireEvent.click(screen.getByTestId('calendar-cell-2026-09-04'));
  scrollToLocation.mockClear();
  const list = screen.getByTestId('plans-list');
  Object.defineProperty(list, 'scrollTop', { value: 218, writable: true });
  fireEvent.scroll(list);
  expect(scrollToLocation).not.toHaveBeenCalled();
  reportLayout('plans-compact-chrome', 92);
  expect(scrollToLocation).toHaveBeenLastCalledWith(
    expect.objectContaining({ viewOffset: 143 }),
  );
});

it('does not expand the header on transient zero offsets during a calendar landing', async () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
  vi.spyOn(SectionList.prototype, 'scrollToLocation').mockImplementation(() => undefined);
  stubFetch(initialBody({ upcoming: [plansDay('2026-09-04', [row(2)])] }));
  mount();
  await screen.findByTestId('plans-date-2026-09-04');
  reportLayout('plans-header', 544);
  const expand = screen.queryByRole('button', { name: 'Expand calendar' });
  if (expand) fireEvent.click(expand);
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  fireEvent.click(screen.getByTestId('calendar-cell-2026-09-04'));
  const list = screen.getByTestId('plans-list');
  Object.defineProperty(list, 'scrollTop', { value: 218, writable: true });
  fireEvent.scroll(list);
  expect(screen.getByRole('button', { name: 'Open full calendar' })).toBeDefined();
  list.scrollTop = 0;
  fireEvent.scroll(list);
  expect(screen.getByRole('button', { name: 'Open full calendar' })).toBeDefined();
  now.mockReturnValue(1_257);
  list.scrollTop = 40;
  fireEvent.scroll(list);
  list.scrollTop = 0;
  fireEvent.scroll(list);
  await screen.findByRole('heading', { name: 'Plans' });
});

it('ignores a delayed unmeasured-row failure after the recovery deadline', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1_000);
  let fail:
    | ((info: {
        index: number;
        highestMeasuredFrameIndex: number;
        averageItemLength: number;
      }) => void)
    | undefined;
  vi.spyOn(SectionList.prototype, 'scrollToLocation').mockImplementation(function (
    this: SectionList<unknown>,
  ) {
    fail = this.props.onScrollToIndexFailed;
  });
  const responder = vi.spyOn(SectionList.prototype, 'getScrollResponder');
  stubFetch(initialBody({ upcoming: [plansDay('2026-09-04', [row(2)])] }));
  mount();
  await screen.findByTestId('plans-date-2026-09-04');
  const expand = screen.queryByRole('button', { name: 'Expand calendar' });
  if (expand) fireEvent.click(expand);
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  fireEvent.click(screen.getByTestId('calendar-cell-2026-09-04'));
  expect(fail).toBeTypeOf('function');
  act(() => {
    fail?.({ index: 15, highestMeasuredFrameIndex: 11, averageItemLength: 148 });
    fail?.({ index: 15, highestMeasuredFrameIndex: 12, averageItemLength: 170 });
  });
  expect(responder).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(1_257);
  responder.mockClear();
  act(() => fail?.({ index: 15, highestMeasuredFrameIndex: 11, averageItemLength: 148 }));
  expect(responder).not.toHaveBeenCalled();
});

/**
 * RN 0.86 on device (Expo SDK 57): the list remounted for a calendar date reports its first
 * cell layouts ~250 ms after the tap, and every retry before that fails with nothing measured.
 * A window counted from the tap expired first and stranded the list on its preceding row.
 */
it('keeps a landing alive while a freshly mounted list has measured nothing', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1_000);
  let fail:
    | ((info: {
        index: number;
        highestMeasuredFrameIndex: number;
        averageItemLength: number;
      }) => void)
    | undefined;
  const scrollToLocation = vi
    .spyOn(SectionList.prototype, 'scrollToLocation')
    .mockImplementation(function (this: SectionList<unknown>) {
      fail = this.props.onScrollToIndexFailed;
    });
  stubFetch(initialBody({ upcoming: [plansDay('2026-09-04', [row(2)])] }));
  mount();
  await screen.findByTestId('plans-date-2026-09-04');
  reportLayout('plans-header', 544);
  const expand = screen.queryByRole('button', { name: 'Expand calendar' });
  if (expand) fireEvent.click(expand);
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  fireEvent.click(screen.getByTestId('calendar-cell-2026-09-04'));
  expect(fail).toBeTypeOf('function');
  clock.mockReturnValue(1_130);
  act(() => fail?.({ index: 2, highestMeasuredFrameIndex: 0, averageItemLength: 0 }));
  // Past the tap's window, but the list only now measures its cells: the landing still owns it.
  clock.mockReturnValue(1_300);
  scrollToLocation.mockClear();
  reportLayout('plans-header', 200);
  expect(scrollToLocation).toHaveBeenLastCalledWith(
    expect.objectContaining({ viewOffset: 200 }),
  );
});

it.each(['stage', 'refresh'])(
  'mounts an unmeasured day and clears its anchor on %s',
  async (reset) => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    let failed = false;
    vi.spyOn(SectionList.prototype, 'scrollToLocation').mockImplementation(function (
      this: SectionList<unknown>,
    ) {
      if (failed) return;
      failed = true;
      this.props.onScrollToIndexFailed?.({
        index: 15,
        highestMeasuredFrameIndex: 9,
        averageItemLength: 148,
      });
    });
    const past = [plansDay('2026-08-01', [row(30, { isPast: true })])];
    const body = initialBody({
      upcoming: Array.from({ length: 28 }, (_, i) =>
        plansDay(`2026-09-${String(i + 1).padStart(2, '0')}`, [
          row(i, { title: `Day ${i + 1}` }),
        ]),
      ),
      past,
    });
    stubFetch(body, initialBody({ past }), body);
    const { client } = mount();
    await screen.findByTestId('plans-date-2026-09-01');
    const expand = screen.queryByRole('button', { name: 'Expand calendar' });
    if (expand) fireEvent.click(expand);
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    fireEvent.click(screen.getByTestId('calendar-cell-2026-09-15'));
    await screen.findByTestId('plans-date-2026-09-15');
    expect(screen.queryByTestId('plans-date-2026-09-01')).toBeNull();
    if (reset === 'stage') {
      openStage('Past');
      openStage('Upcoming');
    } else {
      await act(() => client.refetchQueries());
      await screen.findByTestId('plans-upcoming-empty');
      await act(() => client.refetchQueries());
    }
    await screen.findByTestId('plans-date-2026-09-01');
  },
);

it('starts a fresh native landing when the same calendar date is selected again', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  const landedLists: SectionList<unknown>[] = [];
  vi.spyOn(SectionList.prototype, 'scrollToLocation').mockImplementation(function (
    this: SectionList<unknown>,
  ) {
    landedLists.push(this);
  });
  stubFetch(
    initialBody({
      upcoming: Array.from({ length: 20 }, (_, index) =>
        plansDay(`2026-09-${String(index + 1).padStart(2, '0')}`, [row(index)]),
      ),
    }),
  );
  mount();
  await screen.findByTestId('plans-date-2026-09-01');
  const expand = screen.queryByRole('button', { name: 'Expand calendar' });
  if (expand) fireEvent.click(expand);
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  fireEvent.click(screen.getByTestId('calendar-cell-2026-09-15'));
  const firstLandingList = landedLists.at(-1);
  expect(firstLandingList).toBeDefined();
  landedLists.length = 0;
  fireEvent.click(screen.getByTestId('calendar-cell-2026-09-15'));
  await waitFor(() => expect(landedLists.length).toBeGreaterThan(0));
  // A previous native maintained-position anchor must not participate in this new jump.
  expect(landedLists.at(-1) === firstLandingList).toBe(false);
  expect(screen.getByTestId('plans-date-2026-09-15')).toBeDefined();
});

it('lands a calendar day on that exact Past card', async () => {
  const scrollToLocation = vi
    .spyOn(SectionList.prototype, 'scrollToLocation')
    .mockImplementation(() => undefined);
  stubFetch(
    initialBody({
      upcoming: [plansDay('2026-08-08', [row(1)])],
      past: [
        plansDay('2026-08-05', [row(2, { title: 'August fifth', isPast: true })]),
        plansDay('2026-08-04', [row(3, { title: 'August fourth', isPast: true })]),
      ],
    }),
  );
  mount();

  await screen.findByTestId('plans-stage-switcher');
  openStage('Past');
  reportCalendarHeight(136);
  fireEvent.click(screen.getByTestId('calendar-cell-2026-08-04'));

  await waitFor(() =>
    expect(scrollToLocation).toHaveBeenCalledWith(
      expect.objectContaining({ sectionIndex: 0, itemIndex: 2, viewOffset: 136 }),
    ),
  );
});

it('waits for a cold Past date before landing instead of accepting an older loaded row', async () => {
  const scrollToLocation = vi
    .spyOn(SectionList.prototype, 'scrollToLocation')
    .mockImplementation(() => undefined);
  let resolvePastWindow:
    | ((value: {
        ok: boolean;
        status: number;
        headers: { get: () => null };
        json: () => Promise<unknown>;
        text: () => Promise<string>;
      }) => void)
    | undefined;
  vi.stubGlobal('fetch', (url: string) => {
    const body = initialBody({
      upcoming: [plansDay('2026-08-08', [row(1)])],
      past: [plansDay('2026-08-03', [row(2, { title: 'August third', isPast: true })])],
    });
    if (!url.includes('mode=past_window')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    }
    return new Promise((resolve) => {
      resolvePastWindow = resolve;
    });
  });
  mount();

  await screen.findByTestId('plans-stage-switcher');
  openStage('Past');
  fireEvent.click(screen.getByTestId('calendar-cell-2026-08-04'));

  // Aug 3 is present, but it is not the selected date. The selection remains pending while
  // the navigator's bounded Past range is fetched.
  expect(scrollToLocation).not.toHaveBeenCalled();
  await waitFor(() => expect(resolvePastWindow).toBeTypeOf('function'));
  await act(async () => {
    const responseBody = {
      data: {
        mode: 'past_window',
        past: [
          plansDay('2026-08-04', [row(3, { title: 'August fourth', isPast: true })]),
        ],
        pastCoverage: {
          requestedFrom: '2026-07-31',
          requestedThrough: '2026-08-05',
          coveredFrom: '2026-07-31',
          coveredThrough: '2026-08-05',
          complete: true,
        },
        warnings: [],
      },
      meta: { requestId: 'req_past_window' },
    };
    resolvePastWindow?.({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(responseBody),
      text: () => Promise.resolve(JSON.stringify(responseBody)),
    });
    await Promise.resolve();
  });

  await waitFor(() =>
    expect(scrollToLocation).toHaveBeenCalledWith(
      expect.objectContaining({ sectionIndex: 0, itemIndex: 1 }),
    ),
  );
});

it('keeps compact stage and month navigation away from the top without changing scroll position', async () => {
  stubFetch(
    initialBody({
      upcoming: [plansDay('2026-08-08', [row(1)]), plansDay('2026-08-09', [row(2)])],
    }),
  );
  mount();

  const list = await screen.findByTestId('plans-list');
  expect(screen.getByRole('heading', { name: 'Plans' })).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Open full calendar' })).toBeNull();

  Object.defineProperty(list, 'scrollTop', { value: 40, writable: true });
  fireEvent.scroll(list);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Open full calendar' })).toBeDefined(),
  );
  expect(screen.queryByRole('heading', { name: 'Plans' })).toBeNull();
  expect(screen.getByRole('tab', { name: 'Upcoming' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Previous month' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Next month' })).toBeDefined();
  expect(list.scrollTop).toBe(40);
  expect(screen.getByTestId('plans-month-2026-08')).toBeDefined();

  list.scrollTop = 20;
  fireEvent.scroll(list);
  expect(screen.getByRole('button', { name: 'Open full calendar' })).toBeDefined();
  expect(screen.queryByRole('heading', { name: 'Plans' })).toBeNull();
  expect(list.scrollTop).toBe(20);

  list.scrollTop = 0;
  fireEvent.scroll(list);
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Plans' })).toBeDefined(),
  );
  expect(screen.queryByRole('button', { name: 'Open full calendar' })).toBeNull();
  expect(list.scrollTop).toBe(0);
});

it('keeps the compact stage switcher usable and shows no calendar controls for Needs a date', async () => {
  stubFetch(
    initialBody({
      needsDate: [needsDateRow(1, { title: 'Pick a weekend' })],
      upcoming: [plansDay('2026-08-08', [row(2)])],
    }),
  );
  mount();

  const list = await screen.findByTestId('plans-list');
  Object.defineProperty(list, 'scrollTop', { value: 40, writable: true });
  fireEvent.scroll(list);
  await screen.findByRole('button', { name: 'Open full calendar' });
  openStage('Needs a date');

  expect(screen.getByText('Pick a weekend')).toBeDefined();
  expect(screen.getByRole('tab', { name: 'Needs a date' })).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Open full calendar' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Previous month' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Next month' })).toBeNull();
});

it('lands a compact full-calendar day below the complete visible overlay', async () => {
  const scrollToLocation = vi
    .spyOn(SectionList.prototype, 'scrollToLocation')
    .mockImplementation(() => undefined);
  stubFetch(
    initialBody({
      upcoming: [plansDay('2026-08-08', [row(1)])],
    }),
  );
  mount();

  const list = await screen.findByTestId('plans-list');
  Object.defineProperty(list, 'scrollTop', { value: 40, writable: true });
  fireEvent.scroll(list);
  fireEvent.click(await screen.findByRole('button', { name: 'Open full calendar' }));
  await screen.findByTestId('plans-calendar-compact-grid');
  reportLayout('plans-compact-chrome', 88);
  reportLayout('plans-calendar-compact-grid', 200);
  fireEvent.click(screen.getByTestId('calendar-cell-2026-08-08'));

  await waitFor(() =>
    expect(scrollToLocation).toHaveBeenCalledWith(
      expect.objectContaining({ itemIndex: 1, viewOffset: 339 }),
    ),
  );
  expect(list.scrollTop).toBe(40);
});

it('reaches the same full and compact states immediately when reduced motion is enabled', async () => {
  vi.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  const timing = vi.spyOn(Animated, 'timing');
  stubFetch(
    initialBody({
      upcoming: [plansDay('2026-08-08', [row(1)])],
    }),
  );
  mount();

  const list = await screen.findByTestId('plans-list');
  await waitFor(() =>
    expect(timing).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ duration: 0, useNativeDriver: true }),
    ),
  );
  timing.mockClear();

  Object.defineProperty(list, 'scrollTop', { value: 40, writable: true });
  fireEvent.scroll(list);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Open full calendar' })).toBeDefined(),
  );
  expect(screen.queryByRole('heading', { name: 'Plans' })).toBeNull();
  expect(timing).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ duration: 0, useNativeDriver: true }),
  );

  list.scrollTop = 0;
  fireEvent.scroll(list);
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Plans' })).toBeDefined(),
  );
  expect(screen.queryByRole('button', { name: 'Open full calendar' })).toBeNull();
});

it('loads and lands an Upcoming day after November beyond the initial window boundary', async () => {
  const scrollToLocation = vi
    .spyOn(SectionList.prototype, 'scrollToLocation')
    .mockImplementation(() => undefined);
  const calls = stubFetch(
    initialBody({
      upcoming: [plansDay('2026-08-08', [row(1)])],
      upcomingWindow: {
        from: '2026-08-06',
        through: '2026-10-06',
        nextFrom: null,
      },
    }),
    {
      data: {
        mode: 'upcoming_window',
        upcoming: [plansDay('2026-12-02', [row(2, { title: 'December second' })])],
        upcomingWindow: { from: '2026-11-30', through: '2027-01-03', nextFrom: null },
        warnings: [],
      },
      meta: { requestId: 'req_december_window_first_chunk' },
    },
    {
      data: {
        mode: 'upcoming_window',
        upcoming: [
          plansDay('2026-11-02', [row(3, { title: 'Intervening appointment' })]),
        ],
        upcomingWindow: { from: '2026-10-07', through: '2026-11-29', nextFrom: null },
        warnings: [],
      },
      meta: { requestId: 'req_scroll_boundary' },
    },
  );
  mount();

  await screen.findByText('Plan 1');
  const expand = screen.queryByRole('button', { name: 'Expand calendar' });
  if (expand !== null) fireEvent.click(expand);
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  fireEvent.click(screen.getByTestId('calendar-cell-2026-12-02'));

  await screen.findByText('December second');
  await waitFor(() =>
    expect(scrollToLocation).toHaveBeenCalledWith(
      expect.objectContaining({ itemIndex: 1, animated: false }),
    ),
  );
  expect(
    calls
      .filter(({ url }) => url.includes('mode=upcoming_window'))
      .map(({ url }) => {
        const params = new URL(url).searchParams;
        return [params.get('upcomingFrom'), params.get('upcomingTo')];
      }),
  ).toEqual([['2026-11-30', '2027-01-03']]);
  // The date jump itself is bounded. The unknown interval remains reachable through
  // its accessible scrolling boundary, never labelled as an empty year.
  fireEvent.click(screen.getByRole('button', { name: 'Load more dates' }));
  await screen.findByText('Intervening appointment');
  expect(
    calls
      .filter(({ url }) => url.includes('mode=upcoming_window'))
      .map(({ url }) => {
        const query = new URL(url).searchParams;
        return [query.get('upcomingFrom'), query.get('upcomingTo')];
      }),
  ).toEqual([
    ['2026-11-30', '2027-01-03'],
    ['2026-10-07', '2026-11-29'],
  ]);
});

it('keeps an opaque safe-area surface while the Plans header compacts and restores', async () => {
  stubFetch(
    initialBody({
      upcoming: [plansDay('2026-08-08', [row(1)]), plansDay('2026-12-02', [row(2)])],
    }),
  );
  mount();

  const list = await screen.findByTestId('plans-list');
  const backdrop = screen.getByTestId('plans-safe-area-backdrop');
  expect(backdrop).toBeTruthy();

  Object.defineProperty(list, 'scrollTop', { value: 40, writable: true });
  fireEvent.scroll(list);
  await screen.findByRole('button', { name: 'Open full calendar' });
  expect(screen.getByTestId('plans-safe-area-backdrop')).toBe(backdrop);

  list.scrollTop = 0;
  fireEvent.scroll(list);
  await screen.findByRole('heading', { name: 'Plans' });
  expect(screen.getByTestId('plans-safe-area-backdrop')).toBe(backdrop);
});

it('keeps the full calendar grid mounted while compact so restoring at the top cannot flash blank', async () => {
  stubFetch(
    initialBody({
      upcoming: [plansDay('2026-08-08', [row(1)]), plansDay('2026-12-02', [row(2)])],
    }),
  );
  mount();

  const list = await screen.findByTestId('plans-list');
  const grid = screen.getByTestId('plans-calendar-grid');
  Object.defineProperty(list, 'scrollTop', { value: 40, writable: true });
  fireEvent.scroll(list);
  await screen.findByRole('button', { name: 'Open full calendar' });

  expect(screen.getByTestId('plans-calendar-grid')).toBe(grid);

  list.scrollTop = 0;
  fireEvent.scroll(list);
  await screen.findByRole('heading', { name: 'Plans' });
  expect(screen.getByTestId('plans-calendar-grid')).toBe(grid);
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

/**
 * P3-49 — Plans consumes `RowLeading` through the same `AgendaRow` as Today, so the per-type
 * markers land on Upcoming and Past too. Each Plan kind draws its own §5.2 glyph, `custom` is
 * the only diamond, and a dated task keeps the checkbox.
 */
it('renders each Plan kind with its own type marker on Upcoming', async () => {
  stubFetch(
    initialBody({
      upcoming: [
        plansDay('2026-08-08', [
          row(1, {
            title: 'Renew passport',
            time: '09:00',
            type: 'task',
            hasCheckbox: true,
          }),
          row(2, {
            title: 'Chicken tacos',
            time: '19:30',
            type: 'meal',
            hasCheckbox: false,
          }),
          row(3, {
            title: 'Severance finale',
            time: '20:00',
            type: 'watch',
            hasCheckbox: false,
          }),
          row(4, {
            title: 'New York Trip',
            time: '10:00',
            type: 'event',
            hasCheckbox: false,
          }),
          row(5, {
            title: 'Standup with Priya',
            time: '11:00',
            type: 'custom',
            hasCheckbox: false,
          }),
        ]),
      ],
    }),
  );
  mount();

  await screen.findByText('Chicken tacos');
  const glyphs = screen
    .getAllByTestId(/^agenda-leading-marker-/)
    .map((node) => node.getAttribute('data-testid'))
    .sort();
  expect(glyphs).toEqual([
    'agenda-leading-marker-bowl',
    'agenda-leading-marker-diamond',
    'agenda-leading-marker-map-pin',
    'agenda-leading-marker-play-rect',
  ]);
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
});
