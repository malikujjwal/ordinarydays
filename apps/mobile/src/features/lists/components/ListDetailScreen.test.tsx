import { instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddListItemResult } from '@/hooks/useAddListItem';
import type { ListItemRow } from '@/lib/sqlite/listItemsRepository';
import type { ListBulkActions } from '../hooks/useListBulkActions';
import type { ListDetailView } from '../hooks/useListDetail';
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
vi.mock('../hooks/useListDetail', () => ({ useListDetail: () => view.current }));
vi.mock('@/hooks/useAddListItem', () => ({ useAddListItem: () => add.current }));
vi.mock('../hooks/useListBulkActions', () => ({
  useListBulkActions: () => bulk.current,
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
    refetch: vi.fn(),
    ...overrides,
  };
  return view.current;
}

function mount() {
  const onBack = vi.fn();
  render(
    <SafeAreaProvider>
      <ThemeProvider scheme="light">
        <ListDetailScreen listId={LIST_ID} onBack={onBack} />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
  return { onBack };
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
