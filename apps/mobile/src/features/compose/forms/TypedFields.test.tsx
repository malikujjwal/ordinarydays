import type { ActivityType } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_DETAILS,
  EMPTY_LOCATION,
  EMPTY_SCHEDULE,
} from '@/features/compose/model/draft';
import { fieldRegions } from '@/features/compose/model/fields';
import type { AttachmentUploadController } from '@/hooks/useAttachmentUpload';
import { TypedFields, type TypedFieldsProps } from './TypedFields';

/**
 * `expo-crypto` is a native module with no jsdom implementation, and P3-17 puts a real `ing_`
 * ULID behind every new ingredient row ({@link newIngredient}). Deterministic bytes keep the
 * minted ids stable so a test can assert identity rather than merely non-emptiness.
 */
vi.mock('expo-crypto', () => ({
  getRandomBytes: (count: number) =>
    Uint8Array.from({ length: count }, (_, index) => index),
  randomUUID: () => 'idem-test-key',
}));

vi.mock('expo-image-picker', () => ({
  launchCameraAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
  requestCameraPermissionsAsync: vi.fn(),
  requestMediaLibraryPermissionsAsync: vi.fn(),
}));

/**
 * The five forms, asserted against the five tables (P1-25) and against P2-43's disclosure.
 *
 * The expectation is **derived from `fieldRegions`** on purpose, and that is not circular:
 * `fields.test.ts` pins the tables against `activities.md` §4 with literal lists and pins the
 * split's three structural properties, so a field added in the wrong place fails there, and a
 * field the renderer forgets to draw fails here. Together they say "the table is the spec, and
 * the form is the table".
 */
const TODAY = '2026-08-12';
const DATED = {
  date: '2026-08-15',
  time: undefined,
  endTime: undefined,
  timeFromSlot: false,
} as const;
const TIMED = { ...DATED, time: '19:00' } as const;

const wrap = (ui: ReactNode) =>
  render(
    <SafeAreaProvider>
      <ThemeProvider scheme="light">{ui}</ThemeProvider>
    </SafeAreaProvider>,
  );

/** No photos, nothing moving: the picker renders its two buttons and nothing else. */
const idleAttachments: AttachmentUploadController = {
  uploads: [],
  refusal: undefined,
  pick: vi.fn(async () => {}),
  retry: vi.fn(),
  remove: vi.fn(),
  busy: false,
  attachmentIds: [],
};

function mount(type: ActivityType, overrides: Partial<TypedFieldsProps> = {}) {
  const props: TypedFieldsProps = {
    type,
    title: '',
    schedule: EMPTY_SCHEDULE,
    location: EMPTY_LOCATION,
    reminderOffset: undefined,
    details: EMPTY_DETAILS,
    notes: '',
    sourceUrl: undefined,
    attachments: idleAttachments,
    listBridge: {
      groceriesTitle: undefined,
      groceriesState: undefined,
      watchTitle: undefined,
      watchState: undefined,
      alsoAddToList: false,
      onAlsoAddToListChange: vi.fn(),
      onChangeDestination: vi.fn(),
    },
    today: TODAY,
    onDateChange: vi.fn(),
    onTimeChange: vi.fn(),
    onSlotTimeChange: vi.fn(),
    onEndTimeChange: vi.fn(),
    onLocationChange: vi.fn(),
    onReminderChange: vi.fn(),
    onDetailsChange: vi.fn(),
    onNotesChange: vi.fn(),
    onSourceUrlChange: vi.fn(),
    fieldErrors: {},
    ...overrides,
  };
  return wrap(<TypedFields {...props} />);
}

/** `More options` starts shut, so opening it is how the tail of a table is read. */
const openMore = () =>
  fireEvent.click(screen.getByRole('button', { name: /^More options/ }));

/**
 * Every field draws its label as text, so reading them off the tree in document order is
 * reading the form's field order. `queryAllByText` is exact-match, which is what keeps
 * `Time` from matching `End time`.
 */
function renderedLabels(labels: readonly string[]): string[] {
  return labels.filter((label) => screen.queryAllByText(label).length > 0);
}

