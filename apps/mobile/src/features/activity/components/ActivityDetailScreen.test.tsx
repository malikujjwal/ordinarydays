import type { Activity, ActivityDetail } from '@od/shared/types';
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
  return render(
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

  it('renders the title, the schedule and the notes', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await loaded();

    expect(fieldValue('Title')).toBe('Zahav');
    expect(screen.getByText('Fri 14 Aug · 7:00 PM')).toBeDefined();
    expect(fieldValue('Notes')).toBe('Check-in is after 3 PM.');
  });

  it('uses icon-only header controls with complete accessible names', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await loaded();

    expect(screen.getByRole('button', { name: 'Back' }).textContent).toBe('');
    expect(screen.getByRole('button', { name: 'More' }).textContent).toBe('');
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

    expect(screen.getByText('Remind me · 15 minutes before')).toBeDefined();
  });

  it('hides the reminder row entirely when there is no date to count back from', async () => {
    stubFetch({ status: 200, body: detailBody(plan({ schedule: undefined })) });
    mount();
    await loaded();

    expect(screen.queryByTestId('when-where-reminders')).toBeNull();
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
  /**
   * P2-41 replaces P1-26's disabled affordances with absence.
   *
   * `plans-and-lists.md` §2's collapse rule governs a capability that **exists and is empty**;
   * it does not govern one that is **not built**. A row reading "Sharing is coming soon" is a
   * dead affordance promising something the app cannot do. The four return when the phase that
   * builds them returns them, as real §2 collapsed rows with content behind them.
   */
  it('renders no unbuilt capability as a disabled affordance', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await loaded();

    for (const label of ['Add people', 'Add prep task', 'Add list', 'Add']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
    for (const heading of ['People', 'Prep', 'Lists', 'Attachments']) {
      expect(screen.queryByText(heading)).toBeNull();
    }
    expect(document.body.textContent).not.toMatch(/coming soon/i);
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

describe('passed-plan resolution', () => {
  it('shows the same prompt at the top and sends the exact positive outcome', async () => {
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
    expect(
      prompt.compareDocumentPosition(screen.getByLabelText('Title')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
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
    // Resolving one occurrence must not reveal a control that can mutate the whole series.
    expect(screen.queryByTestId('detail-complete')).toBeNull();
  });

  it('does not widen to a series action after the route clears the prompt marker', async () => {
    const recurring = plan({
      schedule: { date: TODAY, time: '08:00', timezone: 'America/New_York' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: TODAY, time: '08:00' }],
      },
    });
    stubFetch({ status: 200, body: detailBody(recurring) });
    mount(
      () => {},
      () => {},
      undefined,
      TODAY,
    );
    await loaded();

    expect(screen.queryByTestId('detail-resolution-prompt')).toBeNull();
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
    expect(screen.queryByLabelText('Fri 14 Aug · 7:00 PM')).toBeNull();
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

    fireEvent.click(screen.getByRole('button', { name: 'Daily, change repeat' }));
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
      expect(
        screen.getByRole('button', { name: 'Every weekday, change repeat' }),
      ).toBeDefined(),
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
          data: { activity: plan(), outcome: null },
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
          data: { activity: scheduled, outcome: null },
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
