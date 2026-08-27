import type { ListBehaviour, ListCapabilities } from '@od/shared/types';

/**
 * What a Lists-index card says about a list, computed from the list's **own stored fields**
 * (`design-system.md` §7.2, corrected 2026-08-25).
 *
 * ## Why none of this reads the catalogue
 *
 * §7.2 originally specified the count line as "the list's own vocabulary (`7 remaining`,
 * `4 of 12 packed`) — supplied by the template's copy". No such field exists, and adding one
 * would put per-type copy back into the catalogue and make the card renderer read it again —
 * exactly what ADR-031 removed. It would also drift: template values are frozen at creation,
 * so a list made a year ago would describe itself differently from the same template today, on
 * a line that is arithmetic.
 *
 * One vocabulary, every list. A seventeenth template — or a fiftieth — renders correctly on day
 * one with no catalogue copy at all. Nothing in this module or its callers names `templateKey`.
 *
 * These are pure functions rather than inline JSX because the two-part gate below is the same
 * rule the endpoints enforce, and a rule worth stating once is worth testing once.
 */

/** The fields a card reads. A structural subset, so a test fixture need not be a whole `List`. */
export interface ListCardSource {
  readonly behaviour: ListBehaviour;
  readonly capabilities: ListCapabilities;
  readonly itemCount: number;
  readonly uncheckedCount: number;
}

/**
 * **`behaviour === 'collection' && capabilities.checkable`** — both halves, exactly as the
 * endpoints check it.
 *
 * A `watch` list can carry a stored `checkable: true` that a behaviour change left behind,
 * along with `checked` values the change retained. Reading only the capability would draw a
 * checked count for rows the list detail draws no checkbox for, from state the user cannot
 * reach — a number describing something invisible.
 */
export function showsCheckedCount(list: ListCardSource): boolean {
  return list.behaviour === 'collection' && list.capabilities.checkable;
}

/**
 * `12 items`, or `12 items · 5 checked` on a checkable collection.
 *
 * `checked` is derived as `itemCount - uncheckedCount` rather than stored: the `META` row
 * carries the two counts the server maintains, and a third would be a third thing to keep in
 * step. Clamped at zero because the two counts converge independently under concurrent writes,
 * and a card is not the place to surface that.
 */
export function countLine(list: ListCardSource): string {
  const items = `${String(list.itemCount)} ${list.itemCount === 1 ? 'item' : 'items'}`;
  if (!showsCheckedCount(list)) return items;

  const checked = Math.max(0, list.itemCount - list.uncheckedCount);
  return `${items} · ${String(checked)} checked`;
}

/**
 * The neutral progress bar's 0–1 value, gated on the same flag as the count.
 *
 * `undefined` means no bar at all, which is what §7.2 asks for — not a bar at zero. An empty
 * checkable list gets no bar either: a full-width empty track on a list with nothing in it
 * reads as progress that has not started rather than as a list with no items.
 */
export function checkedProgress(list: ListCardSource): number | undefined {
  if (!showsCheckedCount(list) || list.itemCount <= 0) return undefined;
  const checked = Math.max(0, list.itemCount - list.uncheckedCount);
  return Math.min(1, checked / list.itemCount);
}

/**
 * The IconTile's tint, from the list's **behaviour**.
 *
 * `IconTile` takes an `ActivityTypeName`, and §7.2 asks for a "template-family tint". The
 * family a list belongs to is its behaviour — the one closed, three-valued field that says
 * what kind of thing it holds — and it is already on the row. Deriving the tint from
 * `templateKey` would be the catalogue lookup this file exists to avoid, and it would give
 * seventeen tints where the design system has five.
 */
export function behaviourTint(behaviour: ListBehaviour): 'task' | 'watch' | 'meal' {
  if (behaviour === 'watch') return 'watch';
  if (behaviour === 'meals') return 'meal';
  return 'task';
}