const ALL_TYPES = ['task', 'meal', 'watch', 'event', 'custom'] as const;

describe('every form renders its table, in order', () => {
  it.each(ALL_TYPES)('%s', (type) => {
    mount(type, {
      schedule: TIMED,
      details: { ...EMPTY_DETAILS, mediaKind: 'show' },
      // With one set, Reminder states itself under its table label rather than as `+ Reminder`.
      reminderOffset: -15,
    });
    openMore();

    const { primary, more } = fieldRegions(type, {
      hasDate: true,
      hasTime: true,
      mediaKind: 'show',
    });
    const want = [...primary, ...more]
      // The capture row has no visible label of its own; its position is pinned by the table.
      .filter((spec) => spec.key !== 'sourceImageLink')
      .map((spec) => spec.label);

    expect(renderedLabels(want)).toEqual(want);
  });

  /** The negative half: a field from another type's table must not appear on this one. */
  it('gives a Task no People, Slot or Location row', () => {
    mount('task', { schedule: TIMED });
    openMore();
    expect(screen.queryByTestId('compose-people')).toBeNull();
    expect(screen.queryByTestId('compose-slot')).toBeNull();
    expect(screen.queryByTestId('compose-location')).toBeNull();
  });

  /**
   * Reversed 2026-08-16 on the founder's report that Meal, Watch and Event were "missing
   * Repeat, Reminder". `notifications.md` §2.1 and `activities.md` §4.2–§4.4 are amended to
   * match in the same pull request; the assertion is kept, pointing the other way, so the
   * decision is pinned rather than merely deleted.
   */
  it('gives a Meal both a Reminder and a Repeat row', () => {
    mount('meal', { schedule: TIMED });
    expect(screen.getByTestId('compose-reminder')).toBeDefined();
    expect(screen.getByTestId('compose-repeat')).toBeDefined();
  });
});

describe('progressive disclosure', () => {
  /** P2-43's headline: no time control before a date, and one after. */
  it('renders no time control until a date exists', () => {
    const { unmount } = mount('task');
    openMore();
    expect(screen.queryByTestId('compose-time')).toBeNull();
    unmount();

    mount('task', { schedule: DATED });
    expect(screen.getByTestId('compose-time')).toBeDefined();
  });

  it.each(['reminder', 'repeat'] as const)(
    'renders no %s control until a date exists',
    (key) => {
      const { unmount } = mount('task');
      expect(screen.queryByTestId(`compose-${key}`)).toBeNull();
      unmount();

      mount('task', { schedule: DATED });
      expect(screen.getByTestId(`compose-${key}`)).toBeDefined();
    },
  );

  /** "Shown only once a start time exists" (§3.4) — absent, not disabled. */
  it('shows End time on an Event only once a start time is set', () => {
    const { unmount } = mount('event', { schedule: DATED });
    expect(screen.queryByTestId('compose-end-time')).toBeNull();
    unmount();

    mount('event', { schedule: TIMED });
    expect(screen.getByTestId('compose-end-time')).toBeDefined();
  });

  /** §4.3: Season, Episode and Episode title are shown only when Kind is Show. */
  it('hides the Show fields on a Movie and shows them on a Show', () => {
    const { unmount } = mount('watch');
    expect(screen.queryByTestId('compose-season')).toBeNull();
    unmount();

    mount('watch', { details: { ...EMPTY_DETAILS, mediaKind: 'show' } });
    expect(screen.getByTestId('compose-season')).toBeDefined();
  });

  /**
   * Kind defaults to Show once a season is typed, so the fields that produced the default
   * stay on screen rather than vanishing under the user's cursor.
   */
  it('keeps the Show fields visible when a typed season implied the kind', () => {
    mount('watch', { details: { ...EMPTY_DETAILS, season: '2' } });
    expect(screen.getByTestId('compose-season')).toBeDefined();
  });

  it('keeps More options shut until it is opened', () => {
    mount('task', { schedule: DATED });
    const row = screen.getByRole('button', { name: /^More options/ });

    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('compose-notes')).toBeNull();

    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('compose-notes')).toBeDefined();
  });
});

