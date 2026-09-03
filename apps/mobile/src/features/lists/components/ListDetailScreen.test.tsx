import { instant } from '@od/shared/schemas';
import type { List, ListItemView } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListDetailView } from '../hooks/useListDetail';
import { ListDetailScreen } from './ListDetailScreen';

const mocks = vi.hoisted(() => {
  const addFailure: {
    message: string | undefined;
    requestId: string | undefined;
  } = { message: undefined, requestId: undefined };
  return {
    view: {} as ListDetailView,
    save: vi.fn(),
    uncheckAll: vi.fn(),
    clearDone: vi.fn(),
    archive: vi.fn(),
    removeList: vi.fn(),
    back: vi.fn(),
    drop: vi.fn(),
    add: vi.fn(),
    addFailure,
  };
});

vi.mock('expo-crypto', () => ({ randomUUID: () => 'list-detail-test-intent' }));
vi.mock('../hooks/useListDetail', () => ({ useListDetail: () => mocks.view }));
vi.mock('../hooks/useListItemActions', () => ({
  useListItemActions: () => ({
    save: mocks.save,
    remove: vi.fn(),
    sourceResolves: vi.fn(),
    isSaving: false,
  }),
}));
vi.mock('../hooks/useListBulkActions', () => ({
  useListBulkActions: () => ({
    clearDone: mocks.clearDone,
    uncheckAll: mocks.uncheckAll,
    archive: mocks.archive,
    remove: mocks.removeList,
  }),
}));
vi.mock('../hooks/useReorderItems', () => ({
  useReorderItems: ({ items }: { items: readonly ListItemView[] }) => ({
    items,
    drop: mocks.drop,
  }),
}));
vi.mock('@/hooks/useAddListItem', () => ({
  useAddListItem: () => ({
    add: mocks.add,
    isAdding: false,
    errorMessage: mocks.addFailure.message,
    errorRequestId: mocks.addFailure.requestId,
    dismissError: vi.fn(),
  }),
}));
vi.mock('../hooks/useListSettings', () => ({
  useListSettings: ({ list }: { list: List | undefined }) => ({
    view: list,
    rename: vi.fn(),
    setStateMode: vi.fn(),
    setFeatureEnabled: vi.fn(),
    setProgressKind: vi.fn(),
    setSubItemLabels: vi.fn(),
    setSlot: vi.fn(),
    busy: false,
  }),
}));

const LIST: List = {
  schemaVersion: 2,
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  templateKey: 'checklist',
  title: 'Launch',
  icon: 'check',
  emptyStateCopy: 'Add a task.',
  itemStateMode: { mode: 'checkbox' },
  featureConfig: {},
  slot: null,
  itemCount: 3,
  doneCount: 1,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-08-28T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-28T09:00:00.000Z'),
};

const item = (id: string, title: string, state: ListItemView['state']): ListItemView => ({
  listId: LIST.listId,
  itemId: `itm_01J8XKQ2M4N5P6R7S8T9V0W${id}`,
  rank: `a${id}`,
  title,
  state,
});

function setView(overrides: Partial<ListDetailView> = {}) {
  mocks.view = {
    status: 'success',
    list: LIST,
    items: [
      item('1X3', 'Write tests', 'open'),
      item('1X4', 'Ship', 'done'),
      item('1X5', 'Review', 'active'),
    ],
    itemCount: 3,
    complete: true,
    isLoadingMore: false,
    isOffline: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
    refetch: vi.fn(),
    applyRank: vi.fn(),
    ...overrides,
  };
}

function mount() {
  render(
    <ThemeProvider scheme="light">
      <ListDetailScreen listId={LIST.listId} onBack={mocks.back} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  for (const mock of [
    mocks.save,
    mocks.clearDone,
    mocks.uncheckAll,
    mocks.archive,
    mocks.removeList,
    mocks.back,
    mocks.drop,
    mocks.add,
  ])
    mock.mockReset();
  setView();
  mocks.addFailure.message = undefined;
  mocks.addFailure.requestId = undefined;
  mocks.add.mockResolvedValue('itm_01J8XKQ2M4N5P6R7S8T9V0W1X6');
});

afterEach(() => vi.useRealTimers());

