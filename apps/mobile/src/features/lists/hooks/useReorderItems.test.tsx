import { ApiError } from '@od/shared/client';
import type { ListItemView } from '@od/shared/types';
import { onlineManager } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '@/stores/toast';
import { useReorderItems } from './useReorderItems';

/**
 * The write behind one drag (§P3-30, criterion 16).
 *
 * What is under test is the **wire and the gate**: exactly one request per drag, carrying
 * `afterItemId` and no rank; nothing at all issued or enqueued when the connection is
 * unavailable at drop; and a refused move putting the row back with §5.3's toast.
 *
 * The outbox spy is the load-bearing one. §P3-30 says "no reorder intent enters the outbox and
 * no `Pending` state is materialized", and an assertion that only counted HTTP calls would pass
 * just as happily against a client that had quietly queued the move for later.
 */

const calls = vi.hoisted(() => ({ patch: vi.fn(), append: vi.fn() }));

vi.mock('@od/shared/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@od/shared/client')>()),
  patchListItem: calls.patch,
}));

/* Distinct per call, because the identity is exactly what separates one drag from the next. */
vi.mock('expo-crypto', () => {
  let minted = 0;
  return {
    randomUUID: () => {
      minted += 1;
      return `drag-key-${String(minted)}`;
    },
  };
});

/**
 * The one durable queue on the device. Spied at the module boundary rather than asserted
 * through a repository instance, so *any* path into it from a reorder would be caught.
 */
vi.mock('@/lib/sqlite/outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sqlite/outbox')>();
  class SpiedOutbox extends actual.OutboxRepository {
    override append(
      ...args: Parameters<InstanceType<typeof actual.OutboxRepository>['append']>
    ) {
      calls.append(...args);
      return super.append(...args);
    }
  }
  return { ...actual, OutboxRepository: SpiedOutbox };
});

const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';

const item = (suffix: string, rank: string): ListItemView => ({
  itemId: `itm_01J0000000000000000000${suffix}`,
  listId: LIST_ID,
  rank,
  title: suffix,
  checked: false,
});

const A = item('AA', 'a');
const B = item('BB', 'b');
const C = item('CC', 'c');

function setup(items: readonly ListItemView[] = [A, B, C]) {
  const applyRank = vi.fn();
  const onMoved = vi.fn();
  const { result } = renderHook(() =>
    useReorderItems({
      listId: LIST_ID,
      list: { behaviour: 'collection' },
      items,
      applyRank,
      onMoved,
    }),
  );
  return { reorder: result, applyRank, onMoved };
}

let online = true;

