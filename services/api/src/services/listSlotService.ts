import type { DefaultSlot, List } from '@od/shared/types';
import type { ListMetaPatch } from '../repositories/listRepository.js';

/**
 * The API-side half of the `defaultLists` invariant that is genuinely the server's
 * (`phase-03` §P3-12, ADR-033, ADR-060): a list write that changes `slot` must leave
 * `defaultLists` telling the truth about this list — clearing the slot it no longer holds,
 * and, since ADR-060 made a list's own settings the only surviving way to *change* a stored
 * default (Option B1 deleted the one-time question), setting the slot it newly holds.
 *
 * ## Both halves, and why they are one transaction
 *
 * Clearing alone was sufficient while a list's slot was only ever a *routing* fact the client
 * resolved around (pre-ADR-060): a list losing its slot could strand a pointer, but nothing
 * ever *needed* a list gaining one to also become the default, because the flat picker's own
 * `remember()` was the only thing that wrote a default, from a destination the user was
 * already choosing. ADR-060 relabelled the list-settings slot control **"Default
 * destination"** — a claim that is false unless choosing a slot here writes the default too,
 * because a picker choice made while a default already exists is deliberately one-off and
 * never changes it. Without the set half, the control could clear a default but never set
 * one, which is worse than the ceremony it replaced: at least the old `ask` state was always
 * reachable. Both halves land in the **same** `TransactWriteItems` as the list's own `slot`
 * field for the reason every other write here does: a crash or a lost race between the two
 * must not leave `slot` pointing one way and `defaultLists` pointing another.
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
 * The clearing and the setting are each one conditional transaction item —
 * `removeDefaultListTransactItem` and `setDefaultListTransactItem` — and both build a
 * DynamoDB update over the profile key, so they belong to the repository layer (`CLAUDE.md`,
 * `repo-structure.md` §3.1), and their callers are inside `listRepository`, which may not
 * import a service (`layers-are-one-way` in `.dependency-cruiser.cjs`). Moving them here
 * would require hoisting the list-write transactions out of the repository — a change to
 * P3-05's, P3-09's and ADR-060's shipped write paths that this module has no mandate for. So
 * they stay one implementation each, named from here; what this module owns is the
 * **decision** that reaches them, below.
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

/**
 * Which profile default a list write that changes `slot` must attempt to set (ADR-060) — the
 * mirror of {@link profileDefaultToClear}, read from the **new** value rather than the
 * current one.
 *
 * Unconditional on the slot's prior occupant, deliberately: the list-settings control is an
 * explicit choice ("Default destination"), the same as the flat picker's own `remember()`
 * (`PATCH /v1/me`, unconditional per slot), not a merge that needs to protect an existing
 * answer. A slot the patch does not touch, or clears to `null`, sets nothing — clearing is
 * {@link profileDefaultToClear}'s alone.
 */
export function profileDefaultToSet(
  changed: Pick<ListMetaPatch, 'slot'>,
): { readonly slot: DefaultSlot } | undefined {
  return 'slot' in changed && changed.slot !== undefined && changed.slot !== null
    ? { slot: changed.slot }
    : undefined;
}
