import { instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddListItemResult } from '@/hooks/useAddListItem';
import type { ListItemRow } from '@/lib/sqlite/listItemsRepository';
import type { ListBulkActions } from '../hooks/useListBulkActions';
import type { ListDetailView } from '../hooks/useListDetail';
import type { ListItemActions } from '../hooks/useListItemActions';
import { ListDetailScreen } from './ListDetailScreen';

/**
 * List detail (§P3-27, `plans-and-lists.md` §5.6, §5.9).
 *
 * The three hooks are stubbed so the screen's own rules are what is under test: the stored
 * empty-state copy, the page-versus-list decisions, and the inline add row's rapid entry.
 * `listItemsRepository.test.ts` and `syncEngine.test.ts` cover the data paths behind them.
 */

const view = vi.hoisted(() => ({ current: {} as ListDetailView }));
const add = vi.hoisted(() => ({ current: {} as AddListItemResult }));
const bulk = vi.hoisted(() => ({ current: {} as ListBulkActions }));
const actions = vi.hoisted(() => ({ current: {} as ListItemActions }));
vi.mock('../hooks/useListDetail', () => ({ useListDetail: () => view.current }));
vi.mock('@/hooks/useAddListItem', () => ({ useAddListItem: () => add.current }));
vi.mock('../hooks/useListBulkActions', () => ({
  useListBulkActions: () => bulk.current,
}));
vi.mock('../hooks/useListItemActions', () => ({
  useListItemActions: () => actions.current,
}));
/*
 * The reorder hook mints one identity per drag and the item sheet mints `ing_` row ids;
 * neither native module exists here.
 */
vi.mock('expo-crypto', () => ({
  randomUUID: () => 'idem-list-detail-test',
  getRandomBytes: () => new Uint8Array(10),
}));

const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';

const list = (overrides: Partial<List> = {}): List => ({
  listId: LIST_ID,
  ownerId: 'usr_local_dev',
  behaviour: 'collection',
  templateKey: 'groceries',
  title: 'Groceries',
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  capabilities: { checkable: true, supportsLocation: false },
  slot: 'groceries',
  itemCount: 0,
  uncheckedCount: 0,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-08-27T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-27T09:00:00.000Z'),
  ...overrides,
});

const item = (id: string, title: string, checked = false): ListItemRow => ({
  itemId: `itm_01J00000000000000000000${id}`,
  listId: LIST_ID,
  rank: id,
  title,
  checked,
});

function setView(overrides: Partial<ListDetailView> = {}) {
  view.current = {
    status: 'success',
    list: list(),
    items: [],
    itemCount: 0,
    complete: true,
    isLoadingMore: false,
    isOffline: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
    refetch: vi.fn(),
    applyRank: vi.fn(),
    ...overrides,
  };
  return view.current;
}

function mount() {
  const onBack = vi.fn();
  const onOpenActivity = vi.fn();
  const tree = () => (
    <SafeAreaProvider>
      <ThemeProvider scheme="light">
        <ListDetailScreen
          listId={LIST_ID}
          onBack={onBack}
          onOpenActivity={onOpenActivity}
        />
      </ThemeProvider>
    </SafeAreaProvider>
  );
  const rendered = render(tree());
  /** Re-renders against whatever `setView` now returns — how a changed projection arrives. */
  return { onBack, onOpenActivity, rerender: () => rendered.rerender(tree()) };
}

beforeEach(() => {
  setView();
  add.current = {
    add: vi.fn(async () => 'itm_01J000000000000000000000ZZ'),
    isAdding: false,
    errorMessage: undefined,
    dismissError: vi.fn(),
  };
  bulk.current = {
    clearChecked: vi.fn(),
    uncheckAll: vi.fn(),
    archive: vi.fn(),
  };
  actions.current = {
    save: vi.fn(async () => true),
    remove: vi.fn(),
    sourceResolves: vi.fn(async () => true),
    isSaving: false,
  };
});

