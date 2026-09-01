import { fixedClock, type Instant } from '@od/shared/time';
import type { Activity, ActivityDetail, AgendaData, AgendaItem } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockProvider } from '@/hooks/useClock';
import { registerActivityMutationDefaults } from '@/lib/mutationDefaults';
import { createOfflineQueryClient } from '@/lib/queryClient';
import { usePlanActivityFloor } from '@/stores/planActivityFloor';
import { useToast } from '@/stores/toast';
import { ActivityDetailScreen } from './ActivityDetailScreen';

/**
 * `expo-crypto` is a native module with no jsdom implementation, and P1-27's duplicate
 * generates its `Idempotency-Key` from it. Stubbed here rather than globally, the same way
 * the compose tests do it, so the mock is visible in the file that needs it.
 */
vi.mock('expo-crypto', () => ({ randomUUID: () => 'idem-test-key' }));

/**
 * The Activity detail screen (P1-26).
 *
 * The screen is a read of server data, so every case here drives a stubbed `fetch` returning
 * bodies that satisfy the **real shared schemas** — `strictResponses` is on under Vitest, so
 * a fixture that drifted from the contract fails the test rather than rendering.
 */

const TODAY = '2026-08-12';
const ID = 'act_01J0000000000000000000000A';

/**
 * `Record<string, unknown>` rather than `Partial<Activity>`: under
 * `exactOptionalPropertyTypes` an optional property and one that may be `undefined` are
 * different types, so `plan({ schedule: undefined })` — "an undated plan", a case these
 * tests need — is not assignable to `Partial<Activity>`. The result is asserted as `Activity`
 * either way, and the real guarantee is the schema: `strictResponses` is on, so a fixture
 * that drifted from the contract fails at parse rather than rendering.
 */
const plan = (patch: Record<string, unknown> = {}): Activity =>
  ({
    activityId: ID,
    ownerId: 'usr_01J0000000000000000000000B',
    objectKind: 'plan',
    type: 'event',
    status: 'scheduled',
    title: 'Zahav',
    notes: 'Check-in is after 3 PM.',
    schedule: {
      date: '2026-08-14',
      time: '19:00',
      timezone: 'America/New_York',
    },
    location: { label: 'Zahav', address: '237 St James Place' },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    details: { kind: 'event' },
    icsSequence: 0,
    createdAt: '2026-08-08T10:00:00.000Z',
    lastActivityAt: '2026-08-08T10:00:00.000Z',
    updatedAt: '2026-08-08T10:00:00.000Z',
    schemaVersion: 1,
    ...patch,
  }) as Activity;

const task = (patch: Record<string, unknown> = {}): Activity =>
  plan({
    objectKind: 'task',
    type: 'task',
    title: 'Call the dentist',
    details: { kind: 'task' },
    ...patch,
  });

const detailBody = (
  activity: Activity,
  reminders: ActivityDetail['reminders'] = [],
  capabilities: ActivityDetail['capabilities'] = {
    complete: true,
    skip: true,
    snooze: true,
  },
  occurrence?: ActivityDetail['occurrence'],
  completedOccurrenceCount?: number,
  extras: Partial<ActivityDetail> = {},
) => ({
  data: {
    activity,
    capabilities,
    reminders,
    ...(occurrence === undefined ? {} : { occurrence }),
    ...(completedOccurrenceCount === undefined ? {} : { completedOccurrenceCount }),
    ...extras,
  },
  meta: { requestId: 'req_test' },
});

const occurrenceProjection = (
  status: NonNullable<ActivityDetail['occurrence']>['status'] = 'scheduled',
  nominalDate = TODAY,
): NonNullable<ActivityDetail['occurrence']> => ({
  nominalDate,
  date: nominalDate,
  time: '08:00',
  status,
  isSnoozed: false,
});

const reminder = (reminderId: string, offsetMinutes: number) => ({
  reminderId,
  activityId: ID,
  userId: 'usr_01J0000000000000000000000B',
  offsetMinutes,
  channel: 'push' as const,
});

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

const sent: Sent[] = [];

/**
 * `wait` holds a response open until the test releases it. Without it there is no way to
 * assert what the screen shows *while a write is in flight*, which is the whole of an
 * optimistic projection: a test that only checks the settled state passes just as well against
 * a screen that waits for the server.
 */
