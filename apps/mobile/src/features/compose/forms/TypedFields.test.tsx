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
import { fieldsByType } from '@/features/compose/model/fields';
import { TypedFields, type TypedFieldsProps } from './TypedFields';

vi.mock('expo-image-picker', () => ({
  launchCameraAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
  requestCameraPermissionsAsync: vi.fn(),
  requestMediaLibraryPermissionsAsync: vi.fn(),
}));

/**
 * The five forms, asserted against the five tables (P1-25).
 *
 * The expectation is **derived from `fieldsByType`** on purpose, and that is not circular:
 * `fields.test.ts` pins that module against `activities.md` §4 with literal lists, so a field
 * added in the wrong place fails there, and a field the renderer forgets to draw fails here.
 * Together they say "the table is the spec, and the form is the table".
 */
const TODAY = '2026-08-12';

const wrap = (ui: ReactNode) =>
  render(
    <SafeAreaProvider>
      <ThemeProvider scheme="light">{ui}</ThemeProvider>
    </SafeAreaProvider>,
  );

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
    attachmentUri: undefined,
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
    onAttach: vi.fn(),
    onClearAttachment: vi.fn(),
    fieldErrors: {},
    ...overrides,
  };
  return wrap(<TypedFields {...props} />);
}

/**
 * Which fields the renderer is expected to draw, given the state.
 *
 * `title` is the frame's, not the table's — `ComposeForm` renders it above this component for
 * every type. `sourceImageLink` names the shared capture-row component rather than a visible
 * field label, so its position is pinned by the field table and the renderer's map.
 * `endTime` appears only once a start time exists (§3.4), and the three Watch fields only when
 * Kind is Show (§4.3).
 */
const IN_FRAME = new Set(['title', 'sourceImageLink']);

function expected(type: ActivityType, opts: { time?: boolean; show?: boolean } = {}) {
  return fieldsByType[type]
    .filter((spec) => !IN_FRAME.has(spec.key))
    .filter((spec) => (spec.key === 'endTime' ? opts.time === true : true))
    .filter((spec) =>
      spec.key === 'season' || spec.key === 'episode' || spec.key === 'episodeTitle'
        ? opts.show === true
        : true,
    )
    .map((spec) => spec.label);
}

/**
 * Every field draws its label as text, so reading them off the tree in document order is
 * reading the form's field order. `getAllByText` is exact-match, which is what keeps
 * `Time` from matching `End time`.
 */
function renderedLabels(labels: readonly string[]): string[] {
  return labels.filter((label) => screen.queryAllByText(label).length > 0);
}

describe('every form renders its table, in order', () => {
  it.each(['task', 'meal', 'watch', 'event', 'custom'] as const)('%s', (type) => {
    mount(type);
    const want = expected(type);
    expect(renderedLabels(want)).toEqual(want);
  });

  /** The negative half: a field from another type's table must not appear on this one. */
  it('gives a Task no People, Slot or Location row', () => {
    mount('task');
    expect(screen.queryByTestId('compose-people')).toBeNull();
    expect(screen.queryByTestId('compose-slot')).toBeNull();
    expect(screen.queryByTestId('compose-location')).toBeNull();
  });

  it('gives a Meal no Reminder or Repeat row', () => {
    mount('meal');
    expect(screen.queryByTestId('compose-reminder')).toBeNull();
    expect(screen.queryByTestId('compose-repeat')).toBeNull();
  });
});

