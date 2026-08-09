import type { Activity, ActivityDetail } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityDetailScreen } from './ActivityDetailScreen';

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
    type: 'outing',
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
    details: { kind: 'outing', placeName: 'Zahav' },
    icsSequence: 0,
    createdAt: '2026-08-08T10:00:00.000Z',
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

const detailBody = (activity: Activity, reminders: ActivityDetail['reminders'] = []) => ({
  data: { activity, reminders },
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

function mount(onBack = () => {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrap = (ui: ReactNode) => (
    <SafeAreaProvider>
      <ThemeProvider scheme="light">
        <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
  return render(
    wrap(<ActivityDetailScreen activityId={ID} today={TODAY} onBack={onBack} />),
  );
}

beforeEach(() => {
  sent.length = 0;
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
  it('keeps a Plan’s capabilities discoverable as disabled affordances', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await loaded();

    for (const label of ['Add people', 'Add prep task', 'Add list']) {
      expect(
        screen.getByRole('button', { name: label }).getAttribute('aria-disabled'),
      ).toBe('true');
    }
    expect(screen.getByText('Sharing is coming soon.')).toBeDefined();
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

  it('patches the schedule when a quick chip is chosen', async () => {
    stubFetch(
      { status: 200, body: detailBody(plan()) },
      { status: 200, body: { data: plan(), meta: { requestId: 'req_test' } } },
    );
    mount();
    await loaded();

    fireEvent.click(screen.getByTestId('when-where-date'));
    fireEvent.click(screen.getByTestId('quick-date-tomorrow'));

    await waitFor(() => expect(sent.filter((s) => s.method === 'PATCH')).toHaveLength(1));
    const patch = sent.find((s) => s.method === 'PATCH');
    expect(
      (patch?.body as { schedule?: { date: string } } | undefined)?.schedule?.date,
    ).toBe('2026-08-13');
    expect(patch?.headers['If-Match']).toBe('2026-08-08T10:00:00.000Z');
  });
});

describe('editing in place', () => {
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

  /** P1-26's decision: no completion button in Phase 1, disabled or otherwise. */
  it('has no completion button anywhere on the screen', async () => {
    stubFetch({ status: 200, body: detailBody(plan()) });
    mount();
    await loaded();

    for (const verb of ['Done', 'Complete', 'Attended', 'Had it', 'Watched']) {
      expect(screen.queryByRole('button', { name: verb })).toBeNull();
    }
  });
});
