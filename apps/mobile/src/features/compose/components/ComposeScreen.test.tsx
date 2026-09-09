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
 * This is the Vitest half of the flow P1-24 specifies as a Maestro test: open the sheet,
 * type a title, choose `Task`, tap `Create task`, and assert the request carries
 * `{ objectKind: 'task', type: 'task' }`. Maestro runs it on a simulator
 * (P1-29); this runs it on every commit, against the real store, the real model mapping and
 * the real shared client, with only the socket replaced.
 *
 * Queries are by role and accessible name (`testing.md` §5) — which also means the
 * assertions double as accessibility assertions.
 */

vi.mock('expo-crypto', () => ({
  getRandomBytes: (count: number) =>
    Uint8Array.from({ length: count }, (_, index) => index),
  randomUUID: () => 'idem-test-key',
}));

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
  suppliedClient?: QueryClient,
) {
  const queryClient =
    suppliedClient ??
    new QueryClient({
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

/**
 * A chooser row's accessible name carries its subtitle, §6.2's comma-joined grammar — so the
 * queries match on the label prefix rather than restating copy that `targets.test.ts` pins.
 */
const chooser = (label: string) =>
  screen.getByRole('button', { name: new RegExp(`^${label},`) });
const tapChoice = (label: string) => fireEvent.click(chooser(label));

/** Global Add's category rows stay disabled until this field has a real title. */
function typeGlobalTitle(value = 'Call the dentist') {
  fireEvent.change(screen.getByLabelText('What would you like to add?'), {
    target: { value },
  });
}

function chooseWithTitle(label: string, title = 'Call the dentist') {
  typeGlobalTitle(title);
  tapChoice(label);
}

describe('the first screen', () => {
  it('asks the question and offers exactly Task, Plan, and Add list', () => {
    mount();

    expect(screen.getByLabelText('What would you like to add?')).toBeDefined();
    expect(chooser('Task')).toBeDefined();
    expect(chooser('Plan')).toBeDefined();
    expect(chooser('Add list')).toBeDefined();
    expect(screen.queryByRole('button', { name: /^List item,/ })).toBeNull();
  });

  it('opens ordinary List creation without entering a global List-item form', () => {
    mount();

    chooseWithTitle('Add list');

    expect(screen.getByTestId('list-style-chooser')).toBeDefined();
    expect(screen.queryByTestId('list-destination-chooser')).toBeNull();
    expect(useComposeDraft.getState().step).toBe('object');
    expect(useComposeDraft.getState().target).toBeUndefined();
    expect(useComposeDraft.getState().objectChoice).toBe('list');
  });

  /**
   * Every row says what it is for (founder, 2026-08-16), rendered **and** spoken — the sentence
   * goes to `accessibilityHint` rather than into the accessible name, so the row is still
   * announced `Task, button` and the one word the user is listening for arrives first.
   */
  it('says what each choice is for', () => {
    mount();
    for (const [name, subtitle] of [
      ['Task', 'Something you need to do'],
      ['Plan', 'Something you intend to make happen'],
      ['Add list', 'A collection for things you want to keep track of'],
    ] as const) {
      expect(screen.getByText(subtitle)).toBeDefined();
      // Spoken as well as shown: the sentence is inside the row's accessible name.
      expect(chooser(name).getAttribute('aria-label')).toBe(`${name}, ${subtitle}`);
    }
  });

  /**
   * The title is present before a category, but capture is not. Words still cannot choose
   * the object (`CLAUDE.md` rule 2).
   */
  it('has a title field before a target is chosen, and no capture yet', () => {
    mount();
    expect(screen.getByLabelText('What would you like to add?')).toBeDefined();
    expect(screen.getByTestId('compose-title')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Photos' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a link' })).toBeNull();
  });

  it('sends no request of any kind before a choice is made', () => {
    mount();
    expect(sent).toHaveLength(0);
  });

  it('disables Task, Plan, and Add list until the title has a non-empty trimmed value', () => {
    mount();

    for (const name of ['Task', 'Plan', 'Add list'] as const) {
      expect(chooser(name).getAttribute('aria-disabled')).toBe('true');
    }

    typeGlobalTitle('   ');
    for (const name of ['Task', 'Plan', 'Add list'] as const) {
      expect(chooser(name).getAttribute('aria-disabled')).toBe('true');
    }
    tapChoice('Task');
    expect(useComposeDraft.getState().objectChoice).toBeUndefined();
    expect(screen.queryByTestId('compose-form')).toBeNull();

    typeGlobalTitle('Call the dentist');
    for (const name of ['Task', 'Plan', 'Add list'] as const) {
      expect(chooser(name).getAttribute('aria-disabled')).toBeNull();
    }
  });

  it.each([
    ['Task', 'compose-form'],
    ['Plan', 'plan-kind-chooser'],
    ['Add list', 'list-style-chooser'],
  ] as const)('reveals %s next controls after a title and choice', (label, testId) => {
    mount();
    expect(screen.queryByTestId(testId)).toBeNull();
    chooseWithTitle(label);
    expect(screen.getByTestId(testId)).toBeDefined();
  });
});

/**
 * **Progressive disclosure changes what is visible; it may never change what is selected**
 * (P2-43, and `CLAUDE.md` rule 2 underneath it). These are the required assertions, not
 * optional ones: the two choosers open with nothing chosen, and no revealed control arrives
 * pre-filled because it became visible.
 */
describe('nothing is ever pre-selected', () => {
  it.each(['Task', 'Plan', 'Add list'])(
    'the object chooser opens %s unselected',
    (name) => {
      mount();
      const row = chooser(name);
      expect(row.getAttribute('aria-pressed')).toBe('false');
      expect(row.getAttribute('aria-selected')).toBeNull();
      expect(row.getAttribute('aria-checked')).toBeNull();
    },
  );

  it.each(['General', 'Meal', 'Watch', 'Event'])(
    'the Plan-kind chooser opens %s unselected',
    (name) => {
      mount();
      chooseWithTitle('Plan');
      const row = chooser(name);
      expect(row.getAttribute('aria-pressed')).toBe('false');
      expect(row.getAttribute('aria-selected')).toBeNull();
      expect(row.getAttribute('aria-checked')).toBeNull();
    },
  );

  it('leaves the draft with no target until a row is tapped', () => {
    mount();
    expect(useComposeDraft.getState().target).toBeUndefined();
    chooseWithTitle('Plan');
    expect(useComposeDraft.getState().target).toBeUndefined();
    tapChoice('General');
    expect(useComposeDraft.getState().target).toEqual({
      objectKind: 'plan',
      type: 'custom',
    });
  });

  /**
   * The one that would be easy to get wrong: revealing Time when a date is picked must not also
   * fill it, and revealing Reminder must not choose an offset. `+ Reminder` is an action, not a
   * populated row, precisely so there is no value on screen the user did not put there.
   */
  it('reveals Time and Reminder empty when a date makes them relevant', () => {
    mount();
    chooseWithTitle('Task');
    tap('Today');

    expect(useComposeDraft.getState().schedule.time).toBeUndefined();
    expect(useComposeDraft.getState().reminderOffset).toBeUndefined();

    expect(screen.getByTestId('compose-time')).toBeDefined();
    expect(screen.getByTestId('compose-reminder-row').textContent).toContain('Off');
  });
});

/**
 * §2.5's final-button table, on the screen rather than only in `targets.test.ts`. A generic
 * `Save` here is a defect: the button is the last moment the user can see what will be written
 * and where.
 */
describe('the pinned named write', () => {
  it('reads Create task for a Task', () => {
    mount();
    chooseWithTitle('Task');
    expect(screen.getByRole('button', { name: 'Create task' })).toBeDefined();
  });

  it.each(['General', 'Meal', 'Watch', 'Event'])(
    'reads Create plan for a %s Plan',
    (kind) => {
      mount();
      chooseWithTitle('Plan');
      tapChoice(kind);
      expect(screen.getByRole('button', { name: 'Create plan' })).toBeDefined();
    },
  );

  it('does not render a global List-item commit', () => {
    mount();
    chooseWithTitle('Add list');
    expect(screen.queryByRole('button', { name: 'Choose a list' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Add to / })).toBeNull();
    expect(screen.getByRole('button', { name: 'Create list' })).toBeDefined();
  });

  /** Pinned, so it is reachable without scrolling the form it commits. */
  it('sits in the screen shell footer, outside the scrolling form', () => {
    mount();
    chooseWithTitle('Task');

    const save = screen.getByRole('button', { name: 'Create task' });
    expect(screen.getByTestId('compose-form').contains(save)).toBe(false);
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
    chooseWithTitle('Task');
    expect(screen.getByTestId('compose-target-heading').textContent).toBe('Task');
    expect(screen.getByLabelText('Title')).toBeDefined();
  });

  it('names the write on its button', () => {
    mount();
    chooseWithTitle('Task');
    expect(screen.getByRole('button', { name: 'Create task' })).toBeDefined();
  });

  /**
   * React Native Web omits `aria-disabled` entirely when a control is enabled rather than
   * writing `"false"`, so the enabled assertion is `toBeNull()`. Asserting `'false'` would
   * pass for a button that was never rendered disabled in the first place.
   */
  it('enables the write as soon as the title is non-empty after trimming', () => {
    mount();
    chooseWithTitle('Task');

    const disabledState = () =>
      screen.getByRole('button', { name: 'Create task' }).getAttribute('aria-disabled');

    expect(disabledState()).toBeNull();

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

    chooseWithTitle('Task');
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Call the dentist' },
    });
    tap('Create task');

    await waitFor(() => expect(sent).toHaveLength(1));

    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.url).toMatch(/\/v1\/activities$/);
    expect(sent[0]?.body).toMatchObject({ objectKind: 'task', type: 'task' });
    expect(sent[0]?.body).toMatchObject({
      activityId: expect.stringMatching(/^act_[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
    });
    expect(sent[0]?.headers['Idempotency-Key']).toBe('idem-test-key');
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('names where it landed in the toast, after the form dismisses', async () => {
    mount();
    chooseWithTitle('Task');
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Call the dentist' },
    });
    tap('Create task');

    await waitFor(() =>
      expect(useToast.getState().current?.message).toBe('Task · saved to Anytime'),
    );
  });
});