describe('conditional fields', () => {
  it('keeps both Event disclosure groups collapsed until opened', () => {
    mount('event');

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

  /** "Shown only once a start time exists" (§3.4) — absent, not disabled. */
  it('shows End time on an Event only once a start time is set', () => {
    const { unmount } = mount('event');
    expect(screen.queryByTestId('compose-end-time')).toBeNull();
    unmount();

    mount('event', {
      schedule: {
        date: '2026-08-15',
        time: '19:00',
        endTime: undefined,
        timeFromSlot: false,
      },
    });
    expect(screen.getByTestId('compose-end-time')).toBeDefined();
  });

  /** §4.3: Season, Episode and Episode title are shown only when Kind is Show. */
  it('hides the Show fields on a Movie and shows them on a Show', () => {
    const { unmount } = mount('watch');
    expect(screen.queryByTestId('compose-season')).toBeNull();
    unmount();

    mount('watch', { details: { ...EMPTY_DETAILS, mediaKind: 'show' } });
    const want = expected('watch', { show: true });
    expect(renderedLabels(want)).toEqual(want);
  });

  /**
   * Kind defaults to Show once a season is typed, so the fields that produced the default
   * stay on screen rather than vanishing under the user's cursor.
   */
  it('keeps the Show fields visible when a typed season implied the kind', () => {
    mount('watch', { details: { ...EMPTY_DETAILS, season: '2' } });
    expect(screen.getByTestId('compose-season')).toBeDefined();
  });
});

describe('fields whose behaviour is a later phase', () => {
  /**
   * Rendered **disabled with copy naming the phase**, never hidden. P1-25 is explicit: hiding
   * them means the layout changes when that phase lands, and a user who cannot see that a Plan
   * can have people has been told the product is smaller than it is.
   */
  it.each([
    ['compose-people', 'meal', 'Adding people arrives in Phase 6.'],
    ['compose-related-plan', 'task', 'Linking to a plan arrives in Phase 3.'],
    ['compose-alsoAddTo', 'watch', 'Lists are coming soon.'],
    ['compose-addIngredientsTo', 'meal', 'Lists are coming soon.'],
  ] as const)('%s renders with its copy', (testID, type, copy) => {
    mount(type);
    expect(screen.getByTestId(testID)).toBeDefined();
    expect(screen.getAllByText(copy).length).toBeGreaterThan(0);
  });
});

describe('the interlocks in §3.4', () => {
  it('disables Repeat until a date is set and enables it when dated', () => {
    const { unmount } = mount('task');
    expect(screen.getByText('Add a date to repeat this.')).toBeDefined();
    expect(screen.getByTestId('compose-repeat').getAttribute('aria-disabled')).toBe(
      'true',
    );
    unmount();

    mount('task', {
      schedule: {
        date: '2026-08-15',
        time: undefined,
        endTime: undefined,
        timeFromSlot: false,
      },
    });
    expect(screen.getByTestId('compose-repeat').getAttribute('aria-disabled')).toBeNull();
  });

  it('disables Time until a date is set, and says why', () => {
    const { unmount } = mount('task');
    expect(screen.getAllByText('Pick a date first.').length).toBeGreaterThan(0);
    unmount();

    mount('task', {
      schedule: {
        date: '2026-08-15',
        time: undefined,
        endTime: undefined,
        timeFromSlot: false,
      },
    });
    expect(screen.queryByText('Pick a date first.')).toBeNull();
  });

  /** A reminder is an offset from a date; without one there is nothing to offset from. */
  it('disables Reminder until a date is set', () => {
    mount('task');
    const off = screen.getByRole('button', { name: 'Off' });
    expect(off.getAttribute('aria-disabled')).toBe('true');
  });

  /** §3.2: the untimed picker offers days, not minutes. */
  it('offers the untimed reminder list until a time is set', () => {
    const { unmount } = mount('task', {
      schedule: {
        date: '2026-08-15',
        time: undefined,
        endTime: undefined,
        timeFromSlot: false,
      },
    });
    expect(screen.getByRole('button', { name: 'On the day' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '15 minutes before' })).toBeNull();
    unmount();

    mount('task', {
      schedule: {
        date: '2026-08-15',
        time: '09:00',
        endTime: undefined,
        timeFromSlot: false,
      },
    });
    expect(screen.getByRole('button', { name: '15 minutes before' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'On the day' })).toBeNull();
  });
});