function stubFetch(
  ...responses: Array<{ status: number; body: unknown; wait?: Promise<unknown> }>
) {
  let call = 0;
  vi.stubGlobal('fetch', async (url: string, init?: Record<string, unknown>) => {
    sent.push({
      url,
      method: (init?.method as string | undefined) ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    const outcome = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (outcome === undefined) throw new Error('no outcome');
    if (outcome.wait !== undefined) await outcome.wait;
    return Promise.resolve({
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      headers: { get: () => null },
      json: () => Promise.resolve(outcome.body),
      text: () => Promise.resolve(JSON.stringify(outcome.body)),
    });
  });
}

function mount(
  onBack = () => {},
  onOpenActivity: (id: string) => void = () => {},
  resolutionOccurrenceDate?: string | null,
  occurrenceDate?: string,
  providedClient?: QueryClient,
) {
  const queryClient =
    providedClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  registerActivityMutationDefaults(queryClient);
  /**
   * A fixed clock, because the snooze sheet's options are computed from the current minute and
   * `useClock` otherwise falls through to the system one — which would make every option label
   * in this file depend on the hour the suite happened to run. `08:10` in the fixture's own zone,
   * ten minutes after the seeded occurrence.
   */
  const wrap = (ui: ReactNode) => (
    <SafeAreaProvider>
      <ClockProvider clock={fixedClock('2026-08-12T12:10:00.000Z' as Instant)}>
        <ThemeProvider scheme="light">
          <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
        </ThemeProvider>
      </ClockProvider>
    </SafeAreaProvider>
  );
  const rendered = render(
    wrap(
      <ActivityDetailScreen
        target={
          occurrenceDate === undefined
            ? { kind: 'activity', activityId: ID }
            : { kind: 'occurrence', activityId: ID, date: occurrenceDate }
        }
        today={TODAY}
        onBack={onBack}
        onOpenActivity={onOpenActivity}
        {...(resolutionOccurrenceDate === undefined ? {} : { resolutionOccurrenceDate })}
      />,
    ),
  );
  return { ...rendered, queryClient };
}

beforeEach(() => {
  sent.length = 0;
  useToast.setState({ current: undefined });
});

afterEach(() => vi.unstubAllGlobals());

const loaded = () =>
  waitFor(() => expect(screen.getByTestId('when-where')).toBeDefined());

/**
 * React Native Web renders a single-line `TextInput` as `<input>` (which carries a `value`
 * attribute) and a multiline one as `<textarea>` (which does not — its value is a property).
 * Reading the property covers both and stops the Notes assertions silently comparing `null`.
 */
const fieldValue = (label: string): string =>
  (screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement).value;

const agendaItem = (): AgendaItem => ({
  activityId: ID,
  type: 'task',
  title: 'Call the dentist',
  status: 'scheduled',
  time: '09:30',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: false, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
});

function agendaStatus(queryClient: QueryClient): string | undefined {
  const agenda = queryClient.getQueryData<AgendaData>(['agenda', 'detail-regression']);
  const day = agenda?.days[0];
  return day === undefined
    ? undefined
    : [...day.schedule, ...day.anytime, ...day.earlier][0]?.status;
}

describe('reading', () => {
  it('shows the header-shaped skeleton while the detail request is pending', () => {
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    mount();

    expect(screen.getByTestId('detail-loading')).toBeDefined();
    expect(screen.queryByLabelText('Title')).toBeNull();
    expect(screen.queryByTestId('detail-complete')).toBeNull();
  });

  it('issues exactly one GET for the screen', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await loaded();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('GET');
    expect(sent[0]?.url).toMatch(new RegExp(`/v1/activities/${ID}$`));
  });

  it('renders the title, compact schedule metadata and collapsed notes', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await loaded();

    expect(fieldValue('Title')).toBe('Zahav');
    expect(screen.getByText('Fri, Aug 14 · 7:00 PM')).toBeDefined();
    expect(screen.getAllByText('Tap to edit')).toHaveLength(1);
    expect(screen.getByText('Does not repeat · No reminder')).toBeDefined();
    expect(
      screen
        .getByTestId('when-where-date')
        .contains(screen.getByText('Does not repeat · No reminder')),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: 'Notes, Check-in is after 3 PM.' }),
    );
    expect(fieldValue('Notes')).toBe('Check-in is after 3 PM.');
  });

  it('uses icon-only header controls with complete accessible names', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await loaded();

    expect(screen.getByRole('button', { name: 'Back' }).textContent).toBe('');
    expect(screen.getByRole('button', { name: 'More' }).textContent).toBe('');
  });

  it('keeps navigation and content in one detail surface', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await loaded();

    const surface = screen.getByTestId('detail-surface');
    expect(surface.contains(screen.getByTestId('detail-navigation'))).toBe(true);
    expect(surface.contains(screen.getByTestId('detail-content'))).toBe(true);
  });

  it('renders capability content as divided, unboxed sections', async () => {
    stubFetch({ status: 200, body: detailBody(task()) });
    mount();
    await loaded();

    // Each row closes itself, so the list ends on its last row rather than needing a rule
    // bolted onto the container — which is what produced two lines with a gap between them.
    expect(screen.getByTestId('section-notes').style.borderBottomWidth).toBe('1px');
    fireEvent.click(
      screen.getByRole('button', { name: 'Notes, Check-in is after 3 PM.' }),
    );
    expect(screen.getByLabelText('Notes').style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(screen.getByTestId('section-related').style.borderBottomWidth).toBe('1px');
  });

  it('puts Notes first and keeps every capability on the same row rhythm', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await loaded();

    const notes = screen.getByTestId('section-notes');
    const reminders = screen.getByTestId('section-reminders');
    const people = screen.getByTestId('section-people');
    expect(
      notes.compareDocumentPosition(reminders) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      reminders.compareDocumentPosition(people) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('says Not scheduled on an undated plan rather than hiding the row', async () => {
    stubFetch({ status: 200, body: detailBody(plan({ schedule: undefined })) });
    mount();
    await loaded();

    expect(screen.getByText('Not scheduled')).toBeDefined();
  });

  /** A shared plan has many reminder sets; the screen shows the caller's and says nothing else. */
  it('renders the reminders the server returned, with no count or hint of others', async () => {
    stubFetch({
      status: 200,
      body: detailBody(plan(), [
        {
          reminderId: 'rem_01J0000000000000000000000C',
          activityId: ID,
          userId: 'usr_01J0000000000000000000000B',
          offsetMinutes: -15,
          channel: 'push',
        },
      ]),
    });
    mount();
    await loaded();

    expect(
      screen.getByText('Does not repeat · Reminder 15 minutes before'),
    ).toBeDefined();
    // The row states the current value; the choices live in the sheet it opens.
    expect(screen.getByTestId('section-reminders').textContent).toContain(
      '15 minutes before',
    );
    fireEvent.click(screen.getByRole('button', { name: /^Reminder/ }));
    expect(
      screen.getByRole('checkbox', { name: 'Remove reminder 15 minutes before' }),
    ).toBeDefined();
  });

  it('hides the reminder row entirely when there is no date to count back from', async () => {
    stubFetch({ status: 200, body: detailBody(plan({ schedule: undefined })) });
    mount();
    await loaded();

    expect(screen.queryByTestId('when-where-reminders')).toBeNull();
    expect(screen.queryByTestId('section-reminders')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Repeat/ })).toBeNull();
  });

  /**
   * `Repeat` is a setting row that **states its value** rather than an `Edit recurrence` row
   * that named an action — which had offered to edit a recurrence on activities whose own
   * summary said `Does not repeat`. Delete stays in the `⋯` menu either way (U6).
   */
  it('states the repeat value in the row list and keeps Delete in the three-dot menu', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await loaded();

    const repeat = screen.getByRole('button', { name: /^Repeat/ });
    expect(screen.getByTestId('detail-sections').contains(repeat)).toBe(true);
    expect(repeat.textContent).toContain('Does not repeat');
    expect(screen.queryByRole('button', { name: 'Edit recurrence' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDefined();
  });

  it('shows the §5.3 failure with a Try again action', async () => {
    stubFetch({
      status: 500,
      body: {
        error: { code: 'internal', message: 'boom', requestId: 'req_failed' },
      },
    });
    mount();

    /**
     * Longer than the default second on purpose: a 5xx is retryable, so the transport makes
     * four attempts with jittered backoff before the query ever sees a failure
     * (`client/http.ts`). That is the behaviour under test as much as the copy is — the
     * screen must not show its error state until the retries are actually exhausted.
     */
    await waitFor(() => expect(screen.getByTestId('detail-error')).toBeDefined(), {
      timeout: 10_000,
    });
    expect(screen.getByText('Something went wrong.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
  });
});

describe('the sections', () => {
  it('announces disclosure state and reveals Notes only after the row is pressed', async () => {
    stubFetch({ status: 200, body: detailBody(task()) });
    mount();
    await loaded();

    const notes = screen.getByRole('button', {
      name: 'Notes, Check-in is after 3 PM.',
    });
    expect(notes.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Notes')).toBeNull();

    fireEvent.click(notes);
    expect(notes.getAttribute('aria-expanded')).toBe('true');
    expect(fieldValue('Notes')).toBe('Check-in is after 3 PM.');

    fireEvent.click(notes);
    expect(screen.queryByLabelText('Notes')).toBeNull();
  });

  /**
   * P2-41 replaces P1-26's disabled affordances with absence.
   *
   * `plans-and-lists.md` §2's collapse rule governs a capability that **exists and is empty**;
   * it does not govern one that is **not built**. A row reading "Sharing is coming soon" is a
   * dead affordance promising something the app cannot do. The four return when the phase that
   * builds them returns them, as real §2 collapsed rows with content behind them.
   */
  /**
   * P3-37's amendment narrowed the pre-build rows: sections that now exist as real content
   * (Prep, Lists, Attachments) render only once populated, so `People` is the one unbuilt
   * capability left with a `Coming later` row on an event plan.
   */
  it('renders the unbuilt People capability as a noninteractive Coming later row', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await loaded();

    expect(screen.getByText('People')).toBeDefined();
    // People, and empty Attachments (its P3-41 flow is unbuilt, so the §2.2 pre-build
    // discovery row stands in for the chip it cannot offer yet).
    expect(screen.getAllByText('Coming later')).toHaveLength(2);
    expect(screen.getByTestId('section-attachments-coming-later')).toBeDefined();
    expect(screen.queryByRole('button', { name: /People/ })).toBeNull();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    // The empty content sections have no headings at all now, not disabled ones.
    expect(screen.queryByText('Preparation')).toBeNull();
    expect(screen.queryByText('Related lists')).toBeNull();
  });

  /**
   * A collapsed row summarises; it does not render the value. Measured before this held: a
   * 1,300-character note produced a 1,465 pt "collapsed" Notes row that pushed `Reminder` and
   * every capability under it off the screen entirely.
   */
  it('summarises a long note in one line rather than rendering it collapsed', async () => {
    const long = 'Lorem ipsum dolor sit amet. '.repeat(50).trim();
    stubFetch({ status: 200, body: detailBody(task({ notes: long })) });
    mount();
    await loaded();

    // React Native Web renders `numberOfLines={1}` as its one-line class rather than an
    // inline clamp, so the assertion is on the resolved rule.
    const summary = screen.getByText(long);
    expect(getComputedStyle(summary).whiteSpace).toBe('nowrap');
    expect(getComputedStyle(summary).textOverflow).toBe('ellipsis');
    // The full text stays in the accessible name — the clamp is visual only.
    expect(
      screen
        .getByRole('button', { name: `Notes, ${long}` })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('previews Ingredients as a noninteractive future row on Meal plans only', async () => {
    stubFetch({
      status: 200,
      body: detailBody(plan({ type: 'meal', details: { kind: 'meal' } })),
    });
    mount();
    await loaded();

    expect(screen.getByText('Ingredients')).toBeDefined();
    expect(screen.getByLabelText(/^Ingredients,.*Coming later$/)).toBeDefined();
    expect(screen.queryByRole('button', { name: /Ingredients/ })).toBeNull();
  });

  /** §5.6: a Task "renders no disabled placeholders for anything it lacks". */
  it('renders no placeholders at all on a Task', async () => {
    stubFetch({ status: 200, body: detailBody(task()) });
    mount();
    await loaded();

    expect(screen.queryByText('Add people')).toBeNull();
    expect(screen.queryByText('Add prep task')).toBeNull();
    expect(screen.queryByText('Add list')).toBeNull();
    expect(screen.getByTestId('section-related')).toBeDefined();
  });
});

describe('caller-owned reminders', () => {
  it('adds a reminder with a fresh idempotency key and updates the open row', async () => {
    const added = reminder('rem_01J0000000000000000000000C', -15);
    stubFetch(
      { status: 200, body: detailBody(plan()) },
      { status: 201, body: { data: added, meta: { requestId: 'req_reminder' } } },
      { status: 200, body: detailBody(plan(), [added]) },
    );
    mount();
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /^Reminder/ }));
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Add reminder 15 minutes before' }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole('checkbox', { name: 'Remove reminder 15 minutes before' }),
      ).toBeDefined(),
    );
    const request = sent.find((entry) => entry.method === 'POST');
    expect(request?.url).toMatch(new RegExp(`/v1/activities/${ID}/reminders$`));
    expect(request?.body).toEqual({ offsetMinutes: -15 });
    expect(request?.headers['Idempotency-Key']).toBe('idem-test-key');
  });

  it('removes only the selected caller-owned reminder', async () => {
    const existing = reminder('rem_01J0000000000000000000000C', -15);
    stubFetch(
      { status: 200, body: detailBody(plan(), [existing]) },
      {
        status: 200,
        body: {
          data: { reminderId: existing.reminderId },
          meta: { requestId: 'req_reminder' },
        },
      },
      { status: 200, body: detailBody(plan()) },
    );
    mount();
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /^Reminder/ }));
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Remove reminder 15 minutes before' }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole('checkbox', { name: 'Remove reminder 15 minutes before' }),
      ).toBeNull(),
    );
    expect(sent.find((entry) => entry.method === 'DELETE')?.url).toMatch(
      new RegExp(`/v1/activities/${ID}/reminders/${existing.reminderId}$`),
    );
  });

  it('stops at three reminders and explains the limit', async () => {
    stubFetch({
      status: 200,
      body: detailBody(plan(), [
        reminder('rem_01J0000000000000000000000C', -5),
        reminder('rem_01J0000000000000000000000D', -15),
        reminder('rem_01J0000000000000000000000E', -60),
      ]),
    });
    mount();
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /^Reminder/ }));
    expect(screen.getByText('You can add up to 3 reminders.')).toBeDefined();
    expect(
      screen
        .getByRole('checkbox', { name: 'Add reminder At the time' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('offers only whole-day offsets when the Activity has no time', async () => {
    stubFetch({
      status: 200,
      body: detailBody(
        plan({ schedule: { date: '2026-08-14', timezone: 'America/New_York' } }),
      ),
    });
    mount();
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /^Reminder/ }));
    expect(
      screen.getByRole('checkbox', { name: 'Add reminder On the day' }),
    ).toBeDefined();
    expect(
      screen.getByRole('checkbox', { name: 'Add reminder 1 day before' }),
    ).toBeDefined();
    expect(screen.queryByRole('checkbox', { name: /15 minutes/ })).toBeNull();
  });

  /**
   * The choices open in a sheet over the screen, not inline — expanded in place they pushed
   * every capability below them down the page.
   *
   * **The sheet owns the bound, not this screen.** `Sheet`'s `medium` detent scrolls the body
   * internally (§6.1); `ReminderSheet` used to set its own `maxHeight`, which is the ownership
   * violation that let `Repeat` occupy most of a phone.
   */
  it('opens reminder choices in a sheet the sheet itself bounds', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await loaded();

    expect(screen.queryByTestId('reminder-menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Reminder/ }));
    const sheet = screen.getByTestId('reminder-sheet');
    expect(sheet.style.height).toBe('58%');
    expect(screen.getByTestId('reminder-menu').style.maxHeight).toBe('');
    expect(screen.getByTestId('reminder-sheet-body')).toBeDefined();
    expect(screen.getAllByRole('checkbox')).toHaveLength(8);
  });
});

