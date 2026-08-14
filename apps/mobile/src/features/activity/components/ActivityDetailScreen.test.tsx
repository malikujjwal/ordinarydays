import type { Activity, ActivityDetail, AgendaData, AgendaItem } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerActivityMutationDefaults } from '@/lib/mutationDefaults';
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
) => ({
  data: {
    activity,
    capabilities,
    reminders,
  },
  meta: { requestId: 'req_test' },
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

function stubFetch(...responses: Array<{ status: number; body: unknown }>) {
  let call = 0;
  vi.stubGlobal('fetch', (url: string, init?: Record<string, unknown>) => {
    sent.push({
      url,
      method: (init?.method as string | undefined) ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
    });
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

function mount(
  onBack = () => {},
  onOpenActivity: (id: string) => void = () => {},
  resolutionOccurrenceDate?: string | null,
  occurrenceDate?: string,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  registerActivityMutationDefaults(queryClient);
  const wrap = (ui: ReactNode) => (
    <SafeAreaProvider>
      <ThemeProvider scheme="light">
        <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
  const rendered = render(
    wrap(
      <ActivityDetailScreen
        activityId={ID}
        today={TODAY}
        onBack={onBack}
        onOpenActivity={onOpenActivity}
        {...(resolutionOccurrenceDate === undefined ? {} : { resolutionOccurrenceDate })}
        {...(occurrenceDate === undefined ? {} : { occurrenceDate })}
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
  it('renders future Plan capabilities as noninteractive Coming later rows', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await loaded();

    for (const heading of ['People', 'Preparation', 'Related lists', 'Attachments']) {
      expect(screen.getByText(heading)).toBeDefined();
    }
    expect(screen.getAllByText('Coming later')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /People/ })).toBeNull();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
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
      { status: 200, body: detailBody(recurring) },
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
      { status: 200, body: detailBody(recurring) },
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
   * screen, so a series opened from Plans completed a day that may be months back while the row
   * the user meant never moved. What a series detail screen should offer is P2-47's question;
   * absence is the honest answer until it has one.
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

  /** A completed occurrence is not readable from its series, so the agenda answers for it. */
  it('opens an already-completed occurrence showing Undo rather than the verb', async () => {
    const recurring = plan({
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TODAY, time: '08:00' }],
      },
    });
    stubFetch({ status: 200, body: detailBody(recurring) });
    // Arriving from a Today row, which is the only navigation that carries an occurrence.
    const { queryClient } = mount(
      () => {},
      () => {},
      undefined,
      TODAY,
    );
    queryClient.setQueryData<AgendaData>(['agenda', 'occurrence-state'], {
      days: [
        {
          date: TODAY,
          schedule: [
            {
              ...agendaItem(),
              status: 'completed',
              isRecurring: true,
              occurrenceDate: TODAY,
            },
          ],
          anytime: [],
          earlier: [],
        },
      ],
      warnings: [],
    });
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
