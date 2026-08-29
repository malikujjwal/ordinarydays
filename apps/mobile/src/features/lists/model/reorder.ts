import {
  compareListItems,
  LexoRankError,
  LexoRankOverflowError,
  lexoRankBetween,
} from '@od/shared/rank';
import type { ListItemView } from '@od/shared/types';
import type { RowList } from './listItemRow';

/**
 * Where a dragged item lands, and what that costs on the wire
 * ([`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §5.6, §5.11.5;
 * §P3-30; acceptance criteria 16 and 29).
 *
 * Pure, and separate from the gesture for the reason `listItemRow.ts` is: a drag cannot be
 * simulated in a unit test, and the decisions that must not be got wrong here — the no-op, the
 * stage-group guard, the `afterItemId` — are arithmetic over an ordered array. Expressed inside
 * a gesture handler they could only be checked by dragging a real finger across a real device.
 *
 * ## `(rank, itemId)`, in and out, and no second comparator
 *
 * Every function here sorts its input with the one exported `compareListItems` before doing
 * anything, and none of them invents an ordering of its own (acceptance criterion 29). Two
 * items with an identical rank and different ids therefore order the same way whichever order
 * they arrive in, which is exactly the restored-or-legacy duplicate the tie-break is defensive
 * for.
 *
 * ## One logical item moves
 *
 * The plan names **one** item and **one** position. Nothing renumbers, and nothing else is
 * written — criterion 16's "exactly one logical ListItem", stated on the client side of the
 * request that causes it.
 *
 * ## The request carries a position; the rank is the server's
 *
 * `afterItemId` is the id of the item now immediately above — **`null` for the head** — and it
 * is the **only** position that travels. {@link ReorderPlan.rank} is a provisional local value for
 * the optimistic row and is never sent — the same arrangement `pendingListItem.ts` records for
 * an appended create, using the same `lexoRankBetween` the server runs, and replaced wholesale
 * by the rank the server allocates under its own `rankVersion`.
 */

/** The list fields a reorder may read. Narrowed to one, because one is all it needs. */
export type ReorderList = Pick<RowList, 'itemStateMode'>;

/** What one drag asks for. */
export interface ReorderPlan {
  readonly itemId: string;
  /**
   * The id of the item now immediately above, or `null` for the head.
   *
   * **Never absent.** §P3-30's prose says "absent for the head", but `patchListItemInput` says
   * the opposite in as many words — "`null` moves the item to the front… **absent means no
   * reorder at all**, which is why it is nullable rather than merely optional" — and
   * `listItems.int.test.ts` proves it end to end by sending `null` to move a row to the top.
   * `api-contract.md` §2.7 outranks a phase doc on mechanics (playbook §2), and it is also the
   * only reading under which a drag to the head does anything. Raised in this PR.
   *
   * A plan always requests a reorder, so this is always present. There is no third state.
   */
  readonly afterItemId: string | null;
  /**
   * A provisional rank for the optimistic row. **Display only, never sent.**
   *
   * Absent when the gap cannot be split — two neighbours sharing a rank, or a gap already
   * subdivided to the cap. Both are the repository's to repair, and neither stops the request:
   * the row simply stays where it was until the server answers with the rank it allocated.
   */
  readonly rank?: string;
}

/** The insertion indices a drag may land on, both ends inclusive. */
export interface ReorderRange {
  readonly first: number;
  readonly last: number;
}

/**
 * The authoritative order, from the one comparator.
 *
 * Callers pass their projection through this rather than trusting arrival order: a page
 * boundary is an artefact of paging, and a client that ordered by arrival would disagree with
 * one that had the same list in full.
 */
export function orderedItems<T extends { rank: string; itemId: string }>(
  items: readonly T[],
): readonly T[] {
  return [...items].sort(compareListItems);
}

/**
 * Which insertion indices this drag may land on.
 *
 * A flat list uses the whole range. Grouped stages restrict the range to the dragged item's
 * own intrinsic state group. Dragging across a heading would change state by gesture, which
 * no spec grants: state changes are explicit item actions. Clamping here keeps pointer,
 * keyboard and native drag behavior identical.
 */