describe('passed-plan resolution', () => {
  it('crosses the Today task off before the detail completion request settles', async () => {
    const scheduled = task();
    const completed = task({ status: 'completed', outcome: 'done' });
    stubFetch({ status: 200, body: detailBody(scheduled) });
    const { queryClient } = mount();
    await loaded();
    queryClient.setQueryData<AgendaData>(['agenda', 'detail-regression'], {
      days: [{ date: '2026-08-13', schedule: [agendaItem()], anytime: [], earlier: [] }],
      warnings: [],
    });

    let finish: ((response: object) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      () =>
        new Promise<object>((resolve) => {
          finish = resolve;
        }),
    );

    fireEvent.click(screen.getByTestId('detail-complete'));

    expect(agendaStatus(queryClient)).toBe('completed');
    finish?.({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () =>
        Promise.resolve({
          data: { activity: completed, outcome: 'done' },
          meta: { requestId: 'req_complete' },
        }),
      text: () =>
        Promise.resolve(
          JSON.stringify({
            data: { activity: completed, outcome: 'done' },
            meta: { requestId: 'req_complete' },
          }),
        ),
    });
    await waitFor(() => expect(screen.getByTestId('detail-undo')).toBeDefined());
  });

  it('shows the prompt in the primary-action position and sends the exact positive outcome', async () => {
    const passed = plan({
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
    });
    stubFetch(
      { status: 200, body: detailBody(passed) },
      {
        status: 200,
        body: {
          data: {
            activity: plan({ ...passed, status: 'completed', outcome: 'attended' }),
            outcome: 'attended',
          },
          meta: { requestId: 'req_resolution' },
        },
      },
    );
    mount(
      () => {},
      () => {},
      null,
    );
    await loaded();

    const prompt = screen.getByRole('button', {
      name: 'How did it go? Choose an outcome for Zahav',
    });
    const title = screen.getByLabelText('Title');
    const schedule = screen.getByTestId('when-where');
    const sections = screen.getByTestId('detail-sections');
    expect(title.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      schedule.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      prompt.compareDocumentPosition(sections) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // `plans-and-lists.md` §2.1 replaces the ordinary completion action with this prompt.
    // Two positive actions in the header can target different scopes on a recurring Plan.
    expect(screen.queryByTestId('detail-complete')).toBeNull();

    fireEvent.click(prompt);
    fireEvent.click(screen.getByRole('button', { name: 'Attended' }));

    await waitFor(() =>
      expect(sent.filter((entry) => entry.method === 'POST')).toHaveLength(1),
    );
    expect(sent[1]?.url).toMatch(new RegExp(`/v1/activities/${ID}/complete$`));
    expect(sent[1]?.body).toEqual({ outcome: 'attended' });
    expect(screen.queryByTestId('detail-resolution-prompt')).toBeNull();
  });

  it('hides the prompt from a caller without authority', async () => {
    const recurring = plan({
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TODAY, time: '08:00' }],
      },
    });
    stubFetch({
      status: 200,
      body: detailBody(recurring, [], {
        complete: false,
        skip: false,
        snooze: false,
      }),
    });
    mount(
      () => {},
      () => {},
      TODAY,
    );
    await loaded();

    expect(screen.queryByTestId('detail-resolution-prompt')).toBeNull();
  });

  it('hides the prompt when an older cached detail has no capabilities projection', async () => {
    const passed = plan({
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
    });
    stubFetch({
      status: 200,
      body: {
        data: { activity: passed, reminders: [] },
        meta: { requestId: 'req_cached_detail' },
      },
    });
    mount(
      () => {},
      () => {},
      null,
    );
    await loaded();

    expect(screen.queryByTestId('detail-resolution-prompt')).toBeNull();
  });

  it('preserves occurrence scope for a recurring negative outcome', async () => {
    const recurring = plan({
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TODAY, time: '08:00' }],
      },
    });
    stubFetch(
      {
        status: 200,
        body: detailBody(recurring, [], undefined, occurrenceProjection()),
      },
      {
        status: 200,
        body: {
          data: { activity: recurring, occurrenceDate: TODAY, outcome: 'didnt_go' },
          meta: { requestId: 'req_resolution' },
        },
      },
    );
    mount(
      () => {},
      () => {},
      TODAY,
      TODAY,
    );
    await loaded();

    fireEvent.click(screen.getByTestId('detail-resolution-prompt'));
    fireEvent.click(screen.getByRole('button', { name: "Didn't go" }));

    await waitFor(() =>
      expect(sent.filter((entry) => entry.method === 'POST')).toHaveLength(1),
    );
    expect(sent[1]?.body).toEqual({ occurrenceDate: TODAY, outcome: 'didnt_go' });
    /**
     * Resolving one occurrence must not leave the screen blank.
     *
     * An `Occurrence` override never moves `ACT#/META`, so the series row still reads
     * `scheduled` and nothing derived from it can show the outcome. Before this, the prompt
     * left and nothing replaced it: no completion button, no outcome, no Undo — the user had
     * recorded something the screen then refused to admit.
     */
    expect(screen.queryByTestId('detail-complete')).toBeNull();
    expect(screen.getByTestId('detail-undo')).toBeDefined();
  });

  it('keeps the completion action occurrence-scoped after the route clears the marker', async () => {
    const recurring = plan({
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TODAY, time: '08:00' }],
      },
    });
    stubFetch(
      {
        status: 200,
        body: detailBody(recurring, [], undefined, occurrenceProjection()),
      },
      {
        status: 200,
        body: {
          data: { activity: recurring, occurrenceDate: TODAY, outcome: 'attended' },
          meta: { requestId: 'req_resolution' },
        },
      },
    );
    mount(
      () => {},
      () => {},
      undefined,
      TODAY,
    );
    await loaded();

    expect(screen.queryByTestId('detail-resolution-prompt')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Attended' }));

    await waitFor(() =>
      expect(sent.filter((entry) => entry.method === 'POST')).toHaveLength(1),
    );
    // The occurrence, never the series.
    expect(sent[1]?.body).toEqual({ occurrenceDate: TODAY, outcome: 'attended' });
  });

  /**
   * A series reached without navigation context offers **nothing**.
   *
   * This used to fall back to the schedule line's date, on the reasoning that it is the only
   * occurrence the user can be said to be looking at. It is the series *anchor*, not the day on
   * screen, so a series-only route completed an anchor day that may be months back while the
   * occurrence the user meant never moved. A series detail without an explicit occurrence
   * therefore offers no completion control.
   */
  it('offers no completion control on a series with no occurrence in scope', async () => {
    const recurring = plan({
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TODAY, time: '19:00' }],
      },
    });
    stubFetch({ status: 200, body: detailBody(recurring) });
    mount();
    await loaded();

    expect(screen.queryByTestId('detail-complete')).toBeNull();
    expect(screen.queryByTestId('detail-resolution-prompt')).toBeNull();
    expect(sent.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });

  it('offers no Complete control before a future recurring occurrence reaches its day', async () => {
    const future = '2026-08-13';
    const recurring = task({
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TODAY, time: '08:00' }],
      },
    });
    stubFetch({
      status: 200,
      body: detailBody(
        recurring,
        [],
        undefined,
        occurrenceProjection('scheduled', future),
      ),
    });
    mount(
      () => {},
      () => {},
      undefined,
      future,
    );
    await loaded();

    expect(screen.queryByTestId('detail-complete')).toBeNull();
    expect(sent.filter((entry) => entry.method === 'POST')).toHaveLength(0);
  });

  it('keeps Undo available for an existing future occurrence completion', async () => {
    const future = '2026-08-13';
    const recurring = task({
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TODAY, time: '08:00' }],
      },
    });
    stubFetch({
      status: 200,
      body: detailBody(
        recurring,
        [],
        undefined,
        occurrenceProjection('completed_occurrence', future),
      ),
    });
    mount(
      () => {},
      () => {},
      undefined,
      future,
    );
    await loaded();

    expect(screen.queryByTestId('detail-complete')).toBeNull();
    expect(screen.getByTestId('detail-undo')).toBeDefined();
  });

  /**
   * The prompt replaces the primary action, so it carries the primary action's anatomy.
   *
   * As a `Chip` it rendered `radius.pill`, `footnote` and `surfaceSunken` at hug width, and a
   * passed plan's only offer was a small grey pill under the schedule — which §7.5 does not put
   * at the top of a screen.
   */
  it('offers the passed-plan prompt in place of the completion button, and it opens the sheet', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount(
      () => {},
      () => {},
      TODAY,
      TODAY,
    );
    await loaded();

    // It replaces the primary action rather than sitting beside it.
    expect(screen.queryByTestId('detail-complete')).toBeNull();
    const prompt = screen.getByTestId('detail-resolution-prompt');
    expect(prompt.textContent).toContain('How did it go?');

    fireEvent.click(prompt);
    expect(screen.getByTestId('passed-plan-resolution-sheet')).toBeDefined();
  });

  /** A cold occurrence detail reads completion from its own authoritative projection. */
  it('opens an already-completed occurrence showing Undo without an agenda cache', async () => {
    const recurring = plan({
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TODAY, time: '08:00' }],
      },
    });
    stubFetch({
      status: 200,
      body: detailBody(
        recurring,
        [],
        undefined,
        occurrenceProjection('completed_occurrence'),
      ),
    });
    // Arriving from a Today or Plans occurrence row carries the explicit date.
    mount(
      () => {},
      () => {},
      undefined,
      TODAY,
    );
    await loaded();

    await waitFor(() => expect(screen.getByTestId('detail-undo')).toBeDefined());
    expect(screen.queryByTestId('detail-complete')).toBeNull();
  });
});

describe('U4 — tapping a date opens the reschedule sheet', () => {
  it('opens the sheet and never edits the row in place', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await loaded();

    fireEvent.click(screen.getByTestId('when-where-date'));

    expect(screen.getByTestId('reschedule-sheet')).toBeDefined();
    // The date row is a button, not a field. It did not become editable.
    expect(screen.queryByRole('textbox', { name: /Fri, Aug 14/ })).toBeNull();
  });

  it('writes nothing from the tap itself (rule 6)', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await loaded();

    fireEvent.click(screen.getByTestId('when-where-date'));

    expect(sent.filter((s) => s.method !== 'GET')).toHaveLength(0);
  });

  it('posts to the sole schedule path when a quick chip is chosen', async () => {
    stubFetch(
      { status: 200, body: detailBody(plan()) },
      {
        status: 200,
        body: { data: { activity: plan() }, meta: { requestId: 'req_test' } },
      },
    );
    mount();
    await loaded();

    fireEvent.click(screen.getByTestId('when-where-date'));
    fireEvent.click(screen.getByTestId('quick-date-tomorrow'));

    await waitFor(() => expect(sent.filter((s) => s.method === 'POST')).toHaveLength(1));
    const schedule = sent.find((s) => s.method === 'POST');
    expect((schedule?.body as { date?: string } | undefined)?.date).toBe('2026-08-13');
    expect(schedule?.url).toMatch(new RegExp(`/v1/activities/${ID}/schedule$`));
    expect(schedule?.headers['Idempotency-Key']).toBe('idem-test-key');
    expect(sent.filter((s) => s.method === 'PATCH')).toHaveLength(0);
  });

  it('adds a time to a newly created untimed occurrence with explicit scope', async () => {
    const recurring = plan({
      schedule: { date: TODAY, timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TODAY, interval: 1 }],
      },
    });
    const occurrence = {
      nominalDate: TODAY,
      date: TODAY,
      status: 'scheduled' as const,
      isSnoozed: false,
    };
    stubFetch(
      { status: 200, body: detailBody(recurring, [], undefined, occurrence) },
      {
        status: 200,
        body: {
          data: {
            activity: recurring,
            occurrence: { ...occurrence, time: '10:30' },
          },
          meta: { requestId: 'req_test' },
        },
      },
    );
    mount(
      () => {},
      () => {},
      undefined,
      TODAY,
    );
    await loaded();

    expect(screen.getByTestId('detail-complete')).toBeDefined();
    fireEvent.click(screen.getByTestId('when-where-date'));
    fireEvent.click(screen.getByRole('button', { name: 'Set a time' }));
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    // P2-42: the scope is chosen after the edit, carrying it into the question.
    fireEvent.click(screen.getByRole('button', { name: 'This occurrence only' }));

    await waitFor(() => expect(sent.filter((s) => s.method === 'POST')).toHaveLength(1));
    expect(sent.find((s) => s.method === 'POST')).toMatchObject({
      url: expect.stringMatching(new RegExp(`/v1/activities/${ID}/schedule$`)),
      body: {
        date: TODAY,
        time: '10:30',
        timezone: 'America/New_York',
        occurrenceDate: TODAY,
      },
    });
    await waitFor(() =>
      expect(screen.getByTestId('when-where-date').textContent).toContain('10:30'),
    );
  });

  it('clears through POST /schedule and never PATCH', async () => {
    stubFetch(
      { status: 200, body: detailBody(plan()) },
      {
        status: 200,
        body: {
          data: { activity: plan({ schedule: undefined, status: 'saved' }) },
          meta: { requestId: 'req_test' },
        },
      },
    );
    mount();
    await loaded();

    fireEvent.click(screen.getByTestId('when-where-date'));
    fireEvent.click(screen.getByTestId('reschedule-clear'));

    await waitFor(() => expect(sent.filter((s) => s.method === 'POST')).toHaveLength(1));
    expect(sent.find((s) => s.method === 'POST')?.body).toEqual({ date: null });
    expect(sent.filter((s) => s.method === 'PATCH')).toHaveLength(0);
  });
});