/**
 * "`More options` lists only what is built" — decision 5 of the 2026-08-12 amendment, applied
 * to the summary as well as to the rows. The summary is generated from the rows inside, so
 * these assertions fail the moment a placeholder is put back.
 */
describe('the More options summary', () => {
  const summaryOf = () =>
    screen.getByRole('button', { name: /^More options/ }).textContent ?? '';

  it('names the built fields inside it, in order', () => {
    mount('event', { schedule: TIMED });
    expect(summaryOf()).toContain(
      'Location · Reservation · Tickets & details · Description · Source image / link · Notes',
    );
  });

  /** The when block is not in it — it renders above, whatever the state (founder, 2026-08-16). */
  it('never folds Reminder or Repeat away', () => {
    mount('task', { schedule: DATED });
    expect(summaryOf()).not.toContain('Reminder');
    expect(summaryOf()).not.toContain('Repeat');
    expect(screen.getByTestId('compose-reminder')).toBeDefined();
    expect(screen.getByTestId('compose-repeat')).toBeDefined();
  });

  it.each([
    ['meal', 'People'],
    ['task', 'Related plan'],
  ] as const)('%s never advertises %s', (type, label) => {
    mount(type, { schedule: DATED });
    expect(summaryOf()).not.toContain(label);
  });

  /** P3-43 built the two list bridges, so the summary now names them. */
  it.each([
    ['watch', 'Also add to…'],
    ['meal', 'Add selected ingredients to…'],
  ] as const)('%s advertises %s once the bridge exists', (type, label) => {
    mount(type, { schedule: DATED });
    expect(summaryOf()).toContain(label);
  });

  /** Undated, the only thing left on a Task is what does not need a day. */
  it('shrinks to what is relevant while the draft is undated', () => {
    mount('task');
    expect(summaryOf()).toContain('Notes · Source image / link');
  });
});

describe('nothing unimplemented is drawn', () => {
  it.each([
    ['compose-people', 'meal'],
    ['compose-related-plan', 'task'],
    ['compose-alsoAddTo', 'watch'],
    ['compose-addIngredientsTo', 'meal'],
  ] as const)('%s is absent on a %s', (testID, type) => {
    mount(type, { schedule: TIMED });
    openMore();
    expect(screen.queryByTestId(testID)).toBeNull();
  });

  it.each([
    'Adding people arrives in Phase 6.',
    'Linking to a plan arrives in Phase 3.',
    'Lists are coming soon.',
    'Pick a date first.',
    'Add a date to repeat this.',
  ])('never says %s', (copy) => {
    for (const type of ALL_TYPES) {
      const { unmount } = mount(type, { schedule: TIMED });
      openMore();
      expect(screen.queryAllByText(copy)).toHaveLength(0);
      unmount();
    }
  });

  /**
   * The structural version of the same rule: **no disabled control in any state**. A greyed
   * field is a control that will not answer, and the form's whole organising idea is that it
   * shows what the user's choices have made relevant and nothing else.
   */
  it.each(ALL_TYPES)('%s renders no disabled control, in any state', (type) => {
    for (const schedule of [EMPTY_SCHEDULE, DATED, TIMED]) {
      const { container, unmount } = mount(type, { schedule });
      openMore();
      expect(container.querySelectorAll('[aria-disabled="true"]')).toHaveLength(0);
      expect(container.querySelectorAll('[disabled]')).toHaveLength(0);
      unmount();
    }
  });
});

/**
 * The founder's 2026-08-16 report: the rows had more air above their labels than below, and the
 * gap between the last picker and the first row was bigger again. Both come from a flow gap
 * landing on top of `SettingRow`'s own padding, so both are asserted structurally — the rows
 * share one parent, and nothing sits between the picker above and that parent.
 */
