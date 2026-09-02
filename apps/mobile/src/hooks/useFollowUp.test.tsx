import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '@/stores/toast';
import { useFollowUpActions } from './useFollowUp';

/**
 * CLAUDE.md rule 5 at the client edge (P3-44): the follow-up renders, the `✕` sends nothing,
 * and only the named tap performs its one write — behind its own Undo.
 */

const { patchListItem, completeActivity, deleteActivity, uncompleteActivity } =
  vi.hoisted(() => ({
    patchListItem: vi.fn(),
    completeActivity: vi.fn(),
    deleteActivity: vi.fn(),
    uncompleteActivity: vi.fn(),
    getList: vi.fn(),
  }));

vi.mock('@od/shared/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@od/shared/client')>()),
  patchListItem,
  completeActivity,
  deleteActivity,
  uncompleteActivity,
  getList: vi.fn(),
}));
vi.mock('expo-crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000000',
}));

const LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ITEM = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const CHILD_A = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const CHILD_B = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X4';

const visited = {
  activity: { activityId: ACT },
  followUp: {
    kind: 'list_item_state',
    listId: LIST,
    listTitle: 'Places',
    itemId: ITEM,
    itemTitle: 'Louvre',
    current: { state: 'open' },
    target: { state: 'done' },
  },
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const currentFollowUp = () => {
  const current = useToast.getState().current;
  return current?.kind === 'undo' ? current.followUp : undefined;
};

beforeEach(() => {
  useToast.setState({ current: undefined });
  patchListItem.mockResolvedValue({ title: 'Louvre', state: 'done' });
  completeActivity.mockResolvedValue({});
  deleteActivity.mockResolvedValue({ activityId: CHILD_A });
});
afterEach(() => vi.clearAllMocks());

describe('useFollowUpActions', () => {
  it('attaches the question to the completion toast without writing anything', () => {
    const { result } = renderHook(() => useFollowUpActions(undefined), { wrapper });
    const toastId = useToast
      .getState()
      .showUndo({ message: 'Task completed', onUndo: vi.fn(), onCommit: vi.fn() });

    act(() =>
      result.current.present(
        visited,
        { activityId: ACT, activityType: 'event' },
        toastId,
      ),
    );

    expect(currentFollowUp()?.message).toBe('Mark Louvre visited in Places?');
    expect(currentFollowUp()?.actions.map((action) => action.label)).toEqual([
      'Mark visited',
    ]);
    expect(patchListItem).not.toHaveBeenCalled();
  });

  it('ignores a completion that carries no follow-up, and one whose toast is gone', () => {
    const { result } = renderHook(() => useFollowUpActions(undefined), { wrapper });
    const toastId = useToast
      .getState()
      .showUndo({ message: 'Task completed', onUndo: vi.fn(), onCommit: vi.fn() });

    act(() =>
      result.current.present(
        { activity: { activityId: ACT } },
        { activityId: ACT, activityType: 'event' },
        toastId,
      ),
    );
    expect(currentFollowUp()).toBeUndefined();

    useToast.getState().show({ message: 'Saved' });
    act(() =>
      result.current.present(
        visited,
        { activityId: ACT, activityType: 'event' },
        toastId,
      ),
    );
    expect(useToast.getState().current?.message).toBe('Saved');
  });

  it('dismissing with ✕ sends no request and keeps the completion', () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useFollowUpActions(undefined), { wrapper });
    const toastId = useToast
      .getState()
      .showUndo({ message: 'Task completed', onUndo: vi.fn(), onCommit });
    act(() =>
      result.current.present(
        visited,
        { activityId: ACT, activityType: 'event' },
        toastId,
      ),
    );

    act(() => useToast.getState().dismiss(toastId));

    expect(patchListItem).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledOnce();
    expect(useToast.getState().current).toBeUndefined();
  });

  it('marks the named item visited only on its tap, behind its own Undo', async () => {
    const { result } = renderHook(() => useFollowUpActions(undefined), { wrapper });
    const toastId = useToast
      .getState()
      .showUndo({ message: 'Task completed', onUndo: vi.fn(), onCommit: vi.fn() });
    act(() =>
      result.current.present(
        visited,
        { activityId: ACT, activityType: 'event' },
        toastId,
      ),
    );

    act(() => currentFollowUp()?.actions[0]?.onPress());

    await waitFor(() =>
      expect(useToast.getState().current?.message).toBe('Louvre marked visited'),
    );
    expect(patchListItem).toHaveBeenCalledWith(expect.anything(), LIST, ITEM, {
      state: 'done',
    });

    act(() => useToast.getState().undo());
    await waitFor(() => expect(patchListItem).toHaveBeenCalledTimes(2));
    expect(patchListItem).toHaveBeenLastCalledWith(expect.anything(), LIST, ITEM, {
      state: 'open',
    });
  });

  it('offers Keep · Complete all · Delete for open prep tasks; Keep writes nothing', () => {
    const { result } = renderHook(() => useFollowUpActions(undefined), { wrapper });
    const toastId = useToast
      .getState()
      .showUndo({ message: 'Task completed', onUndo: vi.fn(), onCommit: vi.fn() });
    act(() =>
      result.current.present(
        {
          activity: { activityId: ACT },
          followUp: { kind: 'open_prep', count: 2, childIds: [CHILD_A, CHILD_B] },
        },
        { activityId: ACT, activityType: 'custom' },
        toastId,
      ),
    );
    expect(currentFollowUp()?.message).toBe(
      '2 one-off prep tasks are still open — keep them?',
    );

    act(() => currentFollowUp()?.actions[0]?.onPress());

    expect(completeActivity).not.toHaveBeenCalled();
    expect(deleteActivity).not.toHaveBeenCalled();
    expect(useToast.getState().current).toBeUndefined();
  });

  it('Complete all completes exactly the named children; Delete asks once more by count', async () => {
    const { result } = renderHook(() => useFollowUpActions(undefined), { wrapper });
    const present = () => {
      const toastId = useToast
        .getState()
        .showUndo({ message: 'Task completed', onUndo: vi.fn(), onCommit: vi.fn() });
      act(() =>
        result.current.present(
          {
            activity: { activityId: ACT },
            followUp: { kind: 'open_prep', count: 2, childIds: [CHILD_A, CHILD_B] },
          },
          { activityId: ACT, activityType: 'custom' },
          toastId,
        ),
      );
    };

    present();
    act(() => currentFollowUp()?.actions[1]?.onPress());
    await waitFor(() => expect(completeActivity).toHaveBeenCalledTimes(2));
    expect(completeActivity.mock.calls.map((call) => call[1])).toEqual([
      CHILD_A,
      CHILD_B,
    ]);
    await waitFor(() =>
      expect(useToast.getState().current?.message).toBe('Completed 2 prep tasks'),
    );

    present();
    act(() => currentFollowUp()?.actions[2]?.onPress());
    expect(deleteActivity).not.toHaveBeenCalled();
    const confirmation = useToast.getState().current;
    expect(confirmation?.message).toBe(
      'Delete 2 open prep tasks? This cannot be undone.',
    );
    expect(
      confirmation?.kind === 'message' ? confirmation.action?.label : undefined,
    ).toBe('Delete 2 tasks');

    act(() => {
      if (confirmation?.kind === 'message') confirmation.action?.onPress();
    });
    await waitFor(() => expect(deleteActivity).toHaveBeenCalledTimes(2));
    expect(deleteActivity.mock.calls.map((call) => call[1])).toEqual([CHILD_A, CHILD_B]);
  });

  it('navigation rows go where the route says and write nothing', () => {
    const openActivity = vi.fn();
    const { result } = renderHook(
      () => useFollowUpActions({ openActivity, openCompose: vi.fn() }),
      { wrapper },
    );
    const toastId = useToast
      .getState()
      .showUndo({ message: 'Task completed', onUndo: vi.fn(), onCommit: vi.fn() });
    act(() =>
      result.current.present(
        {
          activity: { activityId: ACT },
          followUp: { kind: 'meal_ingredients', remaining: 3 },
        },
        { activityId: ACT, activityType: 'meal' },
        toastId,
      ),
    );
    expect(currentFollowUp()?.message).toBe('Add ingredients to a list?');

    act(() => currentFollowUp()?.actions[0]?.onPress());

    expect(openActivity).toHaveBeenCalledWith(ACT);
    expect(patchListItem).not.toHaveBeenCalled();
  });
});
