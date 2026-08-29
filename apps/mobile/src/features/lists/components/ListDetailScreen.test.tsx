import { instant } from '@od/shared/schemas';
import type { List, ListItemView } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListDetailView } from '../hooks/useListDetail';
import { ListDetailScreen } from './ListDetailScreen';

const mocks = vi.hoisted(() => ({
  view: {} as ListDetailView,
  save: vi.fn(),
  uncheckAll: vi.fn(),
  clearDone: vi.fn(),
  archive: vi.fn(),
  removeList: vi.fn(),
  back: vi.fn(),
  drop: vi.fn(),
  add: vi.fn(),
}));

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
    errorMessage: undefined,
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

  it('uses stored empty guidance and keeps the persistent add row', () => {
    setView({ items: [], itemCount: 0 });
    mount();
    expect(screen.getByText('Nothing here')).toBeTruthy();
    expect(screen.getByText('Add a task.')).toBeTruthy();
    expect(screen.getByText('Add to Launch')).toBeTruthy();
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
