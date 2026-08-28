import type { ListItemView } from '@od/shared/types';
import { WATCH_STATUS_LABELS, type WatchStatus } from './listItemRow';
import { orderedItems } from './reorder';

/**
 * The one grouped item list in the product
 * ([`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §5.2, §8.1;
 * §P3-31).
 *
 * A pure projection over the flat item response, keyed on `details.watchStatus` and nothing
 * else. Pure and separate from the component for `listItemRow.ts`'s reason, and for one more
 * that is specific to this task: two of the rules here are about what is **not** rendered — an
 * empty group's heading, and a row whose status cannot be read — and an absence expressed
 * inside JSX can only be checked by rendering a tree and querying for a thing that is not
 * there.
 *
 * ## Three sections, in one fixed order, and the order is not the data's
 *
 * §5.2 gives `Watching · Want to watch · Watched`. That is a **display** order chosen by the
 * product, unrelated to the stored enum's order and unrelated to the sequence §8.1 lists the
 * transitions in. It is stated once, here, as {@link WATCH_SECTION_ORDER}.
 *
 * Within a section the order is `(rank, itemId)` through the one exported `compareListItems`
 * (via `orderedItems`) — the same comparator the flat list uses, so a restored, legacy or
 * seeded duplicate rank groups and sorts identically on two devices (acceptance criterion 29).
 *
 * ## Ranks are global; groups are not contiguous in them
 *
 * A `watch` list's ranks are allocated across the whole list, so its three groups interleave in
 * rank order. Grouping does not renumber anything and never could: a status change moves a row
 * under a different heading **at its existing rank**, which is exactly what §P3-31 requires and
 * what falls out of projecting rather than reordering. {@link groupDropIndex} is the other half
 * — it turns a drop *within* a section back into the flat position P3-30's model speaks.
 */

/** §5.2's order, stated once. Not the stored enum's order, and not §8.1's. */
export const WATCH_SECTION_ORDER = ['watching', 'want', 'watched'] as const;

export interface WatchSection {
  readonly status: WatchStatus;
  /** §5.2's own words, from the record the row's chip reads. */
  readonly heading: string;
  /** Never empty: a section with nothing in it is not returned at all. */
  readonly items: readonly ListItemView[];
}

export interface WatchProjection {
  readonly sections: readonly WatchSection[];
  /**
   * Rows whose status cannot be read, in `(rank, itemId)` order.
   *
   * A committed `watch` row with no typed `details` is invalid data — §P3-31 says the response
   * schema rejects it rather than the client silently placing it in `Want to watch`. If one
   * arrives anyway it is **kept and left unclassified**, which is P3-28's rule for the same
   * data one level down: the row draws its title and stops, and nothing invents a `want` it
   * does not have. Dropping it instead would hide a row the user owns.
   */
  readonly ungrouped: readonly ListItemView[];
}

/** The item's stored status, or `undefined` where there is none to read. */
export function watchStatusOf(item: ListItemView): WatchStatus | undefined {
  return item.details?.behaviour === 'watch' ? item.details.watchStatus : undefined;
}

/**
 * The three sections, in §5.2's order, with the empty ones **omitted**.
 *
 * > **Decision — an empty group renders no heading** (§P3-31, recorded there and raised in this
 * > PR). §5.2 fixes the order of the three sections but says nothing about rendering an empty
 * > one, and the always-render rule that does exist is the Plans tab's, which is explicitly
 * > about **stages** rather than list groups. A heading with nothing under it on a two-item
 * > watchlist would be two-thirds empty scaffolding describing a state the user is not in.
 */
export function watchSections(items: readonly ListItemView[]): WatchProjection {
  const sorted = orderedItems(items);
  return {
    sections: WATCH_SECTION_ORDER.flatMap((status) => {
      const members = sorted.filter((item) => watchStatusOf(item) === status);
      return members.length === 0
        ? []
        : [{ status, heading: WATCH_STATUS_LABELS[status], items: members }];
    }),
    ungrouped: sorted.filter((item) => watchStatusOf(item) === undefined),
  };
}

/**
 * The **flat** insertion index for a drop at `withinGroup` inside the item's own section.
 *
 * The two frames are the whole of this function. A section is its own draggable list, so a drop
 * in it arrives as a position among that group's rows; `planReorder` and the request it builds
 * speak positions in the flat `(rank, itemId)` order, because that is the order `afterItemId`
 * names a neighbour in. Landing at group position `k` means landing immediately after that
 * group's `k - 1`th member — wherever the other groups' rows happen to sit around it — and at
 * group position `0` it means taking the place its first member currently holds.
 *
 * That the resulting rank sits between two rows of a *different* status is not a problem and is
 * not visible: the section a row appears in is its `watchStatus`, never its rank.
 *
 * `undefined` when the item is not in the list, or has no status to be grouped by.
 */
export function groupDropIndex(
  items: readonly ListItemView[],
  itemId: string,
  withinGroup: number,
): number | undefined {
  const sorted = orderedItems(items);
  const dragged = sorted.find((item) => item.itemId === itemId);
  if (dragged === undefined) return undefined;
  const status = watchStatusOf(dragged);
  if (status === undefined) return undefined;

  /** Where the row already is, in the flat frame. `planReorder` reads it as the no-op it is. */
  const from = sorted.indexOf(dragged);
  const remaining = sorted.filter((item) => item.itemId !== itemId);
  const positions = remaining.flatMap((item, at) =>
    watchStatusOf(item) === status ? [at] : [],
  );
  if (withinGroup <= 0) return positions[0] ?? from;
  const above = positions[Math.min(withinGroup, positions.length) - 1];
  return above === undefined ? from : above + 1;
}
