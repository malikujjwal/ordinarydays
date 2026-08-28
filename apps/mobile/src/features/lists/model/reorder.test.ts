import { compareListItems } from '@od/shared/rank';
import type { ListItemView } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  dropIndex,
  orderedItems,
  planReorder,
  REORDER_OFFLINE_MESSAGE,
  type ReorderList,
  reorderRange,
} from './reorder';

/**
 * What a drop means (§P3-30, acceptance criteria 16 and 29).
 *
 * The drag itself cannot be simulated, so this is where the decisions live and where they are
 * checked: the position that travels, the drops that write nothing, and the guard that keeps a
 * `watch` row inside its own status group.
 */

const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';

const item = (
  suffix: string,
  rank: string,
  overrides: Partial<ListItemView> = {},
): ListItemView => ({
  itemId: `itm_01J0000000000000000000${suffix}`,
  listId: LIST_ID,
  rank,
  title: suffix,
  checked: false,
  ...overrides,
});

const id = (suffix: string) => `itm_01J0000000000000000000${suffix}`;

const COLLECTION: ReorderList = { behaviour: 'collection' };
const WATCH: ReorderList = { behaviour: 'watch' };
const MEALS: ReorderList = { behaviour: 'meals' };

/** `A < B < C < D` by rank. */
const A = item('AA', 'a');
const B = item('BB', 'b');
const C = item('CC', 'c');
const D = item('DD', 'd');
const LIST = [A, B, C, D];

const watchItem = (
  suffix: string,
  rank: string,
  status: 'want' | 'watching' | 'watched',
) => item(suffix, rank, { details: { behaviour: 'watch', watchStatus: status } });