describe('editing in place', () => {
  it('targets the selected future occurrence when changing frequency', async () => {
    const selectedDate = '2026-08-13';
    const current = task({
      schedule: { date: '2026-08-01', time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01', time: '08:00' }],
      },
    });
    const changed = task({
      ...current,
      updatedAt: '2026-08-12T12:00:00.000Z',
      recurrence: {
        mode: 'fixed',
        segments: [
          { freq: 'daily', effectiveFrom: '2026-08-01', time: '08:00' },
          { freq: 'weekdays', effectiveFrom: selectedDate, time: '08:00' },
        ],
      },
    });
    stubFetch(
      {
        status: 200,
        body: detailBody(current, [], undefined, {
          ...occurrenceProjection(),
          nominalDate: selectedDate,
          date: selectedDate,
        }),
      },
      { status: 200, body: { data: changed, meta: { requestId: 'req_patch' } } },
    );
    mount(
      () => {},
      () => {},
      undefined,
      selectedDate,
    );
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /^Repeat/ }));
    fireEvent.change(screen.getByTestId('repeat-option'), {
      target: { value: 'weekdays' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply repeat' }));

    await waitFor(() =>
      expect(sent.filter((request) => request.method === 'PATCH')).toHaveLength(1),
    );
    expect(sent.find((entry) => entry.method === 'PATCH')?.body).toEqual({
      recurrence: changed.recurrence,
      editedFromDate: selectedDate,
    });
  });

  it('applies a same-day repeat correction to an existing series and refreshes detail', async () => {
    const current = plan({
      schedule: {
        date: TODAY,
        time: '19:00',
        timezone: 'America/New_York',
      },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', interval: 1, effectiveFrom: TODAY, time: '19:00' }],
      },
    });
    const corrected = plan({
      ...current,
      updatedAt: '2026-08-12T12:00:00.000Z',
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'weekdays', effectiveFrom: TODAY, time: '19:00' }],
      },
    });
    stubFetch(
      { status: 200, body: detailBody(current) },
      { status: 200, body: { data: corrected, meta: { requestId: 'req_patch' } } },
    );
    mount();
    await loaded();

    expect(screen.getByText('Repeats daily · No reminder')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /^Repeat/ }));
    fireEvent.change(screen.getByTestId('repeat-option'), {
      target: { value: 'weekdays' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply repeat' }));

    await waitFor(() =>
      expect(sent.filter((request) => request.method === 'PATCH')).toHaveLength(1),
    );
    const request = sent.find((entry) => entry.method === 'PATCH');
    expect(request?.body).toEqual({
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'weekdays', effectiveFrom: TODAY, time: '19:00' }],
      },
    });
    await waitFor(() =>
      expect(screen.getByText('Repeats every weekday · No reminder')).toBeDefined(),
    );
  });

  it('keeps a one-off completion occurrence-scoped when Repeat turns it into a series', async () => {
    const current = task({
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
    });
    const recurring = task({
      ...current,
      updatedAt: '2026-08-12T12:00:00.000Z',
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TODAY, time: '08:00' }],
      },
    });
    stubFetch(
      { status: 200, body: detailBody(current) },
      { status: 200, body: { data: recurring, meta: { requestId: 'req_patch' } } },
      {
        status: 200,
        body: {
          data: { activity: recurring, occurrenceDate: TODAY, outcome: 'done' },
          meta: { requestId: 'req_complete' },
        },
      },
    );
    mount();
    await loaded();

    expect(screen.getByTestId('detail-complete')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /^Repeat/ }));
    fireEvent.change(screen.getByTestId('repeat-option'), {
      target: { value: 'daily' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply repeat' }));

    await waitFor(() =>
      expect(screen.getByText('Repeats daily · No reminder')).toBeDefined(),
    );
    fireEvent.click(screen.getByTestId('detail-complete'));

    await waitFor(() =>
      expect(sent.filter((request) => request.method === 'POST')).toHaveLength(1),
    );
    expect(sent.find((request) => request.method === 'POST')).toMatchObject({
      url: expect.stringMatching(new RegExp(`/v1/activities/${ID}/complete$`)),
      body: { occurrenceDate: TODAY, outcome: 'done' },
    });
  });

  it('converts Does not repeat through the selected-occurrence operation', async () => {
    const current = task({
      schedule: { date: '2026-08-01', time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01', time: '08:00' }],
      },
    });
    const converted = task({
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
      updatedAt: '2026-08-12T12:00:00.000Z',
    });
    stubFetch(
      { status: 200, body: detailBody(current, [], undefined, occurrenceProjection()) },
      { status: 200, body: { data: converted, meta: { requestId: 'req_convert' } } },
    );
    const onOpenActivity = vi.fn();
    mount(() => {}, onOpenActivity, undefined, TODAY);
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /^Repeat/ }));
    fireEvent.change(screen.getByTestId('repeat-option'), {
      target: { value: 'never' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply repeat' }));

    await waitFor(() =>
      expect(
        sent.filter((request) =>
          request.url.endsWith(`/v1/activities/${ID}/recurrence/convert`),
        ),
      ).toHaveLength(1),
    );
    expect(sent.find((request) => request.method === 'POST')).toMatchObject({
      body: { occurrenceDate: TODAY },
      headers: { 'Idempotency-Key': 'idem-test-key' },
    });
    await waitFor(() => expect(onOpenActivity).toHaveBeenCalledWith(ID));
  });

  it('commits the title on blur with If-Match, and no Save button exists', async () => {
    stubFetch(
      { status: 200, body: detailBody(plan()) },
      {
        status: 200,
        body: { data: plan({ title: 'Zahav, 7pm' }), meta: { requestId: 'req_test' } },
      },
    );
    mount();
    await loaded();

    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();

    const title = screen.getByLabelText('Title');
    fireEvent.change(title, { target: { value: 'Zahav, 7pm' } });
    fireEvent.blur(title);

    await waitFor(() => expect(sent.filter((s) => s.method === 'PATCH')).toHaveLength(1));
    const patch = sent.find((s) => s.method === 'PATCH');
    expect(patch?.body).toEqual({ title: 'Zahav, 7pm' });
    expect(patch?.headers['If-Match']).toBe('2026-08-08T10:00:00.000Z');
  });

  /**
   * Without this, tabbing through the screen would issue a PATCH per field — each moving
   * `updatedAt` and each a fresh chance to collide with somebody else's edit.
   */
  it('writes nothing when a field is blurred unchanged', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await loaded();

    fireEvent.blur(screen.getByLabelText('Title'));

    expect(sent.filter((s) => s.method === 'PATCH')).toHaveLength(0);
  });
});

describe('a 409 conflict', () => {
  /**
   * The full §6.1 path: the PATCH conflicts, the client refetches, re-applies the pending
   * edit because the other person changed a different field, and says so.
   */
  it('refetches, re-applies a non-overlapping edit, and shows the banner', async () => {
    stubFetch(
      { status: 200, body: detailBody(plan()) },
      {
        status: 409,
        body: { error: { code: 'conflict', message: 'stale', requestId: 'req_c' } },
      },
      {
        status: 200,
        body: detailBody(
          plan({ notes: 'they changed this', updatedAt: '2026-08-08T11:00:00.000Z' }),
        ),
      },
      {
        status: 200,
        body: {
          data: plan({ title: 'Mine', updatedAt: '2026-08-08T11:05:00.000Z' }),
          meta: { requestId: 'req_test' },
        },
      },
    );
    mount();
    await loaded();

    const title = screen.getByLabelText('Title');
    fireEvent.change(title, { target: { value: 'Mine' } });
    fireEvent.blur(title);

    await waitFor(() => expect(screen.getByTestId('detail-conflict')).toBeDefined());
    expect(screen.getByText('This plan changed. Review the update.')).toBeDefined();

    // The re-applied PATCH carries the refetched version, not the stale one.
    const patches = sent.filter((s) => s.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[1]?.headers['If-Match']).toBe('2026-08-08T11:00:00.000Z');
  });

  it('drops an overlapping edit and names the field', async () => {
    stubFetch(
      { status: 200, body: detailBody(plan()) },
      {
        status: 409,
        body: { error: { code: 'conflict', message: 'stale', requestId: 'req_c' } },
      },
      {
        status: 200,
        body: detailBody(
          plan({ title: 'Their title', updatedAt: '2026-08-08T11:00:00.000Z' }),
        ),
      },
    );
    mount();
    await loaded();

    const title = screen.getByLabelText('Title');
    fireEvent.change(title, { target: { value: 'My title' } });
    fireEvent.blur(title);

    await waitFor(() => expect(screen.getByTestId('detail-conflict')).toBeDefined());
    expect(screen.getByText('Your change to Title was not applied.')).toBeDefined();

    // One PATCH only — nothing was re-applied, so nothing was re-sent.
    expect(sent.filter((s) => s.method === 'PATCH')).toHaveLength(1);
    // The field shows the other person's value, not the dropped one.
    await waitFor(() => expect(fieldValue('Title')).toBe('Their title'));
  });
});