describe('the configuration-driven List detail', () => {
  it('renders one flat item shell and maps checkbox writes to explicit intrinsic state', () => {
    mount();

    fireEvent.click(
      screen.getByTestId('list-item-itm_01J8XKQ2M4N5P6R7S8T9V0W1X3-checkbox'),
    );
    fireEvent.click(
      screen.getByTestId('list-item-itm_01J8XKQ2M4N5P6R7S8T9V0W1X4-checkbox'),
    );

    expect(mocks.save).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ state: 'open' }),
      { state: 'done' },
    );
    expect(mocks.save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ state: 'done' }),
      { state: 'open' },
    );
  });

  it('renders every configured stage in the counted switcher and shows the active stage', () => {
    setView({
      list: {
        ...LIST,
        itemStateMode: {
          mode: 'stages',
          labels: { open: 'Queued', active: 'Building', done: 'Shipped' },
          groupByState: true,
        },
      },
      items: [item('1X3', 'Write tests', 'open'), item('1X5', 'Review', 'active')],
      itemCount: 2,
    });
    mount();

    expect(screen.getByRole('tab', { name: 'All, 2' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Queued, 1' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Building, 1' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Shipped, 0' })).toBeTruthy();
    expect(screen.queryByText('Write tests')).toBeNull();
    expect(screen.getByText('Review')).toBeTruthy();
  });

  it('offers both done-set actions for a fully loaded checkbox list', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('button', { name: 'Uncheck all (1)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear checked (1)' }));

    expect(mocks.clearDone).toHaveBeenCalledWith(
      LIST.listId,
      expect.objectContaining({
        onStarted: expect.any(Function),
        onRejected: expect.any(Function),
      }),
    );
  });

  it('removes the checked rows immediately while Clear checked is in flight', () => {
    mocks.clearDone.mockImplementation(
      (_listId, lifecycle: { onStarted: () => void }) => {
        lifecycle.onStarted();
        return new Promise(() => undefined);
      },
    );
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear checked (1)' }));

    expect(screen.queryByRole('button', { name: 'Ship' })).toBeNull();
    expect(screen.getByTestId('list-header-caption').textContent).toBe(
      'CHECKLIST · 2 ITEMS',
    );
  });

  it('unchecks the checked rows immediately while Uncheck all is in flight', () => {
    mocks.uncheckAll.mockImplementation(
      (_listId, lifecycle: { onStarted: () => void }) => {
        lifecycle.onStarted();
        return new Promise(() => undefined);
      },
    );
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Uncheck all (1)' }));

    expect(mocks.uncheckAll).toHaveBeenCalledWith(
      LIST.listId,
      expect.objectContaining({
        onStarted: expect.any(Function),
        onRejected: expect.any(Function),
      }),
    );
    expect(
      screen
        .getByRole('checkbox', { name: 'Ship, not checked' })
        .getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('restores the checked rows when Clear checked is rejected', async () => {
    mocks.clearDone.mockImplementation(
      (_listId, lifecycle: { onStarted: () => void; onRejected: () => void }) => {
        lifecycle.onStarted();
        return Promise.resolve().then(() => {
          lifecycle.onRejected();
          return false;
        });
      },
    );
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear checked (1)' }));

    expect(screen.queryByRole('button', { name: 'Ship' })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Ship' })).toBeTruthy(),
    );
  });

  it('reapplies the Clear checked preview when its Retry starts', async () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear checked (1)' }));
    const lifecycle = mocks.clearDone.mock.calls[0]?.[1] as
      | { onStarted: () => void; onRejected: () => void }
      | undefined;
    if (lifecycle === undefined) throw new Error('Expected bulk lifecycle callbacks');

    lifecycle.onRejected();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Ship' })).toBeTruthy(),
    );
    lifecycle.onStarted();

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Ship' })).toBeNull(),
    );
  });

  it('shows only the compact empty action and stored guidance when there are no items', () => {
    setView({ items: [], itemCount: 0 });
    mount();

    expect(screen.getByText('Start with one item')).toBeTruthy();
    expect(screen.getByText('Add a task.')).toBeTruthy();
    expect(screen.getByTestId('list-detail-empty-icon')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Add item' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Add an item' })).toBeNull();
  });

  it('keeps a failed zero-item load exclusive from the successful empty state', () => {
    setView({
      status: 'error',
      items: [],
      itemCount: 0,
      message: "Couldn't load this.",
      requestId: 'req_list_load_9',
    });
    mount();

    expect(screen.getByText("Couldn't load this.")).toBeTruthy();
    expect(screen.getByText('req_list_load_9')).toBeTruthy();
    expect(screen.queryByText('Start with one item')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add item' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add an item' })).toBeNull();
  });

  it('puts the list kind and count above the title and the contextual Add row last', () => {
    mount();

    const scrollContent = screen.getByTestId('list-detail-body').firstElementChild;
    expect(scrollContent).toBeInstanceOf(HTMLElement);
    expect(scrollContent?.getAttribute('style')).toContain('padding-top: 8px');
    expect(screen.getByText('CHECKLIST · 3 ITEMS')).toBeTruthy();
    expect(screen.queryByText('Drag handles to reorder')).toBeNull();
    expect(screen.queryByTestId('list-overview')).toBeNull();
    expect(
      getComputedStyle(screen.getByRole('button', { name: 'Reorder Write tests' }))
        .backgroundColor,
    ).toBe('rgba(0, 0, 0, 0)');
    expect(screen.getByRole('button', { name: 'Add an item' })).toBeTruthy();
    expect(screen.getByText('Add to Launch')).toBeTruthy();
  });

  it('opens item details on the first activation and coalesces a double tap', () => {
    mount();

    const body = screen.getByRole('button', { name: 'Write tests' });
    fireEvent.click(body);
    fireEvent.click(body);

    expect(screen.getAllByRole('dialog', { name: 'Item details' })).toHaveLength(1);
  });

  it('expands one contextual composer inline inside the List scroll measure', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add an item' }));

    expect(screen.getByTestId('list-detail')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Add item to Launch' })).toBeNull();
    expect(
      screen
        .getByTestId('list-detail-body')
        .contains(screen.getByTestId('list-contextual-add')),
    ).toBe(true);
    // One rapid-entry row: the accessible name survives `hideLabel`, the note stays with
    // the item sheet, and Return-adds-another is stated rather than discovered.
    expect(screen.getByLabelText('Add item to Launch')).toBeTruthy();
    expect(screen.getByText('Return adds another')).toBeTruthy();
    expect(screen.queryByLabelText('Note')).toBeNull();
    expect(screen.queryByText('New list')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done adding' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('opens the same contextual composer from the sole empty-state action', () => {
    setView({ items: [], itemCount: 0 });
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(screen.getByText('Start with one item')).toBeTruthy();
    expect(screen.getByText('Add a task.')).toBeTruthy();
    expect(screen.getByTestId('list-detail-empty-icon')).toBeTruthy();
    expect(
      screen
        .getByTestId('list-detail-body')
        .contains(screen.getByTestId('list-contextual-add')),
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Add item' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add an item' })).toBeNull();
  });

  it('persists a typed title as exactly one item, then refreshes once', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add an item' }));
    fireEvent.change(screen.getByLabelText('Add item to Launch'), {
      target: { value: 'Book venue' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(mocks.add).toHaveBeenCalledOnce();
      expect(mocks.view.refresh).toHaveBeenCalledOnce();
    });
    expect(mocks.add).toHaveBeenCalledWith(LIST.listId, { title: 'Book venue' });
    expect(screen.getByLabelText('Add item to Launch')).toHaveProperty('value', '');
  });

  it('submits with Return and keeps Title focused for rapid entry', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add an item' }));
    const title = screen.getByLabelText('Add item to Launch');
    fireEvent.change(title, { target: { value: 'Pack chargers' } });
    title.focus();
    fireEvent.keyDown(title, { key: 'Enter' });

    await waitFor(() => expect(mocks.add).toHaveBeenCalledOnce());
    expect(mocks.add).toHaveBeenCalledWith(LIST.listId, { title: 'Pack chargers' });
    expect(document.activeElement).toBe(title);
    expect(title).toHaveProperty('value', '');
  });

  it('retains the typed title and shows the contracted error when the write fails', async () => {
    mocks.addFailure.message = "Couldn't save this.";
    mocks.addFailure.requestId = 'req_context_add_9';
    mocks.add.mockResolvedValue(undefined);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add an item' }));
    fireEvent.change(screen.getByLabelText('Add item to Launch'), {
      target: { value: 'Book venue' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(mocks.add).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('Add item to Launch')).toHaveProperty(
      'value',
      'Book venue',
    );
    expect(screen.getByText("Couldn't save this.")).toBeTruthy();
    expect(screen.getByTestId('list-contextual-add-request-id').textContent).toBe(
      'req_context_add_9',
    );
    expect(mocks.view.refresh).not.toHaveBeenCalled();
  });

  it('waits for the More sheet to close before presenting List settings', () => {
    vi.useFakeTimers();
    mount();

    fireEvent.click(screen.getByTestId('list-detail-menu'));
    act(() => vi.advanceTimersByTime(400));
    fireEvent.click(screen.getByTestId('list-settings-open'));

    // iOS can present only one native modal in this transition. The outgoing sheet remains
    // mounted for its exit, so the destination must wait for that lifecycle to complete.
    expect(screen.queryByRole('dialog', { name: 'List settings' })).toBeNull();
    expect(screen.getByTestId('list-header-menu')).toBeTruthy();

    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'List settings' })).toBeTruthy();
  });

  it('confirms list deletion from the detail menu before deleting and leaving', () => {
    mount();

    fireEvent.click(screen.getByTestId('list-detail-menu'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete list' }));

    expect(mocks.removeList).not.toHaveBeenCalled();
    expect(screen.getByText('Delete "Launch"?')).toBeTruthy();
    expect(screen.getByRole('alertdialog', { name: 'Delete "Launch"?' })).toBeTruthy();
    expect(screen.getByText('3 List items will be removed')).toBeTruthy();
    expect(screen.getByText('Linked Plans will remain')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));

    // The settings sheet is still animating out (P3-51) while the alert is up, so the
    // confirming control is the alert's own, not the sheet's row of the same name.
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Delete list',
      }),
    );

    expect(mocks.removeList).toHaveBeenCalledWith(LIST);
    expect(mocks.back).toHaveBeenCalledOnce();
  });
});