describe('Plan', () => {
  it('requires a second choice, with nothing selected', () => {
    mount();
    chooseWithTitle('Plan');

    expect(screen.getByRole('heading', { name: 'What kind of plan?' })).toBeDefined();
    for (const label of ['General', 'Meal', 'Watch', 'Event']) {
      expect(chooser(label)).toBeDefined();
    }
    // Each kind says what it is for, from §1.1's own "Guides creation of" column.
    expect(screen.getByText('Something to eat or cook')).toBeDefined();
    expect(screen.getByText('A movie, show, or episode')).toBeDefined();
    expect(screen.getByLabelText('What would you like to add?')).toBeDefined();
    expect(screen.queryByTestId('compose-form')).toBeNull();
  });

  it('posts objectKind plan with the chosen kind', async () => {
    mount();
    chooseWithTitle('Plan');
    tapChoice('Watch');

    expect(screen.getByText('Plan · Watch')).toBeDefined();

    // §4.3's own name for the title row. The frame asks the table rather than saying `Title`.
    fireEvent.change(screen.getByLabelText('Movie or show'), {
      target: { value: 'Severance' },
    });
    tap('Create plan');

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
    chooseWithTitle('Plan');
    tapChoice('General');

    expect(screen.getByText('Plan · General')).toBeDefined();

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Practice guitar' },
    });
    tap('Create plan');

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toMatchObject({ objectKind: 'plan', type: 'custom' });
  });

  it('keeps the title when switching Plan kind inline', () => {
    mount();
    chooseWithTitle('Plan');
    tapChoice('Meal');
    fireEvent.change(screen.getByLabelText('Meal'), {
      target: { value: 'Chicken tacos' },
    });

    tapChoice('Event');
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

    chooseWithTitle('Plan');
    tapChoice('Event');
    expect(loadEventDefaults).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText('Title')).toBeNull();

    resolveDefaults?.({ reservationName: 'Ada', currency: 'USD' });
    await waitFor(() => expect(screen.getByLabelText('Title')).toBeDefined());

    // Reservation and Tickets sit behind `More options` since P2-43.
    fireEvent.click(screen.getByRole('button', { name: /^More options/ }));
    tap('Reservation');
    expect(screen.getByLabelText('Reservation name').getAttribute('value')).toBe('Ada');
    tap('Tickets & details');
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '18.50' } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Concert' } });
    tap('Create plan');

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

  it('does not apply Event defaults after the user has chosen Task', async () => {
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

    chooseWithTitle('Plan');
    tapChoice('Event');
    tapChoice('Task');
    expect(useComposeDraft.getState().objectChoice).toBe('task');
    expect(useComposeDraft.getState().target).toEqual({
      objectKind: 'task',
      type: 'task',
    });

    resolveDefaults?.({ reservationName: 'Ada', currency: 'USD' });
    await waitFor(() => expect(loadEventDefaults).toHaveBeenCalledOnce());
    expect(useComposeDraft.getState().objectChoice).toBe('task');
    expect(useComposeDraft.getState().target).toEqual({
      objectKind: 'task',
      type: 'task',
    });
  });

  it('does not apply Event defaults after the user has chosen another Plan kind', async () => {
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

    chooseWithTitle('Plan');
    tapChoice('Event');
    tapChoice('Meal');
    expect(useComposeDraft.getState().target).toEqual({
      objectKind: 'plan',
      type: 'meal',
    });

    resolveDefaults?.({ reservationName: 'Ada', currency: 'USD' });
    await waitFor(() => expect(loadEventDefaults).toHaveBeenCalledOnce());
    expect(useComposeDraft.getState().target).toEqual({
      objectKind: 'plan',
      type: 'meal',
    });
  });
});