describe('the overflow menu', () => {
  it('offers Change Plan kind and Change to Task on an unblocked Plan', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(screen.getByRole('button', { name: 'Change Plan kind' })).toBeDefined();
    expect(
      screen
        .getByRole('button', { name: 'Change to Task' })
        .getAttribute('aria-disabled'),
    ).toBeNull();
    expect(screen.queryByTestId('overflow-blocked')).toBeNull();
  });

  it('blocks Change to Task and names what must be removed first', async () => {
    stubFetch({
      status: 200,
      body: detailBody(plan({ participantCount: 2, childCount: 1 })),
    });
    mount();
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(
      screen
        .getByRole('button', { name: 'Change to Task' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      screen.getByText('Remove 2 people and 1 prep task before changing this to a Task.'),
    ).toBeDefined();
  });

  it('offers Change to Plan on a Task and no Plan-kind row', async () => {
    stubFetch({ status: 200, body: detailBody(task()) });
    mount();
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(screen.getByRole('button', { name: 'Change to Plan' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Change Plan kind' })).toBeNull();
  });

  /**
   * P1-26 deferred the completion button; `phase-01-activity-core.md`'s out-of-scope table
   * routed it to **Phase 2**, and no Phase 2 task claimed it until P2-41. So this assertion is
   * inverted rather than deleted: the button exists, and it renders the verb this type
   * completes with.
   */
  it.each([
    ['task', 'Complete', 'done'],
    ['meal', 'Had it', 'had_it'],
    ['watch', 'Watched', 'watched'],
    ['event', 'Attended', 'attended'],
    ['custom', 'Done', 'done'],
  ] as const)(
    'renders the %s completion verb "%s" and sends outcome "%s"',
    async (type, verb, outcome) => {
      // `details.kind` is the discriminator and has to move with `type`, and only a Task carries
      // `objectKind: 'task'` — a Plan is never of type `task`. `watch` additionally requires a
      // `mediaTitle`, so its details are not a bare `kind`.
      const details =
        type === 'watch' ? { kind: 'watch', mediaTitle: 'Severance' } : { kind: type };
      const activity = type === 'task' ? task() : plan({ type, details });
      const completed = { ...activity, status: 'completed', outcome } as Activity;
      stubFetch(
        { status: 200, body: detailBody(activity) },
        {
          status: 200,
          body: {
            data: { activity: completed, outcome },
            meta: { requestId: 'req_completion' },
          },
        },
      );
      mount();
      await loaded();

      const button = screen.getByRole('button', { name: verb });
      expect(button).toBe(screen.getByTestId('detail-complete'));
      /**
       * `radius.md` — the frames' filled control is a soft rectangle, not a pill. At `xl` on a
       * 52 pt button the corners meet in the middle and it read as a lozenge; the founder's
       * 2026-08-13 refinement asking for `xl` predates the frames being taken as the reference
       * for what a control looks like. Raised in the PR.
       */
      expect(button.style.borderTopLeftRadius).toBe('12px');
      expect(button.style.borderBottomRightRadius).toBe('12px');
      // The frames put no glow under any filled control, in either palette.
      expect(button.style.boxShadow).toBe('');
      fireEvent.click(button);

      await waitFor(() =>
        expect(sent.filter((entry) => entry.method === 'POST')).toHaveLength(1),
      );
      expect(sent[1]?.url).toMatch(new RegExp(`/v1/activities/${ID}/complete$`));
      expect(sent[1]?.body).toEqual({ outcome });
    },
  );

  /**
   * §4.1: "a plan you did not create carries no completion control". **Absent, not disabled** —
   * and driven by the server's capability rather than an owner id the client re-derives.
   */
  /**
   * A completed row on Today keeps its `Undo` swipe action for as long as it is completed, so
   * the one surface that can *record* a completion has to be able to reverse one. The toast is
   * a six-second shortcut, not the mechanism.
   */
  it('offers a permanent Undo once the activity is completed', async () => {
    stubFetch(
      {
        status: 200,
        body: detailBody(plan({ status: 'completed', outcome: 'attended' })),
      },
      {
        status: 200,
        body: {
          data: { activity: plan() },
          meta: { requestId: 'req_undo' },
        },
      },
    );
    mount();
    await loaded();

    expect(screen.queryByTestId('detail-complete')).toBeNull();
    expect(screen.getByTestId('detail-resolved').textContent).toContain('Attended');
    const unrelatedToast = useToast.getState().show({ message: 'Saved another item' });

    fireEvent.click(screen.getByTestId('detail-undo'));

    await waitFor(() =>
      expect(sent.filter((entry) => entry.method === 'POST')).toHaveLength(1),
    );
    expect(sent[1]?.url).toMatch(new RegExp(`/v1/activities/${ID}/uncomplete$`));
    expect(useToast.getState().current?.id).toBe(unrelatedToast);
  });

  it('removes its stale toast shortcut when permanent Undo reverses a fresh completion', async () => {
    const scheduled = plan();
    const completed = plan({ status: 'completed', outcome: 'attended' });
    stubFetch(
      { status: 200, body: detailBody(scheduled) },
      {
        status: 200,
        body: {
          data: { activity: completed, outcome: 'attended' },
          meta: { requestId: 'req_complete' },
        },
      },
      {
        status: 200,
        body: {
          data: { activity: scheduled },
          meta: { requestId: 'req_uncomplete' },
        },
      },
    );
    mount();
    await loaded();

    fireEvent.click(screen.getByTestId('detail-complete'));
    await waitFor(() => expect(screen.getByTestId('detail-undo')).toBeDefined());
    expect(useToast.getState().current?.kind).toBe('undo');

    fireEvent.click(screen.getByTestId('detail-undo'));

    await waitFor(() =>
      expect(sent.filter((entry) => entry.method === 'POST')).toHaveLength(2),
    );
    expect(sent[2]?.url).toMatch(new RegExp(`/v1/activities/${ID}/uncomplete$`));
    expect(useToast.getState().current).toBeUndefined();
  });

  it('accepts Undo immediately while Complete is still in flight and compensates in order', async () => {
    const scheduled = plan();
    const completed = plan({ status: 'completed', outcome: 'attended' });
    stubFetch({ status: 200, body: detailBody(scheduled) });
    mount();
    await loaded();

    let finishComplete: ((response: object) => void) | undefined;
    const pendingComplete = new Promise<object>((resolve) => {
      finishComplete = resolve;
    });
    let postCount = 0;
    vi.stubGlobal('fetch', (url: string, init?: Record<string, unknown>) => {
      sent.push({
        url,
        method: (init?.method as string | undefined) ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
      });
      postCount += 1;
      if (postCount === 1) return pendingComplete;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () =>
          Promise.resolve({
            data: { activity: scheduled },
            meta: { requestId: 'req_uncomplete' },
          }),
        text: () =>
          Promise.resolve(
            JSON.stringify({
              data: { activity: scheduled },
              meta: { requestId: 'req_uncomplete' },
            }),
          ),
      });
    });

    fireEvent.click(screen.getByTestId('detail-complete'));

    const undo = await screen.findByTestId('detail-undo');
    expect(undo.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(undo);

    // The optimistic revert is immediate, but its compensating write must wait until the
    // original request settles or network order could leave the activity completed.
    expect(screen.getByTestId('detail-complete')).toBeDefined();
    expect(sent.filter((entry) => entry.method === 'POST')).toHaveLength(1);

    finishComplete?.({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () =>
        Promise.resolve({
          data: { activity: completed, outcome: 'attended' },
          meta: { requestId: 'req_complete' },
        }),
      text: () =>
        Promise.resolve(
          JSON.stringify({
            data: { activity: completed, outcome: 'attended' },
            meta: { requestId: 'req_complete' },
          }),
        ),
    });

    await waitFor(() =>
      expect(sent.filter((entry) => entry.method === 'POST')).toHaveLength(2),
    );
    expect(sent[2]?.url).toMatch(new RegExp(`/v1/activities/${ID}/uncomplete$`));
    expect(useToast.getState().current).toBeUndefined();
  });

  it('offers no Undo to a caller who cannot complete', async () => {
    stubFetch({
      status: 200,
      body: detailBody(plan({ status: 'completed', outcome: 'attended' }), [], {
        complete: false,
        skip: false,
        snooze: false,
      }),
    });
    mount();
    await loaded();

    expect(screen.getByTestId('detail-resolved')).toBeDefined();
    expect(screen.queryByTestId('detail-undo')).toBeNull();
  });

  it('renders no completion button when the caller cannot complete', async () => {
    stubFetch({
      status: 200,
      body: detailBody(plan(), [], { complete: false, skip: false, snooze: false }),
    });
    mount();
    await loaded();

    expect(screen.queryByTestId('detail-complete')).toBeNull();
  });
});

/**
 * Change kind, duplicate and delete — the three `⋯` actions (P1-27).
 *
 * The rule under every one of them is U6: **nothing destructive happens from a tap on the
 * menu**. Each opens a chooser or the §1a.1 confirmation, and the write happens only after
 * the named button in that dialog.
 */
describe('the ⋯ actions', () => {
  const openMenu = async () => {
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
  };

  it('offers Duplicate and Delete, with Delete last', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await openMenu();

    expect(screen.getByRole('button', { name: 'Duplicate' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDefined();
  });

  /** §6.4: delete always confirms, and the dialog names what goes. */
  it('confirms a delete before writing, in the §1a.1 shape', async () => {
    stubFetch({ status: 200, body: detailBody(plan({ notes: 'Check in after 3' })) });
    mount();
    await openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.getByTestId('delete-confirm')).toBeDefined());
    expect(screen.getByText('Delete "Zahav"?')).toBeDefined();
    expect(screen.getByText('This removes: the plan and its notes.')).toBeDefined();
    // Cancel first, and the destructive button repeats the verb.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Delete plan' })).toBeDefined();
    // Nothing has been written: still just the one GET.
    expect(sent).toHaveLength(1);
  });

  it('deletes only after the named button, then leaves the screen', async () => {
    const onBack = vi.fn();
    stubFetch(
      { status: 200, body: detailBody(plan()) },
      // `DELETE` answers with the deleted id in the envelope, not a 204 — the shared client
      // parses it against `deletedActivityResponse`, so a bodyless fixture would fail there
      // rather than in the screen.
      {
        status: 200,
        body: { data: { activityId: ID }, meta: { requestId: 'req_test' } },
      },
    );
    mount(onBack);
    await openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByTestId('delete-confirm')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Delete plan' }));

    await waitFor(() => expect(onBack).toHaveBeenCalledOnce());
    expect(sent[1]?.method).toBe('DELETE');
  });

  it('writes nothing when the delete is cancelled', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByTestId('delete-confirm')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(sent).toHaveLength(1);
  });

  it('separates occurrence removal, ending, and whole-series deletion', async () => {
    const recurring = task({
      notes: undefined,
      schedule: { date: '2026-08-01', time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01', time: '08:00' }],
      },
    });
    stubFetch({
      status: 200,
      body: detailBody(recurring, [], undefined, occurrenceProjection(), 3),
    });
    mount(
      () => {},
      () => {},
      undefined,
      TODAY,
    );
    await openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByTestId('recurring-delete-choices')).toBeDefined();
    expect(screen.getByRole('button', { name: 'This occurrence' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'End series' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Delete whole series' })).toBeDefined();
    expect(screen.queryByTestId('delete-confirm')).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('deletes the whole series only after naming its stored history and clears Today immediately', async () => {
    const onBack = vi.fn();
    const recurring = task({
      notes: undefined,
      schedule: { date: '2026-08-01', time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01', time: '08:00' }],
      },
    });
    stubFetch(
      {
        status: 200,
        body: detailBody(recurring, [], undefined, occurrenceProjection(), 3),
      },
      {
        status: 200,
        body: { data: { activityId: ID }, meta: { requestId: 'req_delete' } },
      },
    );
    const queryClient = createOfflineQueryClient();
    queryClient.setQueryData<AgendaData>(['agenda', 'delete-series'], {
      days: [
        {
          date: TODAY,
          schedule: [
            { ...agendaItem(), isRecurring: true, occurrenceDate: TODAY },
            {
              ...agendaItem(),
              time: '10:00',
              isRecurring: true,
              occurrenceDate: '2026-08-13',
            },
          ],
          anytime: [],
          earlier: [],
        },
      ],
      warnings: [],
    });
    const removeQueries = vi.spyOn(queryClient, 'removeQueries');
    mount(onBack, () => {}, undefined, TODAY, queryClient);
    await openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete whole series' }));

    expect(await screen.findByTestId('delete-series-confirm')).toBeDefined();
    expect(
      screen.getByText('This removes: the series and its 3 past completions.'),
    ).toBeDefined();
    expect(sent).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Delete series' }));

    await waitFor(() => expect(onBack).toHaveBeenCalledOnce());
    expect(sent[1]?.method).toBe('DELETE');
    const agenda = queryClient.getQueryData<AgendaData>(['agenda', 'delete-series']);
    expect(agenda?.days[0]?.schedule).toEqual([]);
    expect(removeQueries).not.toHaveBeenCalled();
  });

  it('removes only the selected occurrence through the skip endpoint', async () => {
    const onBack = vi.fn();
    const recurring = task({
      schedule: { date: '2026-08-01', time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01', time: '08:00' }],
      },
    });
    stubFetch(
      {
        status: 200,
        body: detailBody(recurring, [], undefined, occurrenceProjection()),
      },
      {
        status: 200,
        body: {
          data: { activity: recurring, occurrenceDate: TODAY },
          meta: { requestId: 'req_skip' },
        },
      },
    );
    mount(onBack, () => {}, undefined, TODAY);
    await openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'This occurrence' }));

    await waitFor(() => expect(onBack).toHaveBeenCalledOnce());
    expect(sent[1]).toMatchObject({
      method: 'POST',
      body: { occurrenceDate: TODAY },
    });
    expect(sent[1]?.url).toMatch(/\/skip$/);
  });

  it('ends the series on the selected occurrence without deleting it', async () => {
    const recurring = task({
      schedule: { date: '2026-08-01', time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01', time: '08:00' }],
      },
    });
    const ended = task({
      ...recurring,
      updatedAt: '2026-08-12T12:00:00.000Z',
      recurrence: { ...recurring.recurrence, endDate: TODAY },
    });
    stubFetch(
      {
        status: 200,
        body: detailBody(recurring, [], undefined, occurrenceProjection()),
      },
      { status: 200, body: { data: ended, meta: { requestId: 'req_end' } } },
    );
    mount(
      () => {},
      () => {},
      undefined,
      TODAY,
    );
    await openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'End series' }));

    await waitFor(() =>
      expect(sent.filter((request) => request.method === 'PATCH')).toHaveLength(1),
    );
    expect(sent[1]?.body).toEqual({
      recurrence: { ...recurring.recurrence, endDate: TODAY },
    });
    expect(sent.some((request) => request.method === 'DELETE')).toBe(false);
  });

  /**
   * §7.1: duplicate is a creating `POST`, so it carries an `Idempotency-Key` — without one
   * the transport refuses to retry it at all — and the copy opens in its own screen.
   */
  it('duplicates with an idempotency key and opens the copy', async () => {
    const onOpen = vi.fn();
    const copy = plan({
      activityId: 'act_01J0000000000000000000000C',
      title: 'Zahav (copy)',
    });
    stubFetch(
      { status: 200, body: detailBody(plan()) },
      { status: 201, body: { data: copy, meta: { requestId: 'req_test' } } },
    );
    mount(() => {}, onOpen);
    await openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() =>
      expect(onOpen).toHaveBeenCalledExactlyOnceWith('act_01J0000000000000000000000C'),
    );
    expect(sent[1]?.method).toBe('POST');
    expect(sent[1]?.url).toMatch(/\/duplicate$/);
    expect(sent[1]?.headers['Idempotency-Key']).toBeDefined();
  });

  /** §6.3 rule 6: a lossy kind change confirms first, naming the fields by their labels. */
  it('confirms a lossy Plan-kind change before writing', async () => {
    stubFetch({
      status: 200,
      body: detailBody(
        plan({
          type: 'watch',
          details: {
            kind: 'watch',
            mediaTitle: 'Severance',
            season: 2,
            episode: 4,
            service: 'Apple TV',
          },
        }),
      ),
    });
    mount();
    await openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Change Plan kind' }));
    await waitFor(() => expect(screen.getByTestId('change-kind-sheet')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Event' }));

    await waitFor(() => expect(screen.getByTestId('kind-change-confirm')).toBeDefined());
    expect(screen.getByText('Change Watch → Event?')).toBeDefined();
    expect(screen.getByText('Season and episode (S2 E4)')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Change to Event' })).toBeDefined();
    expect(sent).toHaveLength(1);
  });

  /**
   * §1a.1 rule 3, the other direction: an **additive** change shows no dialog at all and
   * applies straight away. Task → Plan carries every common field, so there is nothing to
   * warn about — and a confirmation that appears with nothing to name is a bug.
   */
  it('applies an additive Task → Plan change with no confirmation', async () => {
    stubFetch(
      { status: 200, body: detailBody(task()) },
      { status: 200, body: { data: task(), meta: { requestId: 'req_test' } } },
    );
    mount();
    await openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Change to Plan' }));
    await waitFor(() => expect(screen.getByTestId('change-kind-sheet')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'General' }));

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(screen.queryByTestId('kind-change-confirm')).toBeNull();
    expect(sent[1]?.method).toBe('PATCH');
    expect(sent[1]?.body).toMatchObject({
      objectKind: 'plan',
      type: 'custom',
      details: { kind: 'custom' },
    });
  });

  /** The pair always travels together: the server never chooses one from the other. */
  it('never sends objectKind without type', async () => {
    stubFetch(
      { status: 200, body: detailBody(task()) },
      { status: 200, body: { data: task(), meta: { requestId: 'req_test' } } },
    );
    mount();
    await openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Change to Plan' }));
    await waitFor(() => expect(screen.getByTestId('change-kind-sheet')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Meal' }));

    await waitFor(() => expect(sent).toHaveLength(2));
    const body = sent[1]?.body as Record<string, unknown>;
    expect('objectKind' in body).toBe(true);
    expect('type' in body).toBe(true);
  });
});

/**
 * The occurrence actions and the skipped state (P2-47, plus the founder's 2026-08-15 report).
 *
 * Three defects in one report: a skipped occurrence rendered the *completion* verb in green
 * because the screen read `activity.status`, which an occurrence skip never moves; its reversal
 * was labelled `Undo`; and the resolved state did not appear until the response landed.
 */
describe('occurrence actions', () => {
  const series = () =>
    plan({
      objectKind: 'task',
      type: 'task',
      details: { kind: 'task' },
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TODAY, time: '08:00' }],
      },
    });

  it('offers Snooze and Skip today on an occurrence, beneath the completion button', async () => {
    stubFetch({
      status: 200,
      body: detailBody(series(), [], undefined, occurrenceProjection()),
    });
    mount(
      () => {},
      () => {},
      undefined,
      TODAY,
    );
    await loaded();

    expect(screen.getByTestId('detail-complete')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Snooze' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Skip today' })).toBeDefined();
  });

  /** A series reached without a day has no occurrence to act on, so it offers neither. */
  it('offers neither on a series with no occurrence in context', async () => {
    stubFetch({ status: 200, body: detailBody(series()) });
    mount();
    await loaded();

    expect(screen.queryByTestId('detail-snooze')).toBeNull();
    expect(screen.queryByTestId('detail-skip')).toBeNull();
  });

  /** Server-authored capabilities, never a client re-derivation of ownership. */
  it('offers neither when the server withholds both capabilities', async () => {
    stubFetch({
      status: 200,
      body: detailBody(
        series(),
        [],
        { complete: true, skip: false, snooze: false },
        occurrenceProjection(),
      ),
    });
    mount(
      () => {},
      () => {},
      undefined,
      TODAY,
    );
    await loaded();

    expect(screen.queryByTestId('detail-snooze')).toBeNull();
    expect(screen.queryByTestId('detail-skip')).toBeNull();
  });

  it('opens the shared snooze sheet, which names the activity and its blast radius', async () => {
    stubFetch({
      status: 200,
      body: detailBody(series(), [], undefined, occurrenceProjection()),
    });
    mount(
      () => {},
      () => {},
      undefined,
      TODAY,
    );
    await loaded();

    fireEvent.click(screen.getByTestId('detail-snooze'));

    expect(screen.getByTestId('snooze-subject').textContent).toContain('8:00 AM');
    expect(screen.getByTestId('snooze-blast-radius').textContent).toBe(
      'Today only. Tomorrow stays 8:00 AM.',
    );
  });

  /**
   * The skip is projected before the request, not after it — the reported lag. The assertion
   * is that the resolved state is on screen while the POST is still outstanding.
   */
  it('shows the skipped state immediately, before the write comes back', async () => {
    let release: ((value: unknown) => void) | undefined;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    stubFetch(
      { status: 200, body: detailBody(series(), [], undefined, occurrenceProjection()) },
      {
        status: 200,
        body: { data: { activity: series() }, meta: { requestId: 'req_test' } },
        wait: pending,
      },
    );
    mount(
      () => {},
      () => {},
      undefined,
      TODAY,
    );
    await loaded();

    fireEvent.click(screen.getByTestId('detail-skip'));

    await waitFor(() =>
      expect(screen.getByTestId('detail-resolved').textContent).toBe('Skipped'),
    );
    expect(screen.getByRole('button', { name: 'Undo skip' })).toBeDefined();
    release?.(undefined);
  });

  /**
   * A skipped **occurrence** never moves `ACT#/META`, so reading `activity.status` alone
   * reported the completion verb. The status the screen is about is the occurrence's.
   */
  it('states a skipped occurrence as skipped, not as done', async () => {
    stubFetch({
      status: 200,
      body: detailBody(series(), [], undefined, occurrenceProjection('skipped')),
    });
    mount(
      () => {},
      () => {},
      undefined,
      TODAY,
    );
    await loaded();

    expect(screen.getByTestId('detail-resolved').textContent).toBe('Skipped');
    expect(screen.getByRole('button', { name: 'Undo skip' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  /** And a completion still reads as a completion, with its own verb and its own label. */
  it('leaves a completed occurrence saying Done under Undo', async () => {
    stubFetch({
      status: 200,
      body: detailBody(series(), [], undefined, occurrenceProjection('completed')),
    });
    mount(
      () => {},
      () => {},
      undefined,
      TODAY,
    );
    await loaded();

    expect(screen.getByTestId('detail-resolved').textContent).toBe('Done');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDefined();
  });
});

/**
 * The resolved block has three states, not two (founder, 2026-08-15). A declined outcome is
 * stored as `status: 'skipped'` with that outcome, so it cannot be told from a plain skip by
 * status alone — and reporting it as the type's positive verb told the user the opposite of
 * what they had just tapped.
 */
describe('resolved outcomes', () => {
  it('reports a declined event as the words the user chose, not as Attended', async () => {
    stubFetch({
      status: 200,
      body: detailBody(plan({ status: 'skipped', outcome: 'didnt_go' })),
    });
    mount();
    await loaded();

    expect(screen.getByTestId('detail-resolved').textContent).toBe("Didn't go");
    expect(screen.queryByText('Attended')).toBeNull();
    // Reversing an answer is `Undo`; `Undo skip` is §3.1's label for reversing a skip.
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDefined();
    expect(screen.queryByText('It won’t appear on your day.')).toBeNull();
  });

  it('reports a completed event as Attended', async () => {
    stubFetch({
      status: 200,
      body: detailBody(plan({ status: 'completed', outcome: 'attended' })),
    });
    mount();
    await loaded();

    expect(screen.getByTestId('detail-resolved').textContent).toBe('Attended');
  });

  /** A plain skip declared nothing about how it went, so it says only that. */
  it('reports a skip with no outcome as Skipped', async () => {
    stubFetch({ status: 200, body: detailBody(plan({ status: 'skipped' })) });
    mount();
    await loaded();

    expect(screen.getByTestId('detail-resolved').textContent).toBe('Skipped');
  });

  /**
   * And optimistically, before the write lands — the projection carries the outcome, or the
   * screen answers `Attended` for the whole round trip.
   */
  it('reports the declined outcome the moment it is chosen', async () => {
    let release: ((value: unknown) => void) | undefined;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const passed = plan({
      schedule: { date: '2026-08-11', time: '09:00', timezone: 'America/New_York' },
    });
    stubFetch(
      { status: 200, body: detailBody(passed) },
      {
        status: 200,
        body: {
          data: { activity: { ...passed, status: 'skipped', outcome: 'didnt_go' } },
          meta: { requestId: 'req_test' },
        },
        wait: pending,
      },
    );
    mount(
      () => {},
      () => {},
      '2026-08-11',
    );
    await loaded();

    fireEvent.click(screen.getByTestId('detail-resolution-prompt'));
    fireEvent.click(screen.getByRole('button', { name: "Didn't go" }));

    await waitFor(() =>
      expect(screen.getByTestId('detail-resolved').textContent).toBe("Didn't go"),
    );
    release?.(undefined);
  });
});

/**
 * The snooze had to be *seen*. Reported as: press Snooze, pick 15 minutes, and the screen sits
 * on the old time for anything up to a minute — sometimes updating on a stray refocus, sometimes
 * not until the user navigated away and back. `refreshActivityDetails` marks the detail query
 * stale with `refetchType: 'none'`, which is correct and which only works when something
 * projects; snooze projected the agenda and left this behind.
 */
describe('snooze visibility', () => {
  const series = () =>
    plan({
      objectKind: 'task',
      type: 'task',
      details: { kind: 'task' },
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TODAY, time: '08:00' }],
      },
    });

  it('shows the snoozed time before the write comes back', async () => {
    let release: ((value: unknown) => void) | undefined;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    stubFetch(
      {
        status: 200,
        body: detailBody(series(), [], undefined, occurrenceProjection()),
      },
      {
        status: 200,
        body: { data: { activity: series() }, meta: { requestId: 'req_test' } },
        wait: pending,
      },
    );
    mount(
      () => {},
      () => {},
      undefined,
      TODAY,
    );
    await loaded();

    expect(screen.getByTestId('when-where-date').textContent).toContain('8:00 AM');

    fireEvent.click(screen.getByTestId('detail-snooze'));
    fireEvent.click(screen.getByRole('button', { name: 'Snooze until 8:25 AM' }));

    // The header, not a toast: the screen states the new time while the POST is outstanding.
    await waitFor(() =>
      expect(screen.getByTestId('when-where-date').textContent).toContain('8:25 AM'),
    );
    release?.(undefined);
  });
});

