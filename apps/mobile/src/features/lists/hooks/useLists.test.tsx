import { ApiError } from '@od/shared/client';
import { instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useLists } from './useLists';

const calls = vi.hoisted(() => ({ getLists: vi.fn(), getMe: vi.fn() }));
vi.mock('@od/shared/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@od/shared/client')>()),
  getLists: calls.getLists,
  getMe: calls.getMe,
}));

const list = (listId: string, title: string): List => ({
  schemaVersion: 2,
  listId,
  ownerId: 'usr_local_dev',
  templateKey: 'checklist',
  title,
  icon: 'check-square',
  emptyStateCopy: 'Add an item.',
  itemStateMode: { mode: 'checkbox' },
  featureConfig: {},
  slot: null,
  itemCount: 0,
  doneCount: 0,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-09-03T12:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-09-03T12:00:00.000Z'),
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, networkMode: 'always' } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useLists(), { wrapper });
}

beforeEach(() => {
  calls.getLists.mockReset();
  calls.getMe.mockReset();
  calls.getMe.mockResolvedValue({ userId: 'usr_local_dev', timezone: 'UTC' });
});

it('keeps loaded rows and exposes a retryable later-page failure separately', async () => {
  const first = list('lst_01J8XKQ2M4N5P6R7S8T9V0W1X2', 'Packing');
  calls.getLists
    .mockResolvedValueOnce({
      data: [first],
      meta: { requestId: 'req_page_1', nextCursor: 'cursor_2' },
    })
    .mockRejectedValueOnce(
      new ApiError('internal', 'DynamoDB throttled', 500, 'req_page_2'),
    )
    .mockResolvedValueOnce({
      data: [list('lst_01J8XKQ2M4N5P6R7S8T9V0W1X3', 'Groceries')],
      meta: { requestId: 'req_page_2_retry' },
    });
  const mounted = setup();

  await waitFor(() => expect(mounted.result.current.lists).toEqual([first]));
  act(() => mounted.result.current.loadMore());

  await waitFor(() =>
    expect(mounted.result.current.loadMoreFailure).toMatchObject({
      message: 'Something went wrong.',
      requestId: 'req_page_2',
    }),
  );
  expect(mounted.result.current.lists).toEqual([first]);
  expect(mounted.result.current.message).toBeUndefined();

  act(() => mounted.result.current.loadMoreFailure?.retry());
  await waitFor(() => expect(mounted.result.current.lists).toHaveLength(2));
  expect(mounted.result.current.loadMoreFailure).toBeUndefined();
  expect(calls.getLists).toHaveBeenCalledTimes(3);
});

it('does not report success or ownership until the viewer identity resolves', async () => {
  let resolveIdentity!: (identity: { userId: string; timezone: string }) => void;
  const identity = new Promise<{ userId: string; timezone: string }>((resolve) => {
    resolveIdentity = resolve;
  });
  const first = list('lst_01J8XKQ2M4N5P6R7S8T9V0W1X2', 'Packing');
  calls.getLists.mockResolvedValue({
    data: [first],
    meta: { requestId: 'req_page_1' },
  });
  calls.getMe.mockReturnValue(identity);
  const mounted = setup();

  await waitFor(() => expect(mounted.result.current.lists).toEqual([first]));
  expect(mounted.result.current.status).toBe('pending');
  expect(mounted.result.current.viewerUserId).toBeUndefined();

  act(() => resolveIdentity({ userId: 'usr_local_dev', timezone: 'UTC' }));
  await waitFor(() => expect(mounted.result.current.status).toBe('success'));
  expect(mounted.result.current.viewerUserId).toBe('usr_local_dev');
});

it('surfaces a safe identity failure and refetch retries both identity and Lists', async () => {
  const first = list('lst_01J8XKQ2M4N5P6R7S8T9V0W1X2', 'Packing');
  calls.getLists.mockResolvedValue({
    data: [first],
    meta: { requestId: 'req_page_1' },
  });
  calls.getMe
    .mockRejectedValueOnce(new ApiError('internal', 'identity exploded', 500, 'req_me_1'))
    .mockResolvedValueOnce({ userId: 'usr_local_dev', timezone: 'UTC' });
  const mounted = setup();

  await waitFor(() => expect(mounted.result.current.status).toBe('error'));
  expect(mounted.result.current.message).toBe('Something went wrong.');
  expect(mounted.result.current.requestId).toBe('req_me_1');
  expect(mounted.result.current.viewerUserId).toBeUndefined();

  act(() => mounted.result.current.refetch());
  await waitFor(() => expect(mounted.result.current.status).toBe('success'));
  expect(mounted.result.current.viewerUserId).toBe('usr_local_dev');
  expect(calls.getMe).toHaveBeenCalledTimes(2);
  expect(calls.getLists).toHaveBeenCalledTimes(2);
});