/** List-item creation is contextual; global Add only launches ordinary List creation. */
describe('Add list', () => {
  it('opens the ordinary List catalogue from the chooser', () => {
    mount();
    chooseWithTitle('Add list');
    expect(screen.getByTestId('list-style-chooser')).toBeDefined();
    expect(screen.getByTestId('list-style-blank')).toBeDefined();
  });

  it('never renders the removed global List-item form', () => {
    mount();
    chooseWithTitle('Add list');
    expect(screen.queryByTestId('list-destination-chooser')).toBeNull();
    expect(screen.queryByLabelText('Note')).toBeNull();
    expect(screen.queryByTestId('compose-form')).toBeNull();
  });

  it('leaves the Activity draft without a target', () => {
    mount();
    chooseWithTitle('Add list');
    expect(useComposeDraft.getState().step).toBe('object');
    expect(useComposeDraft.getState().target).toBeUndefined();
  });

  it('sends no Activity or List-item request', () => {
    mount();
    chooseWithTitle('Add list');
    expect(sent).toHaveLength(0);
  });

  it('does not expose capture controls before the List catalogue', () => {
    mount();
    chooseWithTitle('Add list');
    expect(screen.queryByRole('button', { name: 'Photos' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a link' })).toBeNull();
  });

  it('keeps the title and chooser visible with the catalogue', () => {
    mount();
    chooseWithTitle('Add list');
    expect(screen.getByLabelText('List name')).toBeDefined();
    expect(chooser('Add list')).toBeDefined();
  });

  it('keeps the typed title when a style is chosen, and does not write the default', async () => {
    const save = vi.fn(async () => 'lst_01J0000000000000000000000L');
    mount(undefined, {
      listWriter: {
        save,
        isCreating: false,
        errorMessage: undefined,
        errorRequestId: undefined,
      },
    });

    chooseWithTitle('Add list', 'Movies and shows');
    fireEvent.click(screen.getByTestId('list-style-watch-later'));

    expect(screen.getByLabelText('List name').getAttribute('value')).toBe(
      'Movies and shows',
    );
    tap('Create list');

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith('watch-later', 'Movies and shows');
  });

  it('retains the title when switching from Task to List', () => {
    mount();
    chooseWithTitle('Task', 'Try Zahav');
    tapChoice('Add list');
    expect(screen.getByLabelText('List name').getAttribute('value')).toBe('Try Zahav');
    expect(useComposeDraft.getState().target).toBeUndefined();
  });
});

describe('closing', () => {
  it('closes straight away when nothing has been typed', () => {
    const onClose = vi.fn();
    mount(onClose);
    // Category rows are disabled without a title; closing an empty sheet just closes.
    tap('Close');
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('heading', { name: 'Discard this?' })).toBeNull();
  });

  it('asks Discard this? when there is content, and Keep editing returns to the draft', () => {
    const onClose = vi.fn();
    mount(onClose);
    chooseWithTitle('Task');
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
    chooseWithTitle('Task');
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

    chooseWithTitle('Task');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'x' } });
    tap('Create task');

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

/**
 * `+ Add prep task` (P3-38): the parent Plan's labelled action fixes both the object and the
 * relationship, and the same words through the global chooser fix neither.
 */
describe('the prep-task contextual entry', () => {
  const PARENT = 'act_01J0000000000000000000000P';

  it('opens the Task form directly with Save task and sends the fixed parent', async () => {
    const onClose = vi.fn();
    useComposeDraft.getState().openPrepTask(PARENT);
    mount(onClose);

    // No chooser step: the plan's action was the explicit Task choice.
    expect(
      screen.queryByRole('heading', { name: 'What would you like to add?' }),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Book hotel' },
    });
    tap('Save task');

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const request = sent.find((call) => call.url.includes('/v1/activities'));
    expect(request?.body).toMatchObject({
      objectKind: 'task',
      type: 'task',
      title: 'Book hotel',
      parentActivityId: PARENT,
    });
  });

  it('drops the parent when Change backs out to the global chooser', async () => {
    const onClose = vi.fn();
    useComposeDraft.getState().openPrepTask(PARENT);
    mount(onClose);

    // Backing out abandons the labelled context; what follows is an ordinary global add,
    // and no path through the chooser may carry the prep relationship silently.
    tap('Change');
    expect(screen.getByLabelText('What would you like to add?')).toBeDefined();
    chooseWithTitle('Task');
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Book hotel' },
    });
    tap('Create task');

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const request = sent.find((call) => call.url.includes('/v1/activities'));
    expect(request?.body).toMatchObject({ objectKind: 'task', type: 'task' });
    expect(request?.body).not.toHaveProperty('parentActivityId');
  });

  it('leaves the same words a standalone custom Plan through the global chooser', async () => {
    const onClose = vi.fn();
    mount(onClose);

    chooseWithTitle('Plan');
    tapChoice('General');
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Book hotel' },
    });
    tap('Create plan');

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const request = sent.find((call) => call.url.includes('/v1/activities'));
    expect(request?.body).toMatchObject({ objectKind: 'plan', type: 'custom' });
    expect(request?.body).not.toHaveProperty('parentActivityId');
  });
});