/** Reported: snooze an occurrence, then skip it, and the resolved block never appears. */
describe('snooze then skip', () => {
  const series = () =>
    plan({
      objectKind: 'task',
      type: 'task',
      details: { kind: 'task' },
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TODAY, time: '08:00' }],
      },
    });

  /**
   * A **stateful** stub, because the fixed-response one cannot reproduce this: the defect only
   * appears once a refetch returns what the server actually stored after the snooze, and the
   * skip then lands on that.
   */
  function statefulStub() {
    let occurrence: NonNullable<ActivityDetail['occurrence']> = occurrenceProjection();
    vi.stubGlobal('fetch', (url: string, init?: Record<string, unknown>) => {
      const method = (init?.method as string | undefined) ?? 'GET';
      sent.push({
        url,
        method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
      });
      if (method === 'POST' && String(url).includes('/snooze')) {
        const until = (JSON.parse(init?.body as string) as { until: string }).until;
        occurrence = { ...occurrence, time: until, isSnoozed: true, status: 'scheduled' };
      }
      if (method === 'POST' && String(url).includes('/skip')) {
        occurrence = { ...occurrence, status: 'skipped_occurrence' };
      }
      const body =
        method === 'GET'
          ? detailBody(series(), [], undefined, occurrence)
          : { data: { activity: series() }, meta: { requestId: 'r' } };
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    });
  }

  it('shows Undo skip after a snooze has already moved the occurrence', async () => {
    statefulStub();
    mount(
      () => {},
      () => {},
      undefined,
      TODAY,
    );
    await loaded();

    fireEvent.click(screen.getByTestId('detail-snooze'));
    fireEvent.click(screen.getByRole('button', { name: 'Snooze until 8:25 AM' }));
    await waitFor(() =>
      expect(screen.getByTestId('when-where-date').textContent).toContain('8:25 AM'),
    );

    fireEvent.click(screen.getByTestId('detail-skip'));

    await waitFor(() =>
      expect(screen.getByTestId('detail-resolved').textContent).toBe('Skipped'),
    );
    expect(screen.getByRole('button', { name: 'Undo skip' })).toBeDefined();
  });
});

/**
 * `Skip today` names a day, so it is used only where there is one (founder, 2026-08-15). On a
 * one-off the write is `POST /skip` with no occurrence — `status: 'skipped'` on the Activity,
 * permanently — and on an undated task the word named a day it was never on.
 */
