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
  const rendered = render(
    <ThemeProvider scheme="light">
      <AddListToPlanSheet open source={PLAN} onClose={onClose} />
    </ThemeProvider>,
  );
  return { onClose, ...rendered };
}

it('starts with exactly Create new list and Choose existing list, with nothing selected', () => {
  mount();

  expect(screen.getByRole('heading', { name: 'Add list' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Create new list' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Choose existing list' })).toBeDefined();
  expect(screen.queryByText('Packing')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add to plan' })).toBeNull();
});

it('dismisses the chooser before presenting the sourced creation flow', async () => {
  mount();

  fireEvent.click(screen.getByRole('button', { name: 'Create new list' }));

  // Native may present only one modal owner at a time. The chooser must finish its exit
  // before the creation sheet mounts, otherwise iOS leaves a blank modal over frozen detail.
  expect(screen.queryByTestId('create-list-flow')).toBeNull();
  await vi.waitFor(() => expect(screen.getByTestId('create-list-flow')).toBeDefined());
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

it('keeps disabled rows inert and exposes the eligible selection state', () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Choose existing list' }));

  const add = screen.getByRole('button', { name: 'Add to plan' });
  const unavailable = screen.getByRole('button', {
    name: 'Another plan. Already connected to a plan',
  });
  expect(unavailable.hasAttribute('disabled')).toBe(true);
  fireEvent.click(unavailable);
  expect(add.hasAttribute('disabled')).toBe(true);

  const packing = screen.getByRole('button', { name: 'Packing. 4 items' });
  expect(packing.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(packing);
  expect(packing.getAttribute('aria-pressed')).toBe('true');
  expect(add.hasAttribute('disabled')).toBe(false);
});

it('invalidates a selected List when a refresh links it elsewhere', () => {
  const mounted = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Choose existing list' }));
  fireEvent.click(screen.getByRole('button', { name: 'Packing. 4 items' }));
  expect(
    screen.getByRole('button', { name: 'Add to plan' }).hasAttribute('disabled'),
  ).toBe(false);

  listsHook.current = {
    ...listsHook.current,
    lists: listsHook.current.lists.map((current) =>
      current.title === 'Packing'
        ? { ...current, sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1ZZ' }
        : current,
    ),
  };
  mounted.rerender(
    <ThemeProvider scheme="light">
      <AddListToPlanSheet open source={PLAN} onClose={mounted.onClose} />
    </ThemeProvider>,
  );

  expect(screen.getByLabelText('Packing. Already connected to a plan')).toBeDefined();
  const add = screen.getByRole('button', { name: 'Add to plan' });
  expect(add.hasAttribute('disabled')).toBe(true);
  fireEvent.click(add);
  expect(attachHook.current.attach).not.toHaveBeenCalled();
});

it('renders loading, first-page failure, request id, and retry without inventing an empty state', () => {
  const refetch = vi.fn();
  listsHook.current = {
    ...listsHook.current,
    status: 'error',
    lists: [],
    message: 'Something went wrong.',
    requestId: 'req_lists_1',
    refetch,
  };
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Choose existing list' }));

  expect(screen.getByRole('alert').textContent).toContain('Something went wrong.');
  expect(screen.getByText('req_lists_1')).toBeDefined();
  expect(screen.queryByText('No active lists yet.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(refetch).toHaveBeenCalledOnce();
});

it('keeps the picker in a loading state until the first page settles', () => {
  listsHook.current = {
    ...listsHook.current,
    status: 'pending',
    lists: [],
  };
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Choose existing list' }));

  expect(screen.getByText('Loading lists…')).toBeDefined();
  expect(screen.queryByText('No active lists yet.')).toBeNull();
});

it('keeps paging when a page contains only archived Lists', () => {
  const loadMore = vi.fn();
  listsHook.current = {
    ...listsHook.current,
    lists: [list({ archived: true })],
    hasMore: true,
    loadMore,
  };
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Choose existing list' }));

  expect(screen.getByText('Looking for active lists…')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Load more lists' }));
  expect(loadMore).toHaveBeenCalledOnce();
  expect(screen.queryByText('No active lists yet.')).toBeNull();
});

it('shows a later-page failure and offers an explicit retry', () => {
  const retry = vi.fn();
  listsHook.current = {
    ...listsHook.current,
    hasMore: true,
    loadMoreFailure: {
      message: 'Something went wrong.',
      requestId: 'req_page_2',
      retry,
    },
  };
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Choose existing list' }));

  expect(screen.getByRole('alert').textContent).toContain('Something went wrong.');
  expect(screen.getByText('req_page_2')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading lists' }));
  expect(retry).toHaveBeenCalledOnce();
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
