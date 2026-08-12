import type { WallDate } from '@od/shared/time';
import { ThemeProvider } from '@od/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerActivityMutationDefaults } from '@/lib/mutationDefaults';
import { useComposeDraft } from '@/stores/composeDraft';
import { useToast } from '@/stores/toast';
import { ComposeScreen, type ComposeScreenProps } from './ComposeScreen';

/** Injected rather than read from a clock, so `This weekend` means the same in every run. */
const TODAY = '2026-08-12';
const ZONE = 'America/New_York';

/**
 * The Add flow end to end (P1-24).
 *
 * This is the Vitest half of the flow P1-24 specifies as a Maestro test: open the chooser,
 * assert the exact three labels, choose `Task`, type a title, tap `Save task`, and assert the
 * request carries `{ objectKind: 'task', type: 'task' }`. Maestro runs it on a simulator
 * (P1-29); this runs it on every commit, against the real store, the real model mapping and
 * the real shared client, with only the socket replaced.
 *
 * Queries are by role and accessible name (`testing.md` §5) — which also means the
 * assertions double as accessibility assertions.
 */

vi.mock('expo-crypto', () => ({ randomUUID: () => 'idem-test-key' }));

vi.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: () => Promise.resolve({ granted: true }),
  requestMediaLibraryPermissionsAsync: () => Promise.resolve({ granted: true }),
  launchCameraAsync: () => Promise.resolve({ canceled: true }),
  launchImageLibraryAsync: () => Promise.resolve({ canceled: true }),
}));

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

const sent: Sent[] = [];

/** A 201 whose body satisfies the shared `activity` schema, so nothing is faked past the wire. */
function createdBody(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      activityId: 'act_01J0000000000000000000000A',
      ownerId: 'usr_01J0000000000000000000000B',
      objectKind: 'task',
      type: 'task',
      status: 'saved',
      title: 'Call the dentist',
      participantCount: 0,
      childCount: 0,
      expenseTotalCents: 0,
      visibility: 'private',
      details: { kind: 'task' },
      icsSequence: 0,
      createdAt: '2026-08-08T10:00:00.000Z',
      lastActivityAt: '2026-08-08T10:00:00.000Z',
      updatedAt: '2026-08-08T10:00:00.000Z',
      schemaVersion: 1,
      ...overrides,
    },
    meta: { requestId: 'req_test' },
  };
}