beforeEach(() => {
  vi.clearAllMocks();
  useToast.setState({ current: undefined });
  online = true;
  vi.spyOn(onlineManager, 'isOnline').mockImplementation(() => online);
  calls.patch.mockResolvedValue({ ...A, rank: 'cV' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('one drag, one request', () => {
  it('issues exactly one mutation carrying afterItemId and no rank', async () => {
    const { reorder, onMoved } = setup();

    act(() => reorder.current.drop(A.itemId, 2));

    await waitFor(() => expect(calls.patch).toHaveBeenCalledTimes(1));
    const body = calls.patch.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(body).toEqual({ afterItemId: C.itemId });
    // The keyspace is the server's. A rank here would be the client allocating in it.
    expect(Object.hasOwn(body, 'rank')).toBe(false);
    expect(calls.patch.mock.calls[0]?.[1]).toBe(LIST_ID);
    expect(calls.patch.mock.calls[0]?.[2]).toBe(A.itemId);
    await waitFor(() => expect(onMoved).toHaveBeenCalledTimes(1));
  });

  /** `null` is "move to the front"; an empty body would be a request that reordered nothing. */
  it('sends afterItemId: null when the row is dropped at the head', async () => {
    const { reorder } = setup();

    act(() => reorder.current.drop(C.itemId, 0));

    await waitFor(() => expect(calls.patch).toHaveBeenCalledTimes(1));
    expect(calls.patch.mock.calls[0]?.[3]).toEqual({ afterItemId: null });
  });

  /** The optimistic row, then the rank the server allocated. Never a rank on the wire. */
  it('shows the drop, then installs the authoritative rank', async () => {
    const { reorder, applyRank } = setup();

    act(() => reorder.current.drop(A.itemId, 2));

    await waitFor(() => expect(applyRank).toHaveBeenCalledTimes(2));
    const [optimistic, authoritative] = applyRank.mock.calls;
    expect(optimistic?.[0]).toBe(A.itemId);
    expect(String(optimistic?.[1])).toSatisfy((rank: string) => rank > 'c');
    expect(authoritative).toEqual([A.itemId, 'cV']);
  });

  /** §P3-30's first edge case. Nothing is sent and nothing is drawn. */
  it('issues no request for a drop back where it started', () => {
    const { reorder, applyRank } = setup();

    act(() => reorder.current.drop(B.itemId, 1));

    expect(calls.patch).not.toHaveBeenCalled();
    expect(applyRank).not.toHaveBeenCalled();
    expect(useToast.getState().current).toBeUndefined();
  });

  /** §8.1's guard, from the hook's side: a refused plan is a refused request. */
  it('issues no request for a target outside a watch row group', () => {
    const watchItem = (suffix: string, rank: string, status: 'want' | 'watched') => ({
      ...item(suffix, rank),
      details: { behaviour: 'watch' as const, watchStatus: status },
    });
    const applyRank = vi.fn();
    const { result } = renderHook(() =>
      useReorderItems({
        listId: LIST_ID,
        list: { behaviour: 'watch' },
        items: [watchItem('AA', 'a', 'want'), watchItem('BB', 'b', 'watched')],
        applyRank,
        onMoved: vi.fn(),
      }),
    );

    act(() => result.current.drop(`itm_01J0000000000000000000AA`, 1));

    expect(calls.patch).not.toHaveBeenCalled();
  });
});

describe('offline at drop', () => {
  it('springs back, says so exactly, and issues and enqueues nothing', () => {
    online = false;
    const { reorder, applyRank, onMoved } = setup();

    act(() => reorder.current.drop(A.itemId, 2));

    // The row was never moved, so there is nothing to put back.
    expect(applyRank).not.toHaveBeenCalled();
    expect(calls.patch).not.toHaveBeenCalled();
    expect(calls.append).not.toHaveBeenCalled();
    expect(onMoved).not.toHaveBeenCalled();
    // Verbatim (§P3-30).
    expect(useToast.getState().current?.message).toBe('Reordering needs a connection.');
    // Not an offer to try later: there is no queued write for a `Retry` to flush.
    const toast = useToast.getState().current;
    expect(toast && 'action' in toast ? toast.action : undefined).toBeUndefined();
  });

  /** Consulted at the **drop**: a drag begun offline and dropped online still goes. */
  it('sends a drop made after the connection came back', async () => {
    online = false;
    const { reorder } = setup();
    act(() => reorder.current.drop(A.itemId, 2));
    expect(calls.patch).not.toHaveBeenCalled();

    online = true;
    act(() => reorder.current.drop(A.itemId, 2));

    await waitFor(() => expect(calls.patch).toHaveBeenCalledTimes(1));
  });
});

describe('a refused move', () => {
  it('puts the row back and offers Retry (§5.3)', async () => {
    calls.patch.mockRejectedValue(new ApiError('internal', 'No.', 503, 'req-move'));
    const { reorder, applyRank } = setup();

    act(() => reorder.current.drop(A.itemId, 2));

    await waitFor(() => expect(applyRank).toHaveBeenCalledTimes(2));
    // The rank it came from, so the row returns to where the user took it from.
    expect(applyRank.mock.calls[1]).toEqual([A.itemId, 'a']);
    const toast = useToast.getState().current;
    expect(toast?.message).toBe('Something went wrong.');
    expect(toast && 'action' in toast ? toast.action?.label : undefined).toBe('Retry');
  });

  /** One drag is one mutation, and `Retry` re-sends **that** drag rather than a new one. */
  it('retries the same position rather than recomputing one', async () => {
    calls.patch.mockRejectedValueOnce(new ApiError('internal', 'No.', 503, 'req-move'));
    calls.patch.mockResolvedValue({ ...A, rank: 'cV' });
    const { reorder } = setup();
    act(() => reorder.current.drop(A.itemId, 2));
    await waitFor(() => expect(useToast.getState().current?.message).toBeDefined());

    const toast = useToast.getState().current;
    act(() => {
      if (toast && 'action' in toast) toast.action?.onPress();
    });

    await waitFor(() => expect(calls.patch).toHaveBeenCalledTimes(2));
    expect(calls.patch.mock.calls[1]?.[3]).toEqual({ afterItemId: C.itemId });
  });

  /** A `Retry` for a drag the user has already replaced must not resurrect it. */
  it('refuses a Retry once a newer drag has taken the row', async () => {
    calls.patch.mockRejectedValueOnce(new ApiError('internal', 'No.', 503, 'req-move'));
    calls.patch.mockResolvedValue({ ...A, rank: 'cV' });
    const { reorder } = setup();
    act(() => reorder.current.drop(A.itemId, 2));
    await waitFor(() => expect(useToast.getState().current?.message).toBeDefined());
    const stale = useToast.getState().current;

    act(() => reorder.current.drop(A.itemId, 1));
    await waitFor(() => expect(calls.patch).toHaveBeenCalledTimes(2));

    act(() => {
      if (stale && 'action' in stale) stale.action?.onPress();
    });

    expect(calls.patch).toHaveBeenCalledTimes(2);
  });
});