describe('the skip label follows its scope', () => {
  const series = () =>
    plan({
      objectKind: 'task',
      type: 'task',
      details: { kind: 'task' },
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TODAY, time: '08:00' }],
      },
    });

  it('says Skip today on a concrete recurring occurrence', async () => {
    stubFetch({
      status: 200,
      body: detailBody(series(), [], undefined, occurrenceProjection()),
    });
    mount(
      () => {},
      () => {},
      undefined,
      TODAY,
    );
    await loaded();

    expect(screen.getByTestId('detail-skip').textContent).toBe('Skip today');
  });

  it.each([
    ['dated', { date: TODAY, time: '08:00', timezone: 'America/New_York' }],
    ['dated but untimed', { date: TODAY, timezone: 'America/New_York' }],
    ['undated', undefined],
  ])('says Skip on a %s one-off task', async (_name, schedule) => {
    stubFetch({
      status: 200,
      body: detailBody(
        plan({
          objectKind: 'task',
          type: 'task',
          details: { kind: 'task' },
          schedule,
          ...(schedule === undefined ? { status: 'saved' } : {}),
        }),
      ),
    });
    mount();
    await loaded();

    expect(screen.getByTestId('detail-skip').textContent).toBe('Skip');
  });

  /** And it writes at activity scope, with no occurrence in the body. */
  it('skips a one-off at activity scope', async () => {
    stubFetch(
      {
        status: 200,
        body: detailBody(
          plan({ objectKind: 'task', type: 'task', details: { kind: 'task' } }),
        ),
      },
      {
        status: 200,
        body: {
          data: {
            activity: plan({
              objectKind: 'task',
              type: 'task',
              details: { kind: 'task' },
              status: 'skipped',
            }),
          },
          meta: { requestId: 'r' },
        },
      },
    );
    mount();
    await loaded();

    fireEvent.click(screen.getByTestId('detail-skip'));

    await waitFor(() => expect(sent.find((s) => s.url.includes('/skip'))).toBeDefined());
    expect(sent.find((s) => s.url.includes('/skip'))?.body).not.toHaveProperty(
      'occurrenceDate',
    );
  });
});

/**
 * The same two taps on both storage shapes. Reported as: a repeated snooze compounds on a
 * recurring task and does not on a one-off, and a one-off's detail time never moves at all.
 * Both are the one fork — the screen understood the `OCC#` shape and not `snoozedUntil`.
 */
describe('a snooze behaves the same whichever shape stores it', () => {
  const oneOff = () =>
    plan({
      objectKind: 'task',
      type: 'task',
      details: { kind: 'task' },
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
    });

  const series = () =>
    plan({
      objectKind: 'task',
      type: 'task',
      details: { kind: 'task' },
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TODAY, time: '08:00' }],
      },
    });

  it('moves a one-off’s displayed time, as it already did for an occurrence', async () => {
    stubFetch(
      { status: 200, body: detailBody(oneOff()) },
      { status: 200, body: { data: { activity: oneOff() }, meta: { requestId: 'r' } } },
    );
    mount();
    await loaded();

    fireEvent.click(screen.getByTestId('detail-snooze'));
    fireEvent.click(screen.getByRole('button', { name: 'Snooze until 8:25 AM' }));

    await waitFor(() =>
      expect(screen.getByTestId('when-where-date').textContent).toContain('8:25 AM'),
    );
  });

  it.each([
    ['a one-off', oneOff],
    ['an occurrence', series],
  ])('compounds a repeated snooze on %s', async (_name, activity) => {
    const occurrence = activity === series ? occurrenceProjection() : undefined;
    stubFetch(
      { status: 200, body: detailBody(activity(), [], undefined, occurrence) },
      { status: 200, body: { data: { activity: activity() }, meta: { requestId: 'r' } } },
    );
    mount(
      () => {},
      () => {},
      undefined,
      occurrence === undefined ? undefined : TODAY,
    );
    await loaded();

    fireEvent.click(screen.getByTestId('detail-snooze'));
    fireEvent.click(screen.getByRole('button', { name: 'Snooze until 8:25 AM' }));
    await waitFor(() =>
      expect(screen.getByTestId('when-where-date').textContent).toContain('8:25 AM'),
    );

    // The second press counts from where the first one left it, on both shapes.
    fireEvent.click(screen.getByTestId('detail-snooze'));
    expect(screen.getByRole('button', { name: 'Snooze until 8:40 AM' })).toBeDefined();
  });
});

/**
 * `Remove time` reaching the detail screen. Reported as working on Today and not here — and it
 * did work here, right up until the activity had been snoozed once, at which point a
 * `snoozedUntil` the reschedule never cleared put the old time straight back.
 */