describe('the order is the one comparator', () => {
  /**
   * Criterion 29, at the client end: two items with an identical rank and different ids order
   * the same way whichever order they arrive in. Both shuffles, because a comparator that read
   * only `rank` would return `0` and leave the input order standing.
   */
  it('renders duplicate ranks identically from either input order', () => {
    const first = item('AA', 'm');
    const second = item('BB', 'm');

    const forwards = orderedItems([first, second]).map((row) => row.itemId);
    const backwards = orderedItems([second, first]).map((row) => row.itemId);

    expect(forwards).toEqual([first.itemId, second.itemId]);
    expect(backwards).toEqual(forwards);
    expect(compareListItems(first, second)).toBe(-1);
  });

  it('sorts an arbitrarily shuffled projection into rank order', () => {
    expect(orderedItems([C, A, D, B]).map((row) => row.rank)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  /** The plan is computed from the sorted order, not from the array it was handed. */
  it('plans the same move whatever order the projection arrived in', () => {
    expect(planReorder(COLLECTION, [D, B, A, C], A.itemId, 2)).toEqual(
      planReorder(COLLECTION, LIST, A.itemId, 2),
    );
  });
});

describe('the position that travels', () => {
  /** "The id of the item now immediately above, absent for the head." */
  it('names the item now immediately above', () => {
    expect(planReorder(COLLECTION, LIST, A.itemId, 2)).toMatchObject({
      itemId: A.itemId,
      afterItemId: C.itemId,
    });
  });

  /**
   * `null`, not absent. The schema is explicit that an absent `afterItemId` is "no reorder at
   * all", so a head move that omitted it would be a request that did nothing.
   */
  it('sends null for the head rather than omitting the field', () => {
    const plan = planReorder(COLLECTION, LIST, D.itemId, 0);

    expect(plan?.afterItemId).toBeNull();
    expect(Object.hasOwn(plan ?? {}, 'afterItemId')).toBe(true);
  });

  it('names the last item when a row is dropped at the end', () => {
    expect(planReorder(COLLECTION, LIST, A.itemId, 3)?.afterItemId).toBe(D.itemId);
  });

  /** A drop back where it started issues no write (§P3-30's first edge case). */
  it('has no plan for a drop back where it started', () => {
    expect(planReorder(COLLECTION, LIST, B.itemId, 1)).toBeUndefined();
  });

  it('has no plan for a row that is not in the list', () => {
    expect(planReorder(COLLECTION, LIST, id('ZZ'), 0)).toBeUndefined();
  });

  it('has no plan for a target beyond the ends of the list', () => {
    expect(planReorder(COLLECTION, LIST, A.itemId, 4)).toBeUndefined();
    expect(planReorder(COLLECTION, LIST, A.itemId, -1)).toBeUndefined();
  });
});

describe('the provisional rank', () => {
  /**
   * Display only. The plan carries it so the row can land under the finger; the request carries
   * `afterItemId` alone, which `useReorderItems.test.tsx` asserts on the wire.
   */
  it('falls strictly between the neighbours it lands between', () => {
    const plan = planReorder(COLLECTION, LIST, A.itemId, 2);

    // String comparison, deliberately: the rank alphabet is ASCII-collated and so is the sort.
    expect(plan?.rank).toBeDefined();
    expect(plan?.rank ?? '').toSatisfy((rank: string) => rank > 'c' && rank < 'd');
  });

  /** Equal adjacent ranks are the repository's to repair; the request still goes. */
  it('is absent, and the plan survives, when the gap cannot be split', () => {
    const left = item('AA', 'm');
    const middle = item('BB', 'm');
    const mover = item('CC', 'z');

    const plan = planReorder(COLLECTION, [left, middle, mover], mover.itemId, 1);

    expect(plan).toMatchObject({ itemId: mover.itemId, afterItemId: left.itemId });
    expect(plan?.rank).toBeUndefined();
  });
});

/**
 * §8.1 and §P3-30's recorded decision: dragging across a heading would change `watchStatus` by
 * gesture, and status changes are the item sheet's explicit controls.
 */
describe('the watch group guard', () => {
  const WANT_ONE = watchItem('AA', 'a', 'want');
  const WATCHING = watchItem('BB', 'b', 'watching');
  const WANT_TWO = watchItem('CC', 'c', 'want');
  const WATCHED = watchItem('DD', 'd', 'watched');
  const WATCHLIST = [WANT_ONE, WATCHING, WANT_TWO, WATCHED];

  it('lets a row move within its own status group', () => {
    /*
     * The other `want` sits at index 1 of the remaining rows, so the group spans 1..2 — widened
     * to 0 because a row may always be put back where it came from.
     */
    expect(reorderRange(WATCH, WATCHLIST, WANT_ONE.itemId)).toEqual({
      first: 0,
      last: 2,
    });
    // Below the other member of its own group, which is the far end of what it may reach.
    expect(planReorder(WATCH, WATCHLIST, WANT_ONE.itemId, 2)).toMatchObject({
      afterItemId: WANT_TWO.itemId,
    });
  });

  it('refuses a target past the last member of the group', () => {
    expect(planReorder(WATCH, WATCHLIST, WANT_ONE.itemId, 3)).toBeUndefined();
  });

  it('refuses a target before the first member of the group', () => {
    expect(planReorder(WATCH, WATCHLIST, WATCHED.itemId, 0)).toBeUndefined();
    expect(planReorder(WATCH, WATCHLIST, WATCHED.itemId, 1)).toBeUndefined();
  });

  /** A group of one has exactly one position, so every drag is refused. */
  it('pins the only member of a group where it is', () => {
    expect(reorderRange(WATCH, WATCHLIST, WATCHING.itemId)).toEqual({
      first: 1,
      last: 1,
    });
    for (const target of [0, 1, 2, 3]) {
      expect(planReorder(WATCH, WATCHLIST, WATCHING.itemId, target)).toBeUndefined();
    }
  });

  /** Invalid data: no range is invented over an item whose group cannot be read. */
  it('refuses a watch row that carries no typed details', () => {
    const untyped = item('EE', 'e');

    expect(reorderRange(WATCH, [...WATCHLIST, untyped], untyped.itemId)).toBeUndefined();
    expect(
      planReorder(WATCH, [...WATCHLIST, untyped], untyped.itemId, 0),
    ).toBeUndefined();
  });

  /** The guard is the behaviour's, not the details': a meals list reorders freely. */
  it('constrains nothing on the other two behaviours', () => {
    expect(reorderRange(COLLECTION, LIST, A.itemId)).toEqual({ first: 0, last: 3 });
    expect(reorderRange(MEALS, LIST, A.itemId)).toEqual({ first: 0, last: 3 });
  });

  /** §5.6: a checked row reorders like any other and stays where it is put. */
  it('constrains nothing about a checked row', () => {
    const checked = [item('AA', 'a', { checked: true }), B, C];

    expect(reorderRange(COLLECTION, checked, id('AA'))).toEqual({ first: 0, last: 2 });
    expect(planReorder(COLLECTION, checked, id('AA'), 2)?.afterItemId).toBe(C.itemId);
  });
});

/**
 * Heights rather than a constant row height: a list row is one line or four, so a fixed height
 * would put the drop in the wrong gap on any list with a note or a place on it.
 */
describe('the drop index a finger reached', () => {
  // Row 0 is tall — a title with a note — and the rest are single lines.
  const HEIGHTS = [96, 48, 48, 48];

  it('is where it started when the finger has not moved', () => {
    expect(dropIndex(HEIGHTS, 0, 0)).toBe(0);
    expect(dropIndex(HEIGHTS, 2, 0)).toBe(2);
  });

  /**
   * The tall row's centre starts at 48 and row 1's is at 120, so it has to travel 72 before it
   * has passed anything — which is the point of measuring rather than assuming a row height.
   */
  it('counts the rows whose centres the dragged row has passed going down', () => {
    expect(dropIndex(HEIGHTS, 0, 60)).toBe(0);
    expect(dropIndex(HEIGHTS, 0, 80)).toBe(1);
    expect(dropIndex(HEIGHTS, 0, 130)).toBe(2);
  });

  it('counts them going up, from the same centre rule', () => {
    expect(dropIndex(HEIGHTS, 3, -20)).toBe(3);
    expect(dropIndex(HEIGHTS, 3, -60)).toBe(2);
    expect(dropIndex(HEIGHTS, 3, -200)).toBe(0);
  });

  /** A short row moving under a tall one has to clear the tall one's centre, not its edge. */
  it('measures against the row it is passing, not a nominal height', () => {
    expect(dropIndex(HEIGHTS, 1, -30)).toBe(1);
    expect(dropIndex(HEIGHTS, 1, -80)).toBe(0);
  });

  it('never answers past the ends however far the finger travels', () => {
    expect(dropIndex(HEIGHTS, 1, 10_000)).toBe(3);
    expect(dropIndex(HEIGHTS, 1, -10_000)).toBe(0);
  });
});

describe('the copy', () => {
  /** Verbatim, because §P3-30 quotes it and the test is the only thing that keeps it so. */
  it('is the exact offline message', () => {
    expect(REORDER_OFFLINE_MESSAGE).toBe('Reordering needs a connection.');
  });
});
