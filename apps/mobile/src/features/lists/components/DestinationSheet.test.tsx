import type { List } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DestinationSheet } from './DestinationSheet';

vi.mock('expo-crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000000',
}));

const OWNER = 'usr_01J0000000000000000000000B';

function list(
  listId: string,
  title: string,
  slot: List['slot'],
  itemStateMode: List['itemStateMode'],
): List {
  return {
    schemaVersion: 2,
    listId,
    ownerId: OWNER,
    templateKey: 'blank',
    title,
    icon: 'list',
    emptyStateCopy: '',
    itemStateMode,
    featureConfig: {},
    slot,
    itemCount: 0,
    doneCount: 0,
    memberCount: 1,
    rankVersion: 0,
    archived: false,
    updatedAt: '2026-08-24T09:00:00.000Z',
    lastItemActivityAt: '2026-08-24T09:00:00.000Z',
  } as List;
}

const GROCERIES = list('lst_01J8XKQ2M4N5P6R7S8T9V0W1A1', 'Groceries', 'groceries', {
  mode: 'checkbox',
});
const CHECKLIST = list('lst_01J8XKQ2M4N5P6R7S8T9V0W1A2', 'Camping checklist', null, {
  mode: 'checkbox',
});
const UNTITLED = list('lst_01J8XKQ2M4N5P6R7S8T9V0W1A3', 'Untitled list', null, {
  mode: 'none',
});
const INCAPABLE_GROCERIES = list(
  'lst_01J8XKQ2M4N5P6R7S8T9V0W1A4',
  'Groceries without checkboxes',
  'groceries',
  { mode: 'none' },
);

function mount(
  lists: readonly List[] = [GROCERIES, CHECKLIST, UNTITLED, INCAPABLE_GROCERIES],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(['lists'], {
    pages: [{ data: lists, meta: {} }],
    pageParams: [undefined],
  });
  client.setQueryData(['me'], {
    userId: OWNER,
    displayName: 'Dev',
    timezone: 'America/New_York',
    currency: 'USD',
    weekStartsOn: 1,
    defaultLists: {},
  });
  const onChoose = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ThemeProvider scheme="light">{children}</ThemeProvider>
    </QueryClientProvider>
  );
  render(
    <DestinationSheet
      open
      slot="groceries"
      current={undefined}
      onChoose={onChoose}
      onClose={() => {}}
    />,
    { wrapper },
  );
  return { onChoose };
}

describe('ingredient destination capability', () => {
  it('never offers Blank or an incapable groceries-slot list', async () => {
    const { onChoose } = mount();

    await screen.findByTestId(`destination-sheet-list-${GROCERIES.listId}`);
    expect(
      screen.queryByTestId(`destination-sheet-list-${INCAPABLE_GROCERIES.listId}`),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Choose another list' }));

    expect(
      screen.getByTestId(`destination-sheet-list-${CHECKLIST.listId}`),
    ).toBeDefined();
    expect(screen.queryByText('Untitled list')).toBeNull();
    expect(screen.queryByText('Groceries without checkboxes')).toBeNull();
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('hides Choose another list when every capable list already holds the slot', async () => {
    mount([GROCERIES, UNTITLED, INCAPABLE_GROCERIES]);
    await screen.findByTestId(`destination-sheet-list-${GROCERIES.listId}`);
    expect(screen.queryByRole('button', { name: 'Choose another list' })).toBeNull();
  });

  it('limits New list to the three checkbox templates', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'New list' }));

    // The catalogue opens only once the picker has finished leaving (see the handoff tests
    // below), so every assertion about its contents has to wait for it to exist. Asserting
    // `queryBy(...)` before that would pass against an unmounted sheet and prove nothing.
    await screen.findByTestId('list-style-chooser');

    expect(screen.queryByTestId('list-style-blank')).toBeNull();
    expect(screen.getByTestId('list-style-checklist')).toBeDefined();
    expect(screen.getByTestId('list-style-groceries')).toBeDefined();
    expect(screen.getByTestId('list-style-places-to-visit')).toBeDefined();
    expect(screen.getByTestId('list-style-grid').children).toHaveLength(3);
  });
});

/**
 * The `New list` handoff (owner report, 2026-09-16: "tapping New list did nothing, and the
 * whole screen was blocked").
 *
 * `Sheet` keeps its modal mounted through the exit animation — `closed` is the only phase in
 * which it unmounts — so a picker that opens the create sheet on the button press leaves two
 * modals mounted at once, and the one that is leaving covers the one arriving and swallows
 * every tap. The child may only open from `onClosed`. `AddListToPlanSheet` already sequences
 * it this way; this is the same contract for the destination picker.
 *
 * **Time has to be in the test's hands for this to be observable.** The exit steps on
 * `requestAnimationFrame` against `Date.now()`; with real timers a synchronous test body
 * never lets a frame run, and the whole handoff collapses into one flush in which the overlap
 * cannot be seen on either revision. Faking both — the idiom `Sheet.test.tsx` uses for the
 * same reason — restores the mid-exit window the browser actually has.
 */
describe('the New list handoff', () => {
  /** The tween steps on rAF against `Date.now()`, so both are faked (cf. `Sheet.test.tsx`). */
  const useFrameClock = () =>
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'Date',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
    });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never mounts the create sheet over the picker that is still leaving', () => {
    useFrameClock();
    mount();
    act(() => void vi.advanceTimersByTime(300)); // the picker is fully presented

    fireEvent.click(screen.getByRole('button', { name: 'New list' }));

    /*
     * Mid-exit. This is the assertion the previous revision fails: it set `creating` from the
     * button press, so the create sheet was already mounted here, on top of a picker that is
     * still mounted and animating out.
     */
    act(() => void vi.advanceTimersByTime(100));
    expect(screen.getByTestId('destination-sheet')).toBeDefined();
    expect(screen.queryByTestId('new-list-sheet')).toBeNull();

    act(() => void vi.advanceTimersByTime(300)); // past `slow`: the exit has finished
    expect(screen.queryByTestId('destination-sheet')).toBeNull();
    expect(screen.getByTestId('new-list-sheet')).toBeDefined();
  });

  /**
   * Not a regression test — the previous revision passes this too. It pins the new flag's
   * reset: a create that has been handed off must not still be pending, or dismissing the
   * create sheet would bounce straight back into it instead of returning to the picker.
   */
  it('returns to the picker when the create sheet is dismissed, with no create left pending', () => {
    useFrameClock();
    mount();
    act(() => void vi.advanceTimersByTime(300));

    fireEvent.click(screen.getByRole('button', { name: 'New list' }));
    act(() => void vi.advanceTimersByTime(400));
    expect(screen.getByTestId('new-list-sheet')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    act(() => void vi.advanceTimersByTime(400));

    expect(screen.getByTestId('destination-sheet')).toBeDefined();
    expect(screen.queryByTestId('new-list-sheet')).toBeNull();
  });
});