describe('removing the time', () => {
  it('drops the time from the detail header', async () => {
    const timed = plan({
      objectKind: 'task',
      type: 'task',
      details: { kind: 'task' },
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
    });
    stubFetch(
      { status: 200, body: detailBody(timed) },
      {
        status: 200,
        body: {
          data: {
            activity: plan({
              objectKind: 'task',
              type: 'task',
              details: { kind: 'task' },
              schedule: { date: TODAY, timezone: 'America/New_York' },
            }),
          },
          meta: { requestId: 'r' },
        },
      },
    );
    mount();
    await loaded();

    fireEvent.click(screen.getByTestId('when-where-date'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove time' }));

    await waitFor(() =>
      expect(screen.getByTestId('when-where-date').textContent).not.toContain('8:00 AM'),
    );
  });

  it('drops it after a snooze, whose deferral the reschedule has ended', async () => {
    const snoozed = plan({
      objectKind: 'task',
      type: 'task',
      details: { kind: 'task' },
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
      snoozedUntil: '08:25',
    });
    stubFetch(
      { status: 200, body: detailBody(snoozed) },
      {
        status: 200,
        body: {
          data: {
            activity: plan({
              objectKind: 'task',
              type: 'task',
              details: { kind: 'task' },
              schedule: { date: TODAY, timezone: 'America/New_York' },
              snoozedUntil: '08:25',
            }),
          },
          meta: { requestId: 'r' },
        },
      },
    );
    mount();
    await loaded();

    fireEvent.click(screen.getByTestId('when-where-date'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove time' }));

    await waitFor(() =>
      expect(screen.getByTestId('when-where-date').textContent).not.toContain('8:25 AM'),
    );
  });
});

/**
 * The reconciled Plan-detail anatomy (P3-37, `plans-and-lists.md` §2.1–§2.2 amended
 * 2026-08-25): settings always render; sections exist only once they hold something;
 * 1–3 rows render in full and 4+ peek at three with `Show all n`.
 */
describe('the Plan detail anatomy (P3-37)', () => {
  const child = (index: number, status: Activity['status'] = 'scheduled') => ({
    activityId: `act_01J0000000000000000000P3${37 + index}`,
    title: `Prep ${index}`,
    status,
    isRecurring: false,
  });

  const sourceList = (index: number) => ({
    listId: `lst_01J0000000000000000000P3${37 + index}`,
    title: `List ${index}`,
    icon: 'list',
    itemCount: 8,
    doneCount: index % 2 === 0 ? 3 : 0,
  });

  const update = (index: number) => ({
    updateId: `upd_01J0000000000000000000P3${37 + index}`,
    activityId: ID,
    kind: 'system' as const,
    body: `Update ${index}`,
    createdAt: '2026-08-10T10:00:00.000Z',
    schemaVersion: 1 as const,
  });

  function mountAnatomy(extras: Partial<ActivityDetail>, activity = plan()) {
    stubFetch({
      status: 200,
      body: detailBody(activity, [], undefined, undefined, undefined, extras),
    });
    const onOpenList = vi.fn();
    const onOpenChild = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    registerActivityMutationDefaults(queryClient);
    render(
      <SafeAreaProvider>
        <ClockProvider clock={fixedClock('2026-08-12T12:10:00.000Z' as Instant)}>
          <ThemeProvider scheme="light">
            <QueryClientProvider client={queryClient}>
              <ActivityDetailScreen
                target={{ kind: 'activity', activityId: ID }}
                today={TODAY}
                onBack={() => {}}
                onOpenActivity={() => {}}
                onOpenList={onOpenList}
                onOpenChild={onOpenChild}
              />
            </QueryClientProvider>
          </ThemeProvider>
        </ClockProvider>
      </SafeAreaProvider>,
    );
    return { onOpenList, onOpenChild };
  }

  it('renders no empty section headings — settings and People only on a bare plan', async () => {
    mountAnatomy({});
    await screen.findByTestId('detail-content');
    expect(screen.getByTestId('section-notes')).toBeDefined();
    expect(screen.getByTestId('section-reminders')).toBeDefined();
    expect(screen.getByTestId('detail-edit-recurrence')).toBeDefined();
    // People keeps its pre-build treatment: visible, subordinate, no chevron behaviour.
    // Empty Attachments joins it as a discovery row until P3-41 wires its chip.
    expect(screen.getByTestId('section-people')).toBeDefined();
    expect(screen.getAllByText('Coming later')).toHaveLength(2);
    expect(screen.queryByTestId('section-prep')).toBeNull();
    expect(screen.queryByTestId('section-lists')).toBeNull();
    expect(screen.queryByTestId('section-attachments')).toBeNull();
    expect(screen.queryByTestId('section-updates')).toBeNull();
  });

  it('hides Updates on a private plan with no entries and shows it once one exists', async () => {
    mountAnatomy({ updates: [update(1)] });
    const section = await screen.findByTestId('section-updates');
    expect(section).toBeDefined();
    expect(screen.getByText('Update 1')).toBeDefined();
    expect(screen.getByText('2 days ago')).toBeDefined();
  });

  it('renders a 1–3 row section in full with no Show all', async () => {
    mountAnatomy({ children: [child(1), child(2, 'completed'), child(3)] });
    await screen.findByTestId('section-prep');
    expect(screen.getByText('1 of 3')).toBeDefined();
    for (const title of ['Prep 1', 'Prep 2', 'Prep 3']) {
      expect(screen.getByText(title)).toBeDefined();
    }
    expect(screen.queryByTestId('prep-show-all')).toBeNull();
  });

  it('peeks a 4+ section at three rows and expands through Show all n', async () => {
    mountAnatomy({ children: [child(1), child(2), child(3), child(4), child(5)] });
    await screen.findByTestId('section-prep');
    expect(screen.getByText('Prep 3')).toBeDefined();
    expect(screen.queryByText('Prep 4')).toBeNull();

    fireEvent.click(screen.getByTestId('prep-show-all'));
    expect(screen.getByText('Prep 4')).toBeDefined();
    expect(screen.getByText('Prep 5')).toBeDefined();
  });

  it('opens a prep child through the row body and a List through its row', async () => {
    const { onOpenChild, onOpenList } = mountAnatomy({
      children: [child(1)],
      sourceLists: [sourceList(1), sourceList(2)],
    });
    await screen.findByTestId('section-prep');
    fireEvent.click(screen.getByRole('button', { name: 'Prep 1' }));
    expect(onOpenChild).toHaveBeenCalledWith(child(1).activityId);

    expect(screen.getByText('8 items · 3 checked')).toBeDefined();
    expect(screen.getByText('8 items')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'List 1, 8 items' }));
    expect(onOpenList).toHaveBeenCalledWith(sourceList(1).listId);
  });

  it('renders the same applicable section set for an undated plan, uncalled incomplete', async () => {
    mountAnatomy(
      { children: [child(1)], sourceLists: [sourceList(2)] },
      plan({ status: 'saved', schedule: undefined }),
    );
    await screen.findByTestId('section-prep');
    expect(screen.getByTestId('section-lists')).toBeDefined();
    expect(screen.getByText('Not scheduled')).toBeDefined();
    // No reminder or repeat row without a date — nothing to count back from.
    expect(screen.queryByTestId('section-reminders')).toBeNull();
    expect(screen.queryByText(/unfinished|incomplete/i)).toBeNull();
  });

  it('renders a task with no plan sections and no chip row', async () => {
    mountAnatomy({ children: [child(1)] }, task());
    await screen.findByTestId('detail-content');
    expect(screen.queryByTestId('section-prep')).toBeNull();
    expect(screen.queryByTestId('add-to-plan')).toBeNull();
    expect(screen.queryByTestId('section-people')).toBeNull();
  });
});

/**
 * `+ Add prep task` (P3-38): a wired handler surfaces the empty section through the chip row
 * and the populated section through its own trailing affordance — and an unwired detail
 * (P3-37's shipped state) renders neither.
 */
describe('the prep-task entry points (P3-38)', () => {
  const child = (index: number) => ({
    activityId: `act_01J0000000000000000000P3${37 + index}`,
    title: `Prep ${index}`,
    status: 'scheduled' as const,
    isRecurring: false,
  });

  function mountWithPrepEntry(extras: Partial<ActivityDetail>) {
    stubFetch({
      status: 200,
      body: detailBody(plan(), [], undefined, undefined, undefined, extras),
    });
    const onAddPrepTask = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    registerActivityMutationDefaults(queryClient);
    render(
      <SafeAreaProvider>
        <ClockProvider clock={fixedClock('2026-08-12T12:10:00.000Z' as Instant)}>
          <ThemeProvider scheme="light">
            <QueryClientProvider client={queryClient}>
              <ActivityDetailScreen
                target={{ kind: 'activity', activityId: ID }}
                today={TODAY}
                onBack={() => {}}
                onOpenActivity={() => {}}
                onOpenList={() => {}}
                onOpenChild={() => {}}
                onAddPrepTask={onAddPrepTask}
              />
            </QueryClientProvider>
          </ThemeProvider>
        </ClockProvider>
      </SafeAreaProvider>,
    );
    return { onAddPrepTask };
  }

  it('offers a Prep task chip on an empty plan and fires the handler', async () => {
    const { onAddPrepTask } = mountWithPrepEntry({});
    await screen.findByTestId('detail-content');
    expect(screen.queryByTestId('section-prep')).toBeNull();
    fireEvent.click(screen.getByTestId('add-to-plan-prep-task'));
    expect(onAddPrepTask).toHaveBeenCalledTimes(1);
  });

  it('moves the entry into the populated section and off the chip row', async () => {
    const { onAddPrepTask } = mountWithPrepEntry({ children: [child(1)] });
    await screen.findByTestId('section-prep');
    expect(screen.queryByTestId('add-to-plan-prep-task')).toBeNull();
    expect(screen.getByText('+ Add prep task')).toBeDefined();
    fireEvent.click(screen.getByTestId('prep-add'));
    expect(onAddPrepTask).toHaveBeenCalledTimes(1);
  });
});

/**
 * The `Add list` entry points (P3-39): the chip on an empty plan, the section's own
 * affordance once a List exists, both handing the caller the plan's title for the sheet's
 * context line — and the entry is the same from every Plan type, because the type is not
 * an input to it.
 */
describe('the Add-list entry points (P3-39)', () => {
  const sourceList = {
    listId: 'lst_01J0000000000000000000P339',
    title: 'Packing',
    icon: 'list',
    itemCount: 8,
    doneCount: 3,
  };

  function mountWithListEntry(extras: Partial<ActivityDetail>, activity = plan()) {
    stubFetch({
      status: 200,
      body: detailBody(activity, [], undefined, undefined, undefined, extras),
    });
    const onAddList = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    registerActivityMutationDefaults(queryClient);
    render(
      <SafeAreaProvider>
        <ClockProvider clock={fixedClock('2026-08-12T12:10:00.000Z' as Instant)}>
          <ThemeProvider scheme="light">
            <QueryClientProvider client={queryClient}>
              <ActivityDetailScreen
                target={{ kind: 'activity', activityId: ID }}
                today={TODAY}
                onBack={() => {}}
                onOpenActivity={() => {}}
                onOpenList={() => {}}
                onOpenChild={() => {}}
                onAddList={onAddList}
              />
            </QueryClientProvider>
          </ThemeProvider>
        </ClockProvider>
      </SafeAreaProvider>,
    );
    return { onAddList };
  }

  it.each([
    ['custom', { kind: 'custom' }],
    ['meal', { kind: 'meal' }],
    ['watch', { kind: 'watch', mediaTitle: 'Zahav' }],
    ['event', { kind: 'event' }],
  ] as const)(
    'offers the identical List chip on an empty %s plan, with the title',
    async (type, details) => {
      const { onAddList } = mountWithListEntry({}, plan({ type, details }));
      await screen.findByTestId('detail-content');
      expect(screen.queryByTestId('section-lists')).toBeNull();
      fireEvent.click(screen.getByTestId('add-to-plan-list'));
      expect(onAddList).toHaveBeenCalledWith('Zahav');
    },
  );

  it('moves the entry into the populated section and off the chip row', async () => {
    const { onAddList } = mountWithListEntry({ sourceLists: [sourceList] });
    await screen.findByTestId('section-lists');
    expect(screen.queryByTestId('add-to-plan-list')).toBeNull();
    expect(screen.getByText('+ Add list')).toBeDefined();
    fireEvent.click(screen.getByTestId('lists-add'));
    expect(onAddList).toHaveBeenCalledWith('Zahav');
  });
});

/**
 * The Updates section in full (P3-40): the feed newest-first with `+ Write an update` at the
 * foot, optimistic posting, author-only delete, cursor paging only on reveal, and the §2.2
 * visibility matrix.
 */
describe('the Updates section (P3-40)', () => {
  beforeEach(() => {
    usePlanActivityFloor.setState({ floors: {} });
  });

  const systemUpdate = (index: number, createdAt: string) => ({
    updateId: `upd_01J0000000000000000000P4${40 + index}`,
    activityId: ID,
    kind: 'system' as const,
    body: `System ${index}`,
    createdAt,
    schemaVersion: 1 as const,
  });

  const userUpdate = (index: number, createdAt: string) => ({
    updateId: `upd_01J0000000000000000000P4${50 + index}`,
    activityId: ID,
    kind: 'user' as const,
    authorUserId: 'usr_01J0000000000000000000000B',
    body: `Note ${index}`,
    createdAt,
    schemaVersion: 1 as const,
  });

  function mountUpdates(
    extras: Partial<ActivityDetail>,
    activity = plan(),
    ...responses: Array<{ status: number; body: unknown }>
  ) {
    stubFetch(
      {
        status: 200,
        body: detailBody(activity, [], undefined, undefined, undefined, extras),
      },
      ...responses,
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    registerActivityMutationDefaults(queryClient);
    render(
      <SafeAreaProvider>
        <ClockProvider clock={fixedClock('2026-08-12T12:10:00.000Z' as Instant)}>
          <ThemeProvider scheme="light">
            <QueryClientProvider client={queryClient}>
              <ActivityDetailScreen
                target={{ kind: 'activity', activityId: ID }}
                today={TODAY}
                onBack={() => {}}
                onOpenActivity={() => {}}
                onOpenList={() => {}}
                onOpenChild={() => {}}
              />
            </QueryClientProvider>
          </ThemeProvider>
        </ClockProvider>
      </SafeAreaProvider>,
    );
  }

  it('renders newest first from an unsorted embedded page', async () => {
    mountUpdates({
      updates: [
        systemUpdate(1, '2026-08-08T10:00:00.000Z'),
        userUpdate(1, '2026-08-11T10:00:00.000Z'),
        systemUpdate(2, '2026-08-10T10:00:00.000Z'),
      ],
    });
    const section = await screen.findByTestId('section-updates');
    const bodies = Array.from(
      section.querySelectorAll('[data-testid^="update-upd_"]'),
    ).map((row) => row.textContent);
    expect(bodies[0]).toContain('Note 1');
    expect(bodies[1]).toContain('System 2');
    expect(bodies[2]).toContain('System 1');
  });

  it('shows the section with only the composer on a shared plan with no entries', async () => {
    mountUpdates({}, plan({ visibility: 'shared' }));
    await screen.findByTestId('section-updates');
    expect(screen.getByText('+ Write an update')).toBeDefined();
    expect(screen.queryByTestId('updates-load-older')).toBeNull();
  });

  it('offers delete on an own user entry and never on a system entry', async () => {
    const user = userUpdate(1, '2026-08-11T10:00:00.000Z');
    const system = systemUpdate(1, '2026-08-10T10:00:00.000Z');
    mountUpdates({ updates: [user, system] });
    await screen.findByTestId('section-updates');

    // No author name anywhere — the system entry is the event, the user entry is the caller.
    expect(screen.queryByText(/usr_/)).toBeNull();
    expect(screen.getByTestId(`update-delete-${user.updateId}`)).toBeDefined();
    expect(screen.queryByTestId(`update-delete-${system.updateId}`)).toBeNull();
  });

  it('removes an own entry through Delete and issues the DELETE request', async () => {
    const user = userUpdate(1, '2026-08-11T10:00:00.000Z');
    mountUpdates({ updates: [user] }, plan(), {
      status: 200,
      body: { data: { updateId: user.updateId }, meta: { requestId: 'req_test' } },
    });
    await screen.findByTestId('section-updates');

    fireEvent.click(screen.getByTestId(`update-delete-${user.updateId}`));
    await waitFor(() =>
      expect(screen.queryByTestId(`update-${user.updateId}`)).toBeNull(),
    );
    const request = sent.find((call) => call.method === 'DELETE');
    expect(request?.url).toContain(`/v1/activities/${ID}/updates/${user.updateId}`);
  });

  it('posts optimistically: the entry renders at the head before the response lands', async () => {
    const stored = userUpdate(9, '2026-08-12T12:00:00.000Z');
    mountUpdates({ updates: [systemUpdate(1, '2026-08-10T10:00:00.000Z')] }, plan(), {
      status: 201,
      body: {
        data: { update: stored, lastActivityAt: stored.createdAt },
        meta: { requestId: 'req_test' },
      },
    });
    await screen.findByTestId('section-updates');

    fireEvent.click(screen.getByRole('button', { name: 'Write an update' }));
    fireEvent.change(screen.getByLabelText('Update'), {
      target: { value: 'Note 9' },
    });
    fireEvent.click(screen.getByTestId('update-composer-post'));

    // Before the response: the optimistic entry is on screen under its pending identity.
    expect(screen.getByText('Note 9')).toBeDefined();

    // After: the stored row replaces it and the composer has closed.
    await screen.findByTestId(`update-${stored.updateId}`);
    expect(screen.queryByTestId(/update-pending-/)).toBeNull();
    expect(screen.queryByTestId('update-composer')).toBeNull();
    const request = sent.find(
      (call) => call.method === 'POST' && call.url.includes('/updates'),
    );
    expect(request?.body).toEqual({ body: 'Note 9' });

    // The authoritative lastActivityAt was raised into the Plans floor (§P3-40's merge).
    expect(usePlanActivityFloor.getState().floors[ID]).toBe(stored.createdAt);
  });

  it('pages through the cursor only when revealed, never on open', async () => {
    const first = [
      userUpdate(1, '2026-08-11T10:00:00.000Z'),
      systemUpdate(1, '2026-08-10T10:00:00.000Z'),
      systemUpdate(2, '2026-08-09T10:00:00.000Z'),
      systemUpdate(3, '2026-08-08T10:00:00.000Z'),
    ];
    const older = systemUpdate(4, '2026-08-07T10:00:00.000Z');
    mountUpdates({ updates: first, updatesCursor: 'cur_1' }, plan(), {
      status: 200,
      body: { data: { updates: [older] }, meta: { requestId: 'req_test' } },
    });
    await screen.findByTestId('section-updates');

    // Opening issued exactly the one detail request — no cursor fetch.
    expect(sent.filter((call) => call.url.includes('/updates'))).toHaveLength(0);

    fireEvent.click(screen.getByTestId('updates-show-all'));
    fireEvent.click(screen.getByTestId('updates-load-older'));
    await screen.findByTestId(`update-${older.updateId}`);
    const paged = sent.find(
      (call) => call.method === 'GET' && call.url.includes('cursor=cur_1'),
    );
    expect(paged).toBeDefined();
  });
});
