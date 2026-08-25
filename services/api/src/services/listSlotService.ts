import type { DefaultSlot, List } from '@od/shared/types';

/**
 * The API-side home of the `defaultLists` invariants (`phase-03` §P3-12, ADR-033).
 *
 * Two write paths clear a `defaultLists` entry — deleting a list (P3-05) and changing or
 * clearing its slot (P3-09) — and until now each decided for itself which entry that was.
 * The two copies agreed, which is the only reason nothing had gone wrong yet. §P3-12's rule
 * is that exactly one implementation exists, so the decision moves here and both paths ask
 * it. Slot resolution, the other half of this module, arrives with the rest of P3-12.
 *
 * ## Where the transaction item lives, and why it is not here
 *
 * The forward invariant — clear `defaultLists[slot]` when, and only while, it still points at
 * the list being deleted (P3-05) or re-slotted (P3-09) — is one conditional transaction item,
 * `removeDefaultListTransactItem`. That item builds a DynamoDB update over the profile key,
 * so it belongs to the repository layer (`CLAUDE.md`, `repo-structure.md` §3.1), and both of
 * its callers are inside `listRepository`, which may not import a service
 * (`layers-are-one-way` in `.dependency-cruiser.cjs`). Moving it here would require hoisting
 * both list transactions out of the repository — a change to P3-05's and P3-09's shipped
 * write paths that P3-12 has no mandate for. So it stays one implementation, named from here;
 * what this module owns is the **decision** that reaches it, below.
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
 * A stale pointer is not fatal — P3-12's read-side guard treats one as unset and asks — but
 * it is the
 * difference between the user being asked once and the ingredients flow having a destination
 * it cannot explain, so both write paths clear eagerly and the read guards anyway.
 */
export function profileDefaultToClear(
  list: Pick<List, 'slot'>,
): { readonly slot: DefaultSlot } | undefined {
  return list.slot === null ? undefined : { slot: list.slot };
}