describe('the empty state is the list', () => {
  /**
   * §5.9 verbatim, from the row's **stored** copy. A template edited after creation cannot
   * change what a list somebody already has says about itself (ADR-032).
   */
  it('renders Nothing here and the stored guidance', () => {
    setView({ list: list({ emptyStateCopy: 'Add something to buy.' }) });
    mount();

    // `EmptyState` renders its heading as text rather than a heading role (§5.2's plain fact).
    expect(screen.getByText('Nothing here')).toBeDefined();
    expect(screen.getByText('Add something to buy.')).toBeDefined();
  });

  it('renders whatever the row stores, not what the catalogue says today', () => {
    // The catalogue's `groceries` copy is `Add something to buy.`; this row was created when
    // it said something else, and the row is what renders.
    setView({ list: list({ emptyStateCopy: 'Add a thing you need.' }) });
    mount();

    expect(screen.getByText('Add a thing you need.')).toBeDefined();
    expect(screen.queryByText('Add something to buy.')).toBeNull();
  });

  /** META's zero **and** no visible row. Neither alone is enough (criterion 36). */
  it('is not shown while the server still reports items', () => {
    setView({ list: list({ itemCount: 12 }), itemCount: 12, items: [], complete: false });
    mount();

    expect(screen.queryByTestId('list-detail-empty')).toBeNull();
  });

  it('is not shown over an item created before any count caught up', () => {
    setView({ itemCount: 0, items: [item('AA', 'Milk')] });
    mount();

    expect(screen.queryByTestId('list-detail-empty')).toBeNull();
    expect(screen.getByText('Milk')).toBeDefined();
  });

  it('is not shown before the first page has arrived', () => {
    setView({ status: 'pending', list: undefined });
    mount();

    expect(screen.queryByTestId('list-detail-empty')).toBeNull();
    expect(screen.getByTestId('list-detail-loading')).toBeDefined();
  });
});

