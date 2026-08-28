import type { ListItemView } from '@od/shared/types';

/**
 * The optimistic tick, and the two rules that make it survive a shop with bad signal
 * ([`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §5.11.5, §P3-29).
 *
 * ## A set, never a toggle
 *
 * The row sends `checked: next` — the displayed value, flipped once, at the tap — and nothing
 * downstream ever computes `!checked` from a re-read. §5.11.5's first row is why: two people
 * ticking `Milk` at the same moment, one of them offline, must end with it checked **once**,
 * with no flicker and no un-tick when the queue drains. A set is idempotent under replay; a
 * toggle applied twice is a bug that only appears with two people in it.
 *
 * That rule is enforced at the call site by the shape of the callback, which takes the next
 * value. This module holds the second one.
 *
 * ## The override lives until truth agrees
 *
 * Web has no local projection to write into, so the tick has to be held here between the tap
 * and the refreshed response — and dropping it the moment the request resolves would show the
 * old value again for as long as the re-read takes. So an override is retired only when the
 * projection **carries the same value**, or when the write is refused.
 *
 * Native writes to SQLite first and its subscription re-reads within a frame, so the override
 * is retired almost immediately there. One rule, and the platform decides how long it holds.
 */

export type CheckedOverrides = ReadonlyMap<string, boolean>;

export const NO_OVERRIDES: CheckedOverrides = new Map();

/** What the row draws: the pending tick if there is one, otherwise committed truth. */
export function isChecked(item: ListItemView, overrides: CheckedOverrides): boolean {
  return overrides.get(item.itemId) ?? item.checked;
}

/** Records the tap. */
export function withOverride(
  overrides: CheckedOverrides,
  itemId: string,
  checked: boolean,
): CheckedOverrides {
  return new Map(overrides).set(itemId, checked);
}

/** Retires one override — a refused write, or a row that has left the list. */
export function withoutOverride(
  overrides: CheckedOverrides,
  itemId: string,
): CheckedOverrides {
  if (!overrides.has(itemId)) return overrides;
  const next = new Map(overrides);
  next.delete(itemId);
  return next;
}

/**
 * Retires every override the projection has caught up with.
 *
 * Returns the **same** map when nothing changed, so a caller can set it into state on every
 * projection change without causing a render loop.
 */
export function settleOverrides(
  overrides: CheckedOverrides,
  items: readonly ListItemView[],
): CheckedOverrides {
  if (overrides.size === 0) return overrides;
  const next = new Map(overrides);
  for (const item of items) {
    if (next.get(item.itemId) === item.checked) next.delete(item.itemId);
  }
  return next.size === overrides.size ? overrides : next;
}
