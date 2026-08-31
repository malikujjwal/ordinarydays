import type { ListItemView } from '@od/shared/types';
import { onlineManager } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '@/stores/toast';
import { useReorderItems } from './useReorderItems';

const calls = vi.hoisted(() => ({ patch: vi.fn(), uuid: vi.fn() }));
vi.mock('@od/shared/client', async (original) => ({
  ...(await original<typeof import('@od/shared/client')>()),
  patchListItem: calls.patch,
}));
vi.mock('expo-crypto', () => ({ randomUUID: calls.uuid }));

const item = (
  id: string,
  rank: string,
  state: ListItemView['state'] = 'open',
): ListItemView => ({
  itemId: `itm_01J00000000000000000000${id}`,
  listId: 'lst_01J0000000000000000000000A',
  rank,
  title: id,
  state,
});
const rows = [item('AA', 'a'), item('BB', 'b')] as const;

beforeEach(() => {
  calls.patch.mockReset();
  calls.uuid.mockReset().mockReturnValue('drag_1');
  onlineManager.setOnline(true);
  useToast.setState({ current: undefined });
});

describe('useReorderItems', () => {
  it('holds one optimistic display order until the authoritative rank reconciles', async () => {
    let resolvePatch!: (item: ListItemView) => void;
    calls.patch.mockReturnValue(
      new Promise<ListItemView>((resolve) => {
        resolvePatch = resolve;
      }),
    );
    const applyRank = vi.fn();
    const onMoved = vi.fn();
    const mounted = renderHook(
      ({ items }: { items: readonly ListItemView[] }) =>
        useReorderItems({
          listId: rows[0].listId,
          list: { itemStateMode: { mode: 'none' } },
          items,
          applyRank,
          onMoved,
        }),
      { initialProps: { items: rows } },
    );

    act(() => mounted.result.current.drop(rows[1].itemId, 0));

    expect(applyRank).not.toHaveBeenCalled();
    expect(mounted.result.current.items.map((entry) => entry.itemId)).toEqual([
      rows[1].itemId,
      rows[0].itemId,
    ]);
    expect(new Set(mounted.result.current.items.map((entry) => entry.itemId)).size).toBe(
      rows.length,
    );
    expect(calls.patch).toHaveBeenCalledOnce();

    await act(async () => {
      resolvePatch({ ...rows[1], rank: 'A' });
      await Promise.resolve();
    });

    await waitFor(() => expect(applyRank).toHaveBeenCalledOnce());
    expect(mounted.result.current.items.map((entry) => entry.itemId)).toEqual([
      rows[1].itemId,
      rows[0].itemId,
    ]);

    mounted.rerender({ items: [{ ...rows[1], rank: 'A' }, rows[0]] });
    expect(mounted.result.current.items.map((entry) => entry.itemId)).toEqual([
      rows[1].itemId,
      rows[0].itemId,
    ]);
    expect(calls.patch).toHaveBeenCalledOnce();
    expect(onMoved).toHaveBeenCalledOnce();
  });

  it('sends only the absolute neighbour position and installs the server rank', async () => {
    calls.patch.mockResolvedValue({ ...rows[1], rank: 'A' });
    const applyRank = vi.fn();
    const onMoved = vi.fn();
    const mounted = renderHook(() =>
      useReorderItems({
        listId: rows[0].listId,
        list: { itemStateMode: { mode: 'none' } },
        items: rows,
        applyRank,
        onMoved,
      }),
    );

    act(() => mounted.result.current.drop(rows[1].itemId, 0));

    expect(calls.patch).toHaveBeenCalledWith(
      expect.anything(),
      rows[0].listId,
      rows[1].itemId,
      { afterItemId: null },
    );
    await waitFor(() => expect(onMoved).toHaveBeenCalledOnce());
    expect(applyRank).toHaveBeenLastCalledWith(rows[1].itemId, 'A');
  });

  /**
   * The 2026-08-31 "reorder replay": equal adjacent ranks — the restored-or-legacy
   * duplicates `(rank, itemId)` is defensive for — make the gap unsplittable, and the
   * overlay used to be rank-based, so the dragged row sprang back to its old slot for a
   * full server round-trip before jumping to its destination. The move is positional
   * now: the finger's order holds from the drop, whatever the ranks can express.
   */
  it('moves the row immediately even when the rank gap cannot be split', async () => {
    const duplicates = [item('AA', 'm'), item('BB', 'm'), item('CC', 'z')] as const;
    let resolvePatch!: (moved: ListItemView) => void;
    calls.patch.mockReturnValue(
      new Promise<ListItemView>((resolve) => {
        resolvePatch = resolve;
      }),
    );
    const mounted = renderHook(() =>
      useReorderItems({
        listId: duplicates[0].listId,
        list: { itemStateMode: { mode: 'none' } },
        items: duplicates,
        applyRank: vi.fn(),
        onMoved: vi.fn(),
      }),
    );

    // CC lands between the two 'm' ranks: no provisional rank can exist there.
    act(() => mounted.result.current.drop(duplicates[2].itemId, 1));

    expect(mounted.result.current.items.map((entry) => entry.itemId)).toEqual([
      duplicates[0].itemId,
      duplicates[2].itemId,
      duplicates[1].itemId,
    ]);
    expect(calls.patch).toHaveBeenCalledWith(
      expect.anything(),
      duplicates[0].listId,
      duplicates[2].itemId,
      { afterItemId: duplicates[0].itemId },
    );

    await act(async () => {
      resolvePatch({ ...duplicates[2], rank: 'mm' });
      await Promise.resolve();
    });
    expect(mounted.result.current.items.map((entry) => entry.itemId)).toEqual([
      duplicates[0].itemId,
      duplicates[2].itemId,
      duplicates[1].itemId,
    ]);
  });

  it('returns the row to its committed position when the reorder is refused', async () => {
    calls.patch.mockRejectedValue(new Error('The request could not be sent.'));
    const mounted = renderHook(() =>
      useReorderItems({
        listId: rows[0].listId,
        list: { itemStateMode: { mode: 'none' } },
        items: rows,
        applyRank: vi.fn(),
        onMoved: vi.fn(),
      }),
    );

    act(() => mounted.result.current.drop(rows[1].itemId, 0));
    await waitFor(() =>
      expect(mounted.result.current.items.map((entry) => entry.itemId)).toEqual([
        rows[0].itemId,
        rows[1].itemId,
      ]),
    );
  });

  it('refuses offline drops without writing', () => {
    onlineManager.setOnline(false);
    const mounted = renderHook(() =>
      useReorderItems({
        listId: rows[0].listId,
        list: { itemStateMode: { mode: 'none' } },
        items: rows,
        applyRank: vi.fn(),
        onMoved: vi.fn(),
      }),
    );
    act(() => mounted.result.current.drop(rows[1].itemId, 0));
    expect(calls.patch).not.toHaveBeenCalled();
    expect(useToast.getState().current?.message).toBe('Reordering needs a connection.');
  });
});
