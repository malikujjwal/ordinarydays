import { instant } from '@od/shared/schemas';
import type { TimeZone } from '@od/shared/time';
import type { List } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AttachListToPlanResult } from '../hooks/useAttachListToPlan';
import type { ListsView } from '../hooks/useLists';
import { AddListToPlanSheet } from './AddListToPlanSheet';

const list = (overrides: Partial<List> = {}): List => ({
  schemaVersion: 2,
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  templateKey: 'checklist',
  title: 'Packing',
  icon: 'check-square',
  emptyStateCopy: 'Add an item.',
  itemStateMode: { mode: 'checkbox' },
  featureConfig: {},
  slot: null,
  itemCount: 4,
  doneCount: 1,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-09-03T12:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-09-03T12:00:00.000Z'),
  ...overrides,
});

const PLAN = {
  activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3',
  planTitle: 'New York Trip',
};

const listsHook = vi.hoisted(() => ({ current: {} as ListsView }));
const attachHook = vi.hoisted(() => ({ current: {} as AttachListToPlanResult }));
vi.mock('../hooks/useLists', () => ({ useLists: () => listsHook.current }));
vi.mock('../hooks/useAttachListToPlan', () => ({
  useAttachListToPlan: () => attachHook.current,
}));
vi.mock('./NewListSheet', () => ({
  NewListSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="create-list-flow">Create list flow</div> : null,
}));

beforeEach(() => {
  listsHook.current = {
    status: 'success',
    lists: [
      list(),
      list({
        listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X4',
        title: 'Already here',
        sourceActivityId: PLAN.activityId,
      }),
      list({
        listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X5',
        title: 'Another plan',
        sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X9',
      }),
      list({
        listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X6',
        title: 'Shared with me',
        ownerId: 'usr_someone_else',
      }),
      list({
        listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X7',
        title: 'Archived',
        archived: true,
      }),
    ],
    timezone: 'UTC' as TimeZone,
    viewerUserId: 'usr_local_dev',
    refetch: vi.fn(),
    isLoadingMore: false,
    isOffline: false,
    hasMore: false,
    loadMore: vi.fn(),
  };
  attachHook.current = {
    attach: vi.fn(async () => true),
    isAttaching: false,
    errorMessage: undefined,
    errorRequestId: undefined,
    dismissError: vi.fn(),
  };
});

function mount() {
  const onClose = vi.fn();
  render(
    <ThemeProvider scheme="light">
      <AddListToPlanSheet open source={PLAN} onClose={onClose} />
    </ThemeProvider>,
  );
  return { onClose };
}

it('starts with exactly Create new list and Choose existing list, with nothing selected', () => {
  mount();

  expect(screen.getByRole('heading', { name: 'Add list' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Create new list' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Choose existing list' })).toBeDefined();
  expect(screen.queryByText('Packing')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add to plan' })).toBeNull();
});

it('hands Create new list to the unchanged sourced creation flow', () => {
  mount();

  fireEvent.click(screen.getByRole('button', { name: 'Create new list' }));

  expect(screen.getByTestId('create-list-flow')).toBeDefined();
});

it('shows active accessible Lists and explains every ineligible row', () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Choose existing list' }));

  expect(screen.getByRole('button', { name: 'Packing. 4 items' })).toBeDefined();
  expect(screen.getByText('Already added')).toBeDefined();
  expect(screen.getByText('Already connected to a plan')).toBeDefined();
  expect(screen.getByText('Only the owner can add this list')).toBeDefined();
  expect(screen.queryByText('Archived')).toBeNull();
});

it('confirms one eligible selection and closes only after it is projected', async () => {
  const { onClose } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Choose existing list' }));
  fireEvent.click(screen.getByRole('button', { name: 'Packing. 4 items' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add to plan' }));

  await vi.waitFor(() =>
    expect(attachHook.current.attach).toHaveBeenCalledWith(list(), PLAN.activityId),
  );
  expect(onClose).toHaveBeenCalledOnce();
});