describe('the inline add row', () => {
  it('names the list on its action', () => {
    setView({ items: [item('AA', 'Milk')], itemCount: 1 });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add an item' }));

    expect(screen.getByRole('button', { name: 'Add to Groceries' })).toBeDefined();
  });

  /** §5.6: Return commits, and the field stays ready for the next item. */
  it('commits on Return and clears for the next item', async () => {
    setView({ items: [item('AA', 'Milk')], itemCount: 1 });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add an item' }));
    const field = screen.getByTestId('list-add-item-title');
    fireEvent.change(field, { target: { value: 'Eggs' } });

    fireEvent.keyDown(field, { key: 'Enter' });
    await vi.waitFor(() => expect(add.current.add).toHaveBeenCalled());

    expect(add.current.add).toHaveBeenCalledWith(LIST_ID, { title: 'Eggs' });
    await vi.waitFor(() =>
      expect(screen.getByTestId('list-add-item-title').getAttribute('value')).toBe(''),
    );
    // Still open: the next item is typed straight in.
    expect(screen.getByRole('button', { name: 'Add to Groceries' })).toBeDefined();
    // And the projection is re-read, so the row the user just wrote is on screen.
    expect(view.current.refresh).toHaveBeenCalled();
  });

  it('keeps the typed words when the write does not land', async () => {
    add.current = { ...add.current, add: vi.fn(async () => undefined) };
    setView({ items: [item('AA', 'Milk')], itemCount: 1 });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add an item' }));
    const field = screen.getByTestId('list-add-item-title');
    fireEvent.change(field, { target: { value: 'Eggs' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await vi.waitFor(() => expect(add.current.add).toHaveBeenCalled());

    expect(screen.getByTestId('list-add-item-title').getAttribute('value')).toBe('Eggs');
  });

  it('opens focused on an empty list, where it is the only thing to do', () => {
    mount();

    expect(screen.getByTestId('list-add-item-title')).toBeDefined();
  });
});

describe('the bulk actions', () => {
  const checkedList = { items: [item('AA', 'Milk', true), item('BB', 'Eggs')] };

  it('states the checked count and applies with no dialog', () => {
    setView({ ...checkedList, itemCount: 2, complete: true });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear checked (1)' }));

    expect(bulk.current.clearChecked).toHaveBeenCalledWith(LIST_ID);
    // §P3-10: the count in the button is what pays for there being no confirmation.
    expect(screen.queryByRole('heading', { name: /Delete|Clear/ })).toBeNull();
  });

  /**
   * A menu reading `Clear checked (1)` on a list with forty checked rows further down would
   * be lying about the write it is about to make (criterion 36).
   */
  it('is withheld until every page has landed', () => {
    setView({ ...checkedList, itemCount: 40, complete: false });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(screen.queryByRole('button', { name: /Clear checked/ })).toBeNull();
  });

  it('archives and leaves the screen with it', () => {
    const { onBack } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive list' }));

    expect(bulk.current.archive).toHaveBeenCalled();
    expect(onBack).toHaveBeenCalled();
  });

  /** The two-part gate, read from the row rather than from its template (ADR-031). */
  it('offers neither on a watch list that kept a stale checkable flag', () => {
    setView({
      ...checkedList,
      itemCount: 2,
      list: list({
        behaviour: 'watch',
        capabilities: { checkable: true, supportsLocation: false },
      }),
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(screen.queryByRole('button', { name: /Clear checked/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Uncheck all' })).toBeNull();
  });
});

/**
 * Reorder, at the screen (§P3-30, acceptance criterion 29).
 *
 * The order is the assertion. `reorder.test.ts` covers what a drop means and
 * `ReorderableList.test.tsx` covers the handle; what only this level can show is that the rows
 * reach the screen in `(rank, itemId)` order however the projection handed them over.
 */
describe('reorder', () => {
  const ranked = (id: string, title: string, rank: string): ListItemRow => ({
    ...item(id, title),
    rank,
  });

  /** Two restored or legacy rows sharing a rank; only the tie-break separates them. */
  const DUPLICATE_A = ranked('AA', 'Milk', 'm');
  const DUPLICATE_B = ranked('BB', 'Eggs', 'm');
  const LATER = ranked('CC', 'Bread', 'z');

  const titles = () =>
    ['Milk', 'Eggs', 'Bread']
      .map((title) => ({ title, at: screen.getByText(title) }))
      .sort((left, right) =>
        left.at.compareDocumentPosition(right.at) & Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1,
      )
      .map((entry) => entry.title);

  it.each([
    ['as stored', [DUPLICATE_A, DUPLICATE_B, LATER]],
    ['shuffled', [LATER, DUPLICATE_B, DUPLICATE_A]],
  ])('renders duplicate ranks in compareListItems order, %s', (_name, items) => {
    setView({ items, itemCount: items.length });
    mount();

    // `itm_…AA` before `itm_…BB` on an equal rank, and both before the later rank.
    expect(titles()).toEqual(['Milk', 'Eggs', 'Bread']);
  });

  it('offers a drag handle on every row', () => {
    setView({ items: [DUPLICATE_A, LATER], itemCount: 2 });
    mount();

    expect(screen.getByTestId(`list-reorder-handle-${DUPLICATE_A.itemId}`)).toBeDefined();
    expect(screen.getByTestId(`list-reorder-handle-${LATER.itemId}`)).toBeDefined();
  });
});

/**
 * §5.2's one grouped behaviour, chosen at the screen (§P3-31).
 *
 * `WatchSections.test.tsx` covers what the sections render. What only this level shows is
 * **which** component a list gets, and that the choice is the row's stored `behaviour` and
 * nothing else.
 */
describe('the watch list renders grouped', () => {
  const watching = (id: string, title: string, rank: string): ListItemRow => ({
    ...item(id, title),
    rank,
    details: { behaviour: 'watch', watchStatus: 'watching', mediaKind: 'show' },
  });
  const wanted = (id: string, title: string, rank: string): ListItemRow => ({
    ...item(id, title),
    rank,
    details: { behaviour: 'watch', watchStatus: 'want' },
  });

  const watchList = () =>
    list({
      behaviour: 'watch',
      templateKey: 'watchlist',
      // Retained flags a behaviour change left behind. Neither reaches a watch row.
      capabilities: { checkable: true, supportsLocation: true },
    });

  it('renders sections for a watch list', () => {
    setView({
      list: watchList(),
      items: [watching('AA', 'Severance', 'a'), wanted('BB', 'Andor', 'b')],
      itemCount: 2,
    });
    mount();

    // The screen names the whole group `list-detail-items`; each section derives from it.
    expect(screen.getByTestId('list-detail-items-watching')).toBeDefined();
    expect(screen.getByTestId('list-detail-items-want')).toBeDefined();
    // `Watching` is also the row's own status chip, so the heading is asserted by its id.
    expect(screen.getByTestId('watch-heading-watching')).toBeDefined();
  });

  /**
   * §P3-31's edge case: "a list changed away from `watch` renders flat immediately; the
   * sections component is chosen off the row's stored `behaviour`, nothing else."
   */
  it('renders flat the moment the stored behaviour is no longer watch', () => {
    const items = [watching('AA', 'Severance', 'a'), wanted('BB', 'Andor', 'b')];
    setView({ list: watchList(), items, itemCount: 2 });
    const { rerender } = mount();
    expect(screen.getByTestId('list-detail-items-watching')).toBeDefined();

    // The same items, retaining their typed details, on a list that is now a collection.
    setView({ list: list({ behaviour: 'collection' }), items, itemCount: 2 });
    rerender();

    expect(screen.queryByTestId('list-detail-items-watching')).toBeNull();
    expect(screen.queryByTestId('watch-heading-watching')).toBeNull();
    expect(screen.getByText('Severance')).toBeDefined();
  });

  /**
   * The migration gate. A `503` keeps the last committed projection, so the sections the user
   * is looking at stay exactly as they were — and the refresh line appears above them (§5.3).
   * Nothing here has to detect the migration; nothing reads anything that changes during one.
   */
  /**
   * §3.2 gives a `watch` item the same body tap as every other row, and the full swipe pair.
   * Both were open seams while P3-29 was unlanded; neither is now.
   */
  it('opens the item sheet from a watch row body', () => {
    const severance = watching('AA', 'Severance', 'a');
    setView({ list: watchList(), items: [severance], itemCount: 1 });
    mount();

    expect(screen.queryByTestId('item-sheet')).toBeNull();
    fireEvent.click(screen.getByTestId(`list-item-${severance.itemId}-body`));

    expect(screen.getByTestId('item-sheet')).toBeDefined();
  });

  it('offers both swipe actions and routes Delete to the item delete', () => {
    const severance = watching('AA', 'Severance', 'a');
    setView({ list: watchList(), items: [severance], itemCount: 1 });
    mount();
    fireEvent.pointerEnter(screen.getByTestId(`swipeable-item-${severance.itemId}`));

    expect(screen.getByRole('button', { name: 'Mark watched' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(actions.current.remove).toHaveBeenCalledWith(severance);
  });

  it('keeps the committed sections while a gate is up', () => {
    setView({
      list: watchList(),
      items: [watching('AA', 'Severance', 'a'), wanted('BB', 'Andor', 'b')],
      itemCount: 2,
      status: 'success',
      message: 'Something went wrong.',
    });
    mount();

    expect(screen.getByTestId('list-detail-refresh-failed')).toBeDefined();
    expect(screen.getByTestId('watch-heading-watching')).toBeDefined();
    expect(screen.getByTestId('watch-heading-want')).toBeDefined();
    expect(screen.getByText('Severance')).toBeDefined();
  });
});

/**
 * U2 (§5.11.5, §P3-29). P3-28 shipped the control; this task owns the write behind it.
 */
describe('the checkbox', () => {
  const row = () => item('AA', 'Milk');
  const checkbox = () => screen.getByTestId(`list-item-${row().itemId}-checkbox`);
  /* `aria-checked`, which is what a screen reader actually reads off the control. */
  const ticked = () => checkbox().getAttribute('aria-checked');

  it('sends the absolute next value, never a toggle', async () => {
    setView({ items: [row()], itemCount: 1 });
    mount();

    fireEvent.click(checkbox());

    await waitFor(() => expect(actions.current.save).toHaveBeenCalledTimes(1));
    expect(actions.current.save).toHaveBeenCalledWith(row(), { checked: true });
  });

  /** The tick is drawn at the tap and held until the projection carries it (§5.11.5). */
  it('draws the tick before the projection catches up, then hands over', async () => {
    setView({ items: [row()], itemCount: 1 });
    const { rerender } = mount();

    expect(ticked()).toBe('false');
    fireEvent.click(checkbox());
    await waitFor(() => expect(ticked()).toBe('true'));

    setView({ items: [item('AA', 'Milk', true)], itemCount: 1 });
    rerender();
    expect(ticked()).toBe('true');
  });

  it('puts the tick back when the write is refused', async () => {
    setView({ items: [row()], itemCount: 1 });
    actions.current = { ...actions.current, save: vi.fn(async () => false) };
    mount();

    fireEvent.click(checkbox());

    await waitFor(() => expect(ticked()).toBe('false'));
  });
});

/**
 * §5.5's capability rule, from the screen's side (§P3-32).
 *
 * The flag is a **display** setting: turning it off hides the control and every count and bulk
 * action derived from it, and retains each item's `checked` so turning it back on restores
 * exactly what was there. Driven through the projection, because that is how the change reaches
 * this screen — the write itself is `useListSettings.test.tsx`'s.
 */
describe('turning checkboxes off and on again', () => {
  const rows = [item('AA', 'Milk', true), item('BB', 'Bread')];
  const tick = (id: string) => screen.queryByTestId(`list-item-${id}-checkbox`);

  it('hides the checkboxes and restores the previous ticks', () => {
    setView({ items: rows, itemCount: 2 });
    const { rerender } = mount();

    expect(tick(rows[0]?.itemId ?? '')?.getAttribute('aria-checked')).toBe('true');

    setView({
      list: list({ capabilities: { checkable: false, supportsLocation: false } }),
      items: rows,
      itemCount: 2,
    });
    rerender();

    expect(tick(rows[0]?.itemId ?? '')).toBeNull();
    expect(tick(rows[1]?.itemId ?? '')).toBeNull();
    // The rows are still there, and so is the value the checkbox was drawing.
    expect(screen.getByText('Milk')).toBeDefined();

    setView({ items: rows, itemCount: 2 });
    rerender();

    expect(tick(rows[0]?.itemId ?? '')?.getAttribute('aria-checked')).toBe('true');
    expect(tick(rows[1]?.itemId ?? '')?.getAttribute('aria-checked')).toBe('false');
  });

  /** Both bulk rows are gated on the flag, exactly as the endpoints are (criterion 18). */
  it('takes the checkbox-derived bulk actions away with it', () => {
    setView({
      list: list({ capabilities: { checkable: false, supportsLocation: false } }),
      items: rows,
      itemCount: 2,
    });
    mount();
    fireEvent.click(screen.getByTestId('list-detail-menu'));

    expect(screen.queryByTestId('list-clear-checked')).toBeNull();
    expect(screen.queryByTestId('list-uncheck-all')).toBeNull();
    // Settings is offered on every behaviour and every capability state.
    expect(screen.getByTestId('list-settings-open')).toBeDefined();
  });
});

/** §5.6: the settings sheet opens from `⋯`, and renaming is not in it (§P3-32). */
describe('the settings sheet', () => {
  it('opens from the ⋯ menu, which closes behind it', () => {
    setView({ list: list({ title: 'Groceries' }) });
    mount();

    fireEvent.click(screen.getByTestId('list-detail-menu'));
    fireEvent.click(screen.getByTestId('list-settings-open'));

    expect(screen.getByTestId('list-settings')).toBeDefined();
    expect(screen.queryByTestId('list-header-menu')).toBeNull();
    expect(screen.queryByText(/rename/i)).toBeNull();
  });

  it('renames from the header title instead', () => {
    setView({ list: list({ title: 'Groceries' }) });
    mount();

    fireEvent.click(screen.getByTestId('list-title'));

    expect(screen.getByTestId('list-title-field')).toBeDefined();
  });
});

/**
 * U1 (§P3-29). The body opens the sheet and mutates nothing; the sheet's own rules are
 * `ItemSheet.test.tsx`'s.
 */
describe('the item sheet', () => {
  it('opens on a row body tap and closes on the way out', () => {
    setView({ items: [item('AA', 'Milk')], itemCount: 1 });
    mount();
    const itemId = item('AA', 'Milk').itemId;

    expect(screen.queryByTestId('item-sheet')).toBeNull();
    fireEvent.click(screen.getByTestId(`list-item-${itemId}-body`));

    expect(screen.getByTestId('item-sheet')).toBeDefined();
    expect(screen.getByTestId('item-sheet-title')).toBeDefined();
    // Opening is a read: nothing was written, and nothing was refreshed.
    expect(view.current.refresh).not.toHaveBeenCalled();
    expect(view.current.refetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('item-sheet')).toBeNull();
  });

  /** Held by id, so a refreshed projection reaches the open sheet as new committed values. */
  it('follows the row it opened rather than a copy of it', () => {
    setView({ items: [item('AA', 'Milk')], itemCount: 1 });
    const { rerender } = mount();
    fireEvent.click(screen.getByTestId(`list-item-${item('AA', 'Milk').itemId}-body`));

    setView({ items: [item('AA', 'Oat milk')], itemCount: 1 });
    rerender();

    expect(screen.getAllByRole('heading', { name: 'Oat milk' }).length).toBeGreaterThan(
      0,
    );
  });

  /** An item deleted underneath closes the sheet instead of editing a row that is gone. */
  it('closes when the row leaves the projection', () => {
    setView({ items: [item('AA', 'Milk')], itemCount: 1 });
    const { rerender } = mount();
    fireEvent.click(screen.getByTestId(`list-item-${item('AA', 'Milk').itemId}-body`));
    expect(screen.getByTestId('item-sheet')).toBeDefined();

    setView({ items: [], itemCount: 0 });
    rerender();

    expect(screen.queryByTestId('item-sheet')).toBeNull();
  });
});

describe('failure states', () => {
  it('keeps rows on screen and shows a line above them', () => {
    setView({
      status: 'success',
      items: [item('AA', 'Milk')],
      itemCount: 1,
      message: 'Something went wrong.',
    });
    mount();

    expect(screen.getByText('Milk')).toBeDefined();
    expect(screen.getByTestId('list-detail-refresh-failed')).toBeDefined();
  });

  it('becomes the error state only with nothing to keep', () => {
    setView({ status: 'error', items: [], list: undefined, requestId: 'req_9' });
    mount();

    expect(screen.getByTestId('list-detail-error')).toBeDefined();
    expect(screen.getByText('req_9')).toBeDefined();
  });
});
