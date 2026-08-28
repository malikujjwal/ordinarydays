import type { ListItemView } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { dropIndex, orderedItems, planReorder, reorderRange } from './reorder';

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
const flat = { itemStateMode: { mode: 'none' } as const };
const grouped = {
  itemStateMode: {
    mode: 'stages',
    labels: { open: 'Queued', active: 'Building', done: 'Shipped' },
    groupByState: true,
  } as const,
};

describe('canonical List reorder', () => {
  it('uses the shared (rank, itemId) order', () => {
    const rows = [item('ZZ', 'b'), item('CC', 'b'), item('AA', 'a')];
    expect(orderedItems(rows).map((row) => row.title)).toEqual(['AA', 'CC', 'ZZ']);
  });

  it('moves across intrinsic states in flat presentation without changing state', () => {
    const rows = [
      item('AA', 'a', 'open'),
      item('BB', 'b', 'done'),
      item('CC', 'c', 'active'),
    ] as const;
    expect(planReorder(flat, rows, rows[0].itemId, 2)).toMatchObject({
      itemId: rows[0].itemId,
      afterItemId: rows[2].itemId,
    });
    expect(rows[0]?.state).toBe('open');
  });

  it('constrains grouped stages to the dragged row state', () => {
    const rows = [
      item('AA', 'a', 'open'),
      item('BB', 'b', 'open'),
      item('CC', 'c', 'active'),
    ] as const;
    expect(reorderRange(grouped, rows, rows[0].itemId)).toEqual({ first: 0, last: 1 });
    expect(planReorder(grouped, rows, rows[0].itemId, 2)).toBeUndefined();
    expect(planReorder(grouped, rows, rows[0].itemId, 1)?.afterItemId).toBe(
      rows[1].itemId,
    );
  });

  it('never writes a no-op and uses null for a move to the head', () => {
    const rows = [item('AA', 'a'), item('BB', 'b')] as const;
    expect(planReorder(flat, rows, rows[0].itemId, 0)).toBeUndefined();
    expect(planReorder(flat, rows, rows[1].itemId, 0)?.afterItemId).toBeNull();
  });

  it('computes insertion from real row heights', () => {
    expect(dropIndex([40, 80, 40], 1, -70)).toBe(0);
    expect(dropIndex([40, 80, 40], 1, 70)).toBe(2);
  });
});