/**
 * The `Plan this item` bridge flow (P3-34, `plans-and-lists.md` §6).
 *
 * The Vitest half of the flow the task specifies for Playwright: kind step with nothing
 * selected, the required audience step, the pre-filled form, and one bridge request whose
 * body carries exactly the two explicit choices. Runs against the real store, the real
 * adapter and the real shared client, with only the socket replaced.
 */
describe('the Plan this item bridge flow', () => {
  const LIST = 'lst_01J0000000000000000000000C';
  const ITEM = 'itm_01J0000000000000000000000M';

  function scheduledBody(type: 'watch' | 'custom') {
    const details =
      type === 'watch' ? { kind: 'watch', mediaTitle: 'Severance' } : { kind: 'custom' };
    return {
      data: {
        activity: {
          ...createdBody().data,
          objectKind: 'plan',
          type,
          title: 'Severance',
          details,
          listId: LIST,
          listItemId: ITEM,
        },
        item: {
          itemId: ITEM,
          listId: LIST,
          rank: 'a0',
          title: 'Severance',
          state: 'active',
          features: {
            progress: { kind: 'episode', mediaKind: 'show', season: 2, episode: 4 },
          },
        },
        viewerLink: {
          listId: LIST,
          itemId: ITEM,
          viewerUserId: 'usr_01J0000000000000000000000B',
          activityId: 'act_01J0000000000000000000000A',
          linkedAt: '2026-08-12T10:00:00.000Z',
        },
      },
      meta: { requestId: 'req_test' },
    };
  }

  function openBridge() {
    useComposeDraft.getState().openPlanForItem({
      listId: LIST,
      itemId: ITEM,
      list: { featureConfig: { progress: { enabled: true, kind: 'episode' } } },
      item: {
        title: 'Severance',
        features: {
          progress: { kind: 'episode', mediaKind: 'show', season: 2, episode: 4 },
        },
        state: 'active',
      },
    });
  }

  it('opens on the unselected kind step with no way further back', () => {
    openBridge();
    mount();

    expect(screen.getByRole('heading', { name: 'What kind of plan?' })).toBeDefined();
    for (const kind of ['General', 'Meal', 'Watch', 'Event']) {
      expect(chooser(kind)).toBeDefined();
    }
    expect(screen.queryByTestId('compose-back')).toBeNull();
    expect(screen.queryByLabelText('Title')).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('keeps the form closed until Just me is visibly tapped, then pre-fills S2 E5', () => {
    openBridge();
    mount();

    tapChoice('Watch');

    // The audience step, not the form: no title field, no save action yet. Watch's title
    // field is labelled `Movie or show` (`fields.ts`), so that is the absence to assert.
    expect(screen.getByRole('heading', { name: 'Who is this plan for?' })).toBeDefined();
    expect(screen.queryByLabelText('Movie or show')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save plan' })).toBeNull();
    expect(useComposeDraft.getState().audience).toBeUndefined();

    tapChoice('Just me');

    expect(useComposeDraft.getState().audience).toEqual({ mode: 'just_me' });
    expect(screen.getByLabelText('Movie or show')).toHaveProperty('value', 'Severance');
    // The active item at S2 E4 offers the next episode, editable (§P3-34).
    expect(useComposeDraft.getState().details.season).toBe('2');
    expect(useComposeDraft.getState().details.episode).toBe('5');
    expect(sent).toHaveLength(0);
  });

  it('sends one bridge request carrying the explicit kind, audience and edited episode', async () => {
    stubFetch({ status: 201, body: scheduledBody('watch') });
    openBridge();
    const onClose = vi.fn();
    mount(onClose);

    tapChoice('Watch');
    tapChoice('Just me');
    fireEvent.change(screen.getByLabelText('Episode'), { target: { value: '6' } });
    tap('Save plan');

    await waitFor(() =>
      expect(sent.filter((call) => call.url.includes('/schedule'))).toHaveLength(1),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const request = sent.find((call) => call.url.includes('/schedule'));
    expect(request?.url).toContain(`/v1/lists/${LIST}/items/${ITEM}/schedule`);
    expect(request?.headers['Idempotency-Key']).toBeDefined();
    expect(request?.body).toMatchObject({
      creationTarget: { objectKind: 'plan', type: 'watch' },
      audience: { mode: 'just_me' },
      details: { kind: 'watch', season: 2, episode: 6 },
    });
    const body = request?.body as { activityId?: unknown } | undefined;
    expect(typeof body?.activityId).toBe('string');
  });

  it('stores custom when General is chosen on a Watch-configured list', async () => {
    stubFetch({ status: 201, body: scheduledBody('custom') });
    openBridge();
    const onClose = vi.fn();
    mount(onClose);

    tapChoice('General');
    tapChoice('Just me');
    tap('Save plan');

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const request = sent.find((call) => call.url.includes('/schedule'));
    expect(request?.body).toMatchObject({
      creationTarget: { objectKind: 'plan', type: 'custom' },
    });
    // Neither the list configuration nor the item words chose the kind: no episode fields
    // exist in a General form and none were sent.
    expect(request?.body).not.toHaveProperty('details.season');
  });

  it('shows the audience step unselected again after Back from the form', () => {
    openBridge();
    mount();

    tapChoice('Watch');
    tapChoice('Just me');
    fireEvent.click(screen.getByTestId('compose-back'));

    expect(screen.getByRole('heading', { name: 'Who is this plan for?' })).toBeDefined();
    expect(useComposeDraft.getState().audience).toBeUndefined();
    // The kind stays fixed: only the kind step itself may change it (§P3-34).
    expect(useComposeDraft.getState().target).toEqual({
      objectKind: 'plan',
      type: 'watch',
    });
  });
});
