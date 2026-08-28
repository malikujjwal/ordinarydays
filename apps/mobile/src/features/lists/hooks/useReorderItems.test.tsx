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
