import { instant } from '@od/shared/schemas';
import type { List, ListItemView } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  useReorderItems: () => ({ drop: mocks.drop }),
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

  it('groups only populated configured stages and keeps empty headings absent', () => {
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

    expect(screen.getAllByText('Queued').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Building').length).toBeGreaterThan(0);
    expect(screen.queryByText('Shipped')).toBeNull();
  });

  it('offers both done-set actions for a fully loaded checkbox list', () => {
    mount();
    fireEvent.click(screen.getByTestId('list-detail-menu'));
    expect(screen.getByText('Uncheck all (1)')).toBeTruthy();
    expect(screen.getByText('Clear checked (1)')).toBeTruthy();
    fireEvent.click(screen.getByTestId('list-clear-checked'));

    expect(mocks.clearDone).toHaveBeenCalledWith(LIST.listId);
    fireEvent.click(screen.getByTestId('list-detail-menu'));
    fireEvent.click(screen.getByTestId('list-uncheck-all'));

    expect(mocks.uncheckAll).toHaveBeenCalledWith(LIST.listId);
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

  it('puts the reorder overview above rows and the contextual Add row last', () => {
    mount();

    expect(screen.getByTestId('list-detail-body').getAttribute('style')).toContain(
      'padding-top: 8px',
    );
    expect(screen.getByText('3 items · 1 checked')).toBeTruthy();
    expect(screen.getByText('Drag handles to reorder')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add an item' })).toBeTruthy();
    expect(screen.getByText('to Launch')).toBeTruthy();
  });

  it('opens one contextual composer over the still-mounted List without a destination chooser', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add an item' }));

    expect(screen.getByTestId('list-detail')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Add item to Launch' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Add item to Launch' })).toBeTruthy();
    expect(screen.getByLabelText('Title')).toBeTruthy();
    expect(screen.getByLabelText('Note')).toBeTruthy();
    expect(screen.getByText('Optional')).toBeTruthy();
    expect(screen.queryByText('Add to')).toBeNull();
    expect(screen.queryByText('New list')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add to Launch' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
  });

  it('opens the same contextual composer from the sole empty-state action', () => {
    setView({ items: [], itemCount: 0 });
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(screen.getByRole('dialog', { name: 'Add item to Launch' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add an item' })).toBeNull();
  });

  it('persists Title and optional Note as exactly one item, then refreshes once', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add an item' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Book venue' } });
    fireEvent.change(screen.getByLabelText('Note'), {
      target: { value: 'Ask about the courtyard' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to Launch' }));

    await waitFor(() => {
      expect(mocks.add).toHaveBeenCalledOnce();
      expect(mocks.view.refresh).toHaveBeenCalledOnce();
    });
    expect(mocks.add).toHaveBeenCalledWith(LIST.listId, {
      title: 'Book venue',
      note: 'Ask about the courtyard',
    });
    expect(screen.getByLabelText('Title')).toHaveProperty('value', '');
    expect(screen.getByLabelText('Note')).toHaveProperty('value', '');
  });

  it('submits with Return and keeps Title focused for rapid entry', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add an item' }));
    const title = screen.getByLabelText('Title');
    fireEvent.change(title, { target: { value: 'Pack chargers' } });
    title.focus();
    fireEvent.keyDown(title, { key: 'Enter' });

    await waitFor(() => expect(mocks.add).toHaveBeenCalledOnce());
    expect(mocks.add).toHaveBeenCalledWith(LIST.listId, { title: 'Pack chargers' });
    expect(document.activeElement).toBe(title);
    expect(title).toHaveProperty('value', '');
  });

  it('retains both fields and shows the contracted error when the write fails', async () => {
    mocks.addFailure.message = "Couldn't save this.";
    mocks.addFailure.requestId = 'req_context_add_9';
    mocks.add.mockResolvedValue(undefined);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add an item' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Book venue' } });
    fireEvent.change(screen.getByLabelText('Note'), {
      target: { value: 'Ask about the courtyard' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to Launch' }));

    await waitFor(() => expect(mocks.add).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('Title')).toHaveProperty('value', 'Book venue');
    expect(screen.getByLabelText('Note')).toHaveProperty(
      'value',
      'Ask about the courtyard',
    );
    expect(screen.getByRole('alert').textContent).toContain("Couldn't save this.");
    expect(screen.getByRole('alert').textContent).toContain('req_context_add_9');
    expect(mocks.view.refresh).not.toHaveBeenCalled();
  });

  it('confirms list deletion from the detail menu before deleting and leaving', () => {
    mount();

    fireEvent.click(screen.getByTestId('list-detail-menu'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete list' }));

    expect(mocks.removeList).not.toHaveBeenCalled();
    expect(screen.getByText('Delete "Launch"?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete list' }));

    expect(mocks.removeList).toHaveBeenCalledWith(LIST);
    expect(mocks.back).toHaveBeenCalledOnce();
  });
});