export function reorderRange(
  list: ReorderList,
  items: readonly ListItemView[],
  itemId: string,
): ReorderRange | undefined {
  const sorted = orderedItems(items);
  const dragged = sorted.find((candidate) => candidate.itemId === itemId);
  if (dragged === undefined) return undefined;
  const from = sorted.indexOf(dragged);
  const remaining = sorted.filter((candidate) => candidate.itemId !== itemId);
  if (list.itemStateMode.mode !== 'stages' || !list.itemStateMode.groupByState)
    return { first: 0, last: remaining.length };

  const positions = remaining.flatMap((candidate, at) =>
    candidate.state === dragged.state ? [at] : [],
  );
  const head = positions[0];
  const tail = positions.at(-1);
  // A group of one: the only position it may occupy is the one it is already in.
  if (head === undefined || tail === undefined) return { first: from, last: from };
  /*
   * Widened to include the row's own index, always. Staying put is a position every drag may
   * reach — it is what a cancelled drag *is* — and a range that excluded it would stop the
   * finger from putting a row back where it came from.
   */
  return { first: Math.min(head, from), last: Math.max(tail + 1, from) };
}

/**
 * The plan for dropping `itemId` at `toIndex`, or `undefined` for a drop that writes nothing.
 *
 * `toIndex` is an insertion index **in the array with the dragged row removed**, which is what
 * makes the no-op check exact: putting the row back at its own index is the position it came
 * from, and §P3-30 says a drop back where it started issues no write.
 *
 * `undefined` also covers an unknown item and, in grouped stages, a target outside the item's
 * state group — {@link reorderRange}'s refusal, applied.
 */
export function planReorder(
  list: ReorderList,
  items: readonly ListItemView[],
  itemId: string,
  toIndex: number,
): ReorderPlan | undefined {
  const sorted = orderedItems(items);
  const from = sorted.findIndex((candidate) => candidate.itemId === itemId);
  if (from < 0) return undefined;
  const range = reorderRange(list, sorted, itemId);
  if (range === undefined || toIndex < range.first || toIndex > range.last) {
    return undefined;
  }
  if (toIndex === from) return undefined;

  const remaining = sorted.filter((candidate) => candidate.itemId !== itemId);
  const above = remaining[toIndex - 1];
  const below = remaining[toIndex];
  const rank = provisionalRank(above?.rank, below?.rank);
  return {
    itemId,
    afterItemId: above?.itemId ?? null,
    ...(rank === undefined ? {} : { rank }),
  };
}

/**
 * The local rank the optimistic row takes, or `undefined` when the gap has no room.
 *
 * The throw is expected rather than exceptional: `lexoRankBetween` refuses equal bounds by
 * design, and equal adjacent ranks are precisely the restored-or-legacy case `(rank, itemId)`
 * is defensive for. Repair is the repository's (P3-03/P3-04), so the client's answer is to
 * show no optimistic move and let the server's allocation land.
 */
function provisionalRank(above?: string, below?: string): string | undefined {
  try {
    return lexoRankBetween(above ?? null, below ?? null);
  } catch (error) {
    // The module's two typed errors only. Anything else is a real fault and stays one.
    if (error instanceof LexoRankError || error instanceof LexoRankOverflowError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The insertion index a finger has dragged to, from the row heights it passed over.
 *
 * Heights rather than a constant: a list row is one line or four — a title, a note, a place and
 * a state line — so a fixed row height would put the drop in the wrong gap on any list with
 * mixed rows. `heights` is in the same order as the sorted items.
 *
 * The rule is the dragged row's **centre**: the insertion index is the number of remaining rows
 * whose own centre sits above it. That reads the same going up and going down, which a
 * top-edge or leading-edge rule does not.
 */
export function dropIndex(
  heights: readonly number[],
  fromIndex: number,
  translationY: number,
): number {
  'worklet';
  let top = 0;
  for (let at = 0; at < fromIndex; at += 1) top += heights[at] ?? 0;
  const centre = top + translationY + (heights[fromIndex] ?? 0) / 2;

  /*
   * `offset` walks the **laid-out** rows, the dragged one's own slot included, because that is
   * where the other rows actually are while the finger is down. `index` counts only the rows
   * passed, which is the insertion index in the array with the dragged row removed — the two
   * frames the rest of this module works in, kept apart deliberately.
   */
  let offset = 0;
  let index = 0;
  for (let at = 0; at < heights.length; at += 1) {
    const height = heights[at] ?? 0;
    if (at !== fromIndex) {
      if (offset + height / 2 >= centre) break;
      index += 1;
    }
    offset += height;
  }
  return index;
}

/** The copy §P3-30 requires, verbatim, when the connection is unavailable at drop. */
export const REORDER_OFFLINE_MESSAGE = 'Reordering needs a connection.';

/** Long-press duration before a drag engages, in milliseconds. */
export const REORDER_LONG_PRESS_MS = 250;