function stubFetch(...responses: Array<{ status: number; body: unknown }>) {
  let call = 0;
  vi.stubGlobal('fetch', (url: string, init?: Record<string, unknown>) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({
      url,
      method: init?.method as string | undefined,
      headers,
      body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    const outcome = responses[Math.min(call, responses.length - 1)] ?? {
      status: 201,
      body: createdBody(),
    };
    call += 1;
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
  onClose = () => {},
  overrides: Partial<Omit<ComposeScreenProps, 'onClose' | 'today' | 'timezone'>> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
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
      <ComposeScreen onClose={onClose} today={TODAY} timezone={ZONE} {...overrides} />,
    ),
  );
}

beforeEach(() => {
  sent.length = 0;
  useComposeDraft.getState().open();
  useToast.getState().dismiss();
  stubFetch({ status: 201, body: createdBody() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const tap = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('the first screen', () => {
  it('asks the question and offers exactly Task, Plan, List item', () => {
    mount();

    expect(
      screen.getByRole('heading', { name: 'What would you like to add?' }),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Task' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Plan' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'List item' })).toBeDefined();
  });

  /**
   * The structural half of `CLAUDE.md` rule 2: there is no writable title field on this
   * screen, so there is no text for anything to classify before a target exists.
   */
  it('has no title field before a target is chosen', () => {
    mount();
    expect(screen.queryByLabelText('Title')).toBeNull();
  });

  it('sends no request of any kind before a choice is made', () => {
    mount();
    expect(sent).toHaveLength(0);
  });
});

describe("Today's contextual Task entry", () => {
  it('bypasses both choosers and saves the fixed Task target on today without a time', async () => {
    useComposeDraft.getState().openTodayTask(TODAY as WallDate);
    mount();

    expect(
      screen.queryByRole('heading', { name: 'What would you like to add?' }),
    ).toBeNull();
    expect(screen.getByText('Task')).toBeDefined();
    expect(screen.getByLabelText('Title')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save task' })).toBeDefined();

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Dinner with Alice' },
    });
    tap('Save task');

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toMatchObject({
      objectKind: 'task',
      type: 'task',
      schedule: { date: TODAY, timezone: ZONE },
    });
    const body = sent[0]?.body as { schedule?: { time?: string } } | undefined;
    expect(body?.schedule?.time).toBeUndefined();
  });
});

describe('Task', () => {
  it('opens the form with the target named in the header', () => {
    mount();
    tap('Task');
    expect(screen.getByText('Task')).toBeDefined();
    expect(screen.getByLabelText('Title')).toBeDefined();
  });

  it('names the write on its button', () => {
    mount();
    tap('Task');
    expect(screen.getByRole('button', { name: 'Save task' })).toBeDefined();
  });

  /**
   * React Native Web omits `aria-disabled` entirely when a control is enabled rather than
   * writing `"false"`, so the enabled assertion is `toBeNull()`. Asserting `'false'` would
   * pass for a button that was never rendered disabled in the first place.
   */
  it('enables the write as soon as the title is non-empty after trimming', () => {
    mount();
    tap('Task');

    const disabledState = () =>
      screen.getByRole('button', { name: 'Save task' }).getAttribute('aria-disabled');

    expect(disabledState()).toBe('true');

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '   ' } });
    expect(disabledState()).toBe('true');

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Call the dentist' },
    });
    expect(disabledState()).toBeNull();
  });

  /** P1-24's headline assertion. */
  it('posts one request carrying objectKind task and type task', async () => {
    const onClose = vi.fn();
    mount(onClose);

    tap('Task');
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Call the dentist' },
    });
    tap('Save task');

    await waitFor(() => expect(sent).toHaveLength(1));

    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.url).toMatch(/\/v1\/activities$/);
    expect(sent[0]?.body).toMatchObject({ objectKind: 'task', type: 'task' });
    expect(sent[0]?.headers['Idempotency-Key']).toBe('idem-test-key');
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('names where it landed in the toast, after the form dismisses', async () => {
    mount();
    tap('Task');
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Call the dentist' },
    });
    tap('Save task');

    await waitFor(() =>
      expect(useToast.getState().current?.message).toBe('Task · saved to Anytime'),
    );
  });
});

