import { ApiError } from '@od/shared/client';
import type { CompletionFollowUp } from '@od/shared/schemas';
import type { ListItemView } from '@od/shared/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '@/stores/toast';
import { useWatchActions } from './useWatchActions';

/**
 * The two watch writes and their six seconds (§P3-31, `plans-and-lists.md` §8.1, §8.4).
 *
 * What is under test is the **shape of the write and of taking it back**: one `PATCH` on the
 * tap, a toast whose undo sends the previous `details` back, and — the rule the whole feature
 * hangs on — nothing anywhere that reaches `watched` without one.
 */

const calls = vi.hoisted(() => ({ patch: vi.fn() }));

vi.mock('@od/shared/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@od/shared/client')>()),
  patchListItem: calls.patch,
}));

const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ITEM_ID = 'itm_01J0000000000000000000AA';

const SEVERANCE: ListItemView = {
  itemId: ITEM_ID,
  listId: LIST_ID,
  rank: 'm',
  title: 'Severance',
  checked: false,
  details: {
    behaviour: 'watch',
    watchStatus: 'watching',
    mediaKind: 'show',
    season: 2,
    episode: 4,
  },
};

function setup() {
  const onChanged = vi.fn();
  const { result } = renderHook(() => useWatchActions(onChanged));
  return { watch: result, onChanged };
}

const body = (at: number) => calls.patch.mock.calls[at]?.[3] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  useToast.setState({ current: undefined });
  calls.patch.mockResolvedValue(SEVERANCE);
});

describe('Mark watched', () => {
  it('sends one PATCH carrying details and nothing else', async () => {
    const { watch, onChanged } = setup();

    act(() => watch.current.markWatched(LIST_ID, SEVERANCE));

    await waitFor(() => expect(calls.patch).toHaveBeenCalledTimes(1));
    expect(calls.patch.mock.calls[0]?.[1]).toBe(LIST_ID);
    expect(calls.patch.mock.calls[0]?.[2]).toBe(ITEM_ID);
    expect(Object.keys(body(0))).toEqual(['details']);
    expect(body(0).details).toEqual({
      behaviour: 'watch',
      watchStatus: 'watched',
      mediaKind: 'show',
      season: 2,
      episode: 4,
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('offers the six-second undo, naming the row', async () => {
    const { watch } = setup();

    act(() => watch.current.markWatched(LIST_ID, SEVERANCE));

    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));
    const toast = useToast.getState().current;
    expect(toast?.message).toBe('Severance marked watched');
    expect(toast?.duration).toBe(6000);
  });

  /** The inverse is the status the row had, sent as a compensating `PATCH` of its own. */
  it('undo puts the previous status back', async () => {
    const { watch } = setup();
    act(() => watch.current.markWatched(LIST_ID, SEVERANCE));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));

    act(() => useToast.getState().undo());

    await waitFor(() => expect(calls.patch).toHaveBeenCalledTimes(2));
    expect(body(1).details).toEqual({
      behaviour: 'watch',
      watchStatus: 'watching',
      mediaKind: 'show',
      season: 2,
      episode: 4,
    });
    // The undo offers no undo of its own: taking it back again is the original action.
    expect(useToast.getState().current).toBeUndefined();
  });

  /** Letting the window close commits (§4.2): the request already went on the tap. */
  it('sends nothing more when the window closes untouched', async () => {
    const { watch } = setup();
    act(() => watch.current.markWatched(LIST_ID, SEVERANCE));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));

    act(() => useToast.getState().dismiss());

    expect(calls.patch).toHaveBeenCalledTimes(1);
  });

  it('names the row and offers Retry when the write fails', async () => {
    calls.patch.mockRejectedValue(new ApiError('internal', 'No.', 503, 'req-watch'));
    const { watch } = setup();

    act(() => watch.current.markWatched(LIST_ID, SEVERANCE));

    await waitFor(() => expect(useToast.getState().current?.kind).toBe('message'));
    const toast = useToast.getState().current;
    expect(toast?.message).toBe('Something went wrong.');
    expect(toast && 'action' in toast ? toast.action?.label : undefined).toBe('Retry');
  });

  /** Invalid data: there is no status to change, so there is no request. */
  it('sends nothing for a row with no typed details', () => {
    const { watch } = setup();
    const { details, ...withoutDetails } = SEVERANCE;
    void details;

    act(() => watch.current.markWatched(LIST_ID, withoutDetails));

    expect(calls.patch).not.toHaveBeenCalled();
  });
});

describe('the confirmed follow-up (P3-43 calls this)', () => {
  const followUp: CompletionFollowUp = {
    kind: 'watch_progress',
    listId: LIST_ID,
    listTitle: 'Movies and shows',
    itemId: ITEM_ID,
    current: { watchStatus: 'want', season: 2, episode: 4 },
    mediaKind: 'show',
    target: { season: 2, episode: 5 },
  };

  it('writes once, advancing progress and want → watching', async () => {
    const { watch, onChanged } = setup();

    act(() => watch.current.confirmFollowUp(followUp));

    await waitFor(() => expect(calls.patch).toHaveBeenCalledTimes(1));
    expect(body(0)).toEqual({
      details: {
        behaviour: 'watch',
        watchStatus: 'watching',
        mediaKind: 'show',
        season: 2,
        episode: 5,
      },
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('offers its own undo, which restores where the item was', async () => {
    const { watch } = setup();
    act(() => watch.current.confirmFollowUp(followUp));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));
    expect(useToast.getState().current?.duration).toBe(6000);

    act(() => useToast.getState().undo());

    await waitFor(() => expect(calls.patch).toHaveBeenCalledTimes(2));
    expect(body(1).details).toMatchObject({
      watchStatus: 'want',
      season: 2,
      episode: 4,
    });
  });

  /**
   * §8.4: "Dismissing it leaves the item untouched". Dismissal is not a request that declines —
   * it is the absence of one, so there is nothing in this hook for P3-43 to call.
   */
  it('has no dismissal path at all', () => {
    const { watch } = setup();

    expect(Object.keys(watch.current)).toEqual(['markWatched', 'confirmFollowUp']);
  });
});
