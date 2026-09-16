import type { DefaultSlot, List } from '@od/shared/types';

/**
 * The API-side half of the `defaultLists` invariant that is genuinely the server's
 * (`phase-03` §P3-12, ADR-033): clearing a profile's default when, and only while, it still
 * points at the list being deleted (P3-05) or re-slotted (P3-09).
 *
 * ## Resolving a destination is client-only (ADR-033, ADR-058, Option B1)
 *
 * This module used to also expose `resolveListSlot`, a server-side mirror of the same
 * `resolveSlot` rule the client called, for a destination endpoint that was never built —
 * it had no caller outside its own test. `docs/reports/
 * destination-flow-simplification-20260916.md`'s Option B1 removed `resolveSlot` entirely
 * (the client now filters and preselects from its own cached list index, with no server round
 * trip to ask "where do these go?"), so the unreachable mirror was deleted with it rather than
 * updated to match a rule that no longer exists in `@od/shared`.
 *
 * ## Where the forward invariant lives, and why it is not here either
 *
 * The clearing itself — one conditional transaction item, `removeDefaultListTransactItem` —
 * builds a DynamoDB update over the profile key, so it belongs to the repository layer
 * (`CLAUDE.md`, `repo-structure.md` §3.1), and both of its callers are inside
 * `listRepository`, which may not import a service (`layers-are-one-way` in
 * `.dependency-cruiser.cjs`). Moving it there would require hoisting both list transactions
 * out of the repository — a change to P3-05's and P3-09's shipped write paths that this
 * module has no mandate for. So it stays one implementation, named from here; what this
 * module owns is the **decision** that reaches it, below.
 */

/**
 * Which profile default a write to this list must attempt to clear — the single answer that
 * P3-05's delete and P3-09's slot change both ask.
 *
 * The answer is the list's **current** slot whenever it holds one, and it is deliberately not
 * conditioned on a profile read. A read that missed a selection made concurrently on another
 * device would wrongly skip the cleanup, leaving a pointer at a list that no longer holds the
 * slot; the transaction item is conditional on that exact `(slot, listId)` pair instead, so a
 * slot naming anything else fails only that item and the newer choice survives.
 *
 * A stale pointer is not fatal — the client's destination hook treats one as unset and asks —
 * but it is the difference between the user being asked once and the ingredients flow having
 * a destination it cannot explain, so both write paths clear eagerly.
 */
export function profileDefaultToClear(
  list: Pick<List, 'slot'>,
): { readonly slot: DefaultSlot } | undefined {
  return list.slot === null ? undefined : { slot: list.slot };
}