describe('the when block is one even group', () => {
  it('puts Reminder, Repeat and More options in the same container', () => {
    mount('task', { schedule: DATED });

    const reminder = screen.getByTestId('compose-reminder');
    const repeat = screen.getByTestId('compose-repeat');
    const more = screen.getByTestId('compose-more-options');

    const group = reminder.parentElement;
    expect(group).not.toBeNull();
    expect(group?.contains(repeat)).toBe(true);
    expect(group?.contains(more)).toBe(true);
  });

  /**
   * The capture row is two buttons, not a row. Folded into the `RowGroup` it inherited a row's
   * zero top margin and landed against the Notes box above it — the founder's 2026-08-16 report.
   */
  it('spaces the capture row from the field above it', () => {
    mount('task', { schedule: DATED });
    openMore();

    // The picker (P3-41) sits inside the row: picker root → row root → the spaced block.
    const capture = screen.getByTestId('capture').parentElement;
    const block = capture?.parentElement as HTMLElement;
    expect(getComputedStyle(block).marginTop).not.toBe('0px');
  });

  it('leaves no spacer between the time picker and the group', () => {
    mount('task', { schedule: DATED });
    const group = screen.getByTestId('compose-reminder').parentElement?.parentElement;
    expect(getComputedStyle(group as HTMLElement).marginTop).toBe('0px');
  });
});

describe('the Reminder control', () => {
  /**
   * **One row in every state, matching Repeat** — founder decision, 2026-08-16, replacing the
   * `+ Reminder` action P2-43 shipped first. `Off` is a state report, not a selection: the
   * menu underneath still opens with nothing ticked, asserted below.
   */
  it('reads Off before one is set, and states the offset after', () => {
    const { unmount } = mount('task', { schedule: DATED });
    expect(screen.getByTestId('compose-reminder-row').textContent).toContain('Off');
    unmount();

    mount('task', { schedule: TIMED, reminderOffset: -15 });
    expect(screen.getByTestId('compose-reminder-row').textContent).toContain(
      '15 minutes before',
    );
  });

  /** §3.2: the untimed picker offers days, not minutes. */
  it('offers the untimed list until a time is set', () => {
    const { unmount } = mount('task', { schedule: DATED });
    fireEvent.click(screen.getByTestId('compose-reminder-row'));
    expect(screen.getByRole('button', { name: /^On the day/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^15 minutes before/ })).toBeNull();
    unmount();

    mount('task', { schedule: TIMED });
    fireEvent.click(screen.getByTestId('compose-reminder-row'));
    expect(screen.getByRole('button', { name: /^15 minutes before/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^On the day/ })).toBeNull();
  });

  /**
   * `Off` and "no reminder" are the same `undefined`, so a bare equality check ticked `Off`
   * the moment the menu opened — a menu that had answered itself before it was asked.
   */
  it('opens with nothing ticked, and ticks only what the user set', () => {
    const { unmount } = mount('task', { schedule: TIMED });
    fireEvent.click(screen.getByTestId('compose-reminder-row'));
    const menu = screen.getByTestId('compose-reminder-menu');
    expect(menu.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    unmount();

    mount('task', { schedule: TIMED, reminderOffset: -60 });
    fireEvent.click(screen.getByTestId('compose-reminder-row'));
    expect(
      screen.getByTestId('compose-reminder-option--60').getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByTestId('compose-reminder-option-off').getAttribute('aria-pressed'),
    ).not.toBe('true');
  });

  it('writes the chosen offset and closes the menu', () => {
    const onReminderChange = vi.fn();
    mount('task', { schedule: TIMED, onReminderChange });
    fireEvent.click(screen.getByTestId('compose-reminder-row'));
    fireEvent.click(screen.getByRole('button', { name: /^1 hour before/ }));

    expect(onReminderChange).toHaveBeenCalledWith(-60);
  });
});

describe('conditional fields', () => {
  it('keeps both Event disclosure groups collapsed until opened', () => {
    mount('event', { schedule: TIMED });
    openMore();

    const reservation = screen.getByRole('button', { name: 'Reservation' });
    const tickets = screen.getByRole('button', { name: 'Tickets & details' });
    expect(reservation.getAttribute('aria-expanded')).toBe('false');
    expect(tickets.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Reservation name')).toBeNull();
    expect(screen.queryByLabelText('Price')).toBeNull();

    fireEvent.click(reservation);
    expect(reservation.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Reservation name')).toBeDefined();

    fireEvent.click(tickets);
    expect(tickets.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Price')).toBeDefined();
  });
});