describe('Plan', () => {
  it('requires a second choice, with nothing selected', () => {
    mount();
    tap('Plan');

    expect(screen.getByRole('heading', { name: 'What kind of plan?' })).toBeDefined();
    for (const label of ['General', 'Meal', 'Watch', 'Event']) {
      expect(screen.getByRole('button', { name: label })).toBeDefined();
    }
    expect(screen.queryByLabelText('Title')).toBeNull();
  });

  it('posts objectKind plan with the chosen kind', async () => {
    mount();
    tap('Plan');
    tap('Watch');

    expect(screen.getByText('Plan · Watch')).toBeDefined();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Severance' } });
    tap('Save plan');

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toMatchObject({
      objectKind: 'plan',
      type: 'watch',
      title: 'Severance',
      details: { kind: 'watch', mediaTitle: 'Severance' },
    });
  });

  it('treats General as an explicit choice that stores custom', async () => {
    mount();
    tap('Plan');
    tap('General');

    expect(screen.getByText('Plan · General')).toBeDefined();

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Practice guitar' },
    });
    tap('Save plan');

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toMatchObject({ objectKind: 'plan', type: 'custom' });
  });

  it('Change returns to the kind chooser and keeps the title', () => {
    mount();
    tap('Plan');
    tap('Meal');
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Chicken tacos' },
    });

    tap('Change');

    expect(screen.getByRole('heading', { name: 'What kind of plan?' })).toBeDefined();
    tap('Event');
    expect(screen.getByLabelText('Title').getAttribute('value')).toBe('Chicken tacos');
  });

  it('waits for a cold profile before opening Event and sends its currency', async () => {
    let resolveDefaults:
      | ((value: { reservationName: string; currency: string }) => void)
      | undefined;
    const loadEventDefaults = vi.fn(
      () =>
        new Promise<{ reservationName: string; currency: string }>((resolve) => {
          resolveDefaults = resolve;
        }),
    );
    mount(() => {}, { loadEventDefaults });

    tap('Plan');
    tap('Event');
    expect(loadEventDefaults).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText('Title')).toBeNull();

    resolveDefaults?.({ reservationName: 'Ada', currency: 'USD' });
    await waitFor(() => expect(screen.getByLabelText('Title')).toBeDefined());

    tap('Reservation');
    expect(screen.getByLabelText('Reservation name').getAttribute('value')).toBe('Ada');
    tap('Tickets & details');
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '18.50' } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Concert' } });
    tap('Save plan');

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toMatchObject({
      objectKind: 'plan',
      type: 'event',
      details: {
        kind: 'event',
        priceCents: 1850,
        currency: 'USD',
        reservation: { name: 'Ada' },
      },
    });
  });
});

describe('List item', () => {
  it('is honoured as a choice and creates nothing in Phase 1', () => {
    mount();
    tap('List item');

    expect(screen.getByText('Lists are coming soon.')).toBeDefined();
    expect(screen.queryByLabelText('Title')).toBeNull();
    expect(sent).toHaveLength(0);
  });
});

describe('closing', () => {
  it('closes straight away when nothing has been typed', () => {
    const onClose = vi.fn();
    mount(onClose);
    tap('Task');
    // The form's close control, not the chooser's Cancel.
    tap('Close');
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('heading', { name: 'Discard this?' })).toBeNull();
  });

  it('asks Discard this? when there is content, and Keep editing returns to the draft', () => {
    const onClose = vi.fn();
    mount(onClose);
    tap('Task');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Something' } });

    tap('Close');

    expect(screen.getByRole('heading', { name: 'Discard this?' })).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();

    tap('Keep editing');
    expect(screen.getByLabelText('Title').getAttribute('value')).toBe('Something');
  });

  it('Discard clears the draft and closes, writing nothing', () => {
    const onClose = vi.fn();
    mount(onClose);
    tap('Task');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Something' } });

    tap('Close');
    tap('Discard');

    expect(onClose).toHaveBeenCalledOnce();
    expect(useComposeDraft.getState().title).toBe('');
    expect(sent).toHaveLength(0);
  });
});

describe('a failed save', () => {
  /** §5.3: the form stays open with its draft intact and an inline banner naming the failure. */
  it('keeps the draft and shows the message and request id', async () => {
    const onClose = vi.fn();
    stubFetch({
      status: 400,
      body: {
        error: {
          code: 'validation_failed',
          message: 'A title is required',
          requestId: 'req_failed',
          details: [{ path: 'title', message: 'A title is required' }],
        },
      },
    });
    mount(onClose);

    tap('Task');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'x' } });
    tap('Save task');

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());

    /**
     * Twice, and that is the contract rather than a duplicate: `activities.md` §3 rule 5
     * puts each `details[]` entry inline on the field it names, and §5.3 puts the failure in
     * a banner. Both are asserted here so that removing either is a failing test.
     */
    expect(screen.getAllByText('A title is required')).toHaveLength(2);
    expect(screen.getByLabelText('Title').getAttribute('aria-invalid')).toBe('true');

    expect(screen.getByText('req_failed')).toBeDefined();
    expect(screen.getByLabelText('Title').getAttribute('value')).toBe('x');
    expect(onClose).not.toHaveBeenCalled();
  });
});
