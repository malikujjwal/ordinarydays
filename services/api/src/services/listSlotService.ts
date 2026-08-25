import { resolveSlot, type SlotResolution } from '@od/shared/lists';
import type { DefaultSlot, List } from '@od/shared/types';
import { listListsForUser } from '../repositories/listRepository.js';
import { getProfile } from '../repositories/userRepository.js';

/**
 * The API-side home of the `defaultLists` invariants (`phase-03` §P3-12, ADR-033).
 *
 * Three flows add items to a list the user did not open first — ingredients from a meal
 * (P3-17), episodes from a watch item, and the destination sheet the client renders before
 * either (P3-42). All three ask the same question, so they ask it here, and the rule itself
 * is the one pure `resolveSlot` in `@od/shared/lists` that the app also calls. §P3-12's whole
 * point is that exactly one implementation exists: "a second copy in the ingredients path is
 * how the two drift".
 *
 * ## Resolving writes nothing
 *
 * Not the answer, not a timestamp, not a most-recently-used note — nothing. Opening a list
 * must never change where future items go, and most-recently-used is rejected outright
 * (ADR-033), so the only thing that ever writes a slot is the user answering the question,
 * through `PATCH /v1/me`. A per-operation override is a parameter to whichever add action is
 * being performed and is likewise never written back: choosing a different destination once
 * must not silently become permanent.
 *
 * ## Where the other half lives, and why it is not here
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
 * Resolves where a slot's items should go for one user.
 *
 * The lists are read in index order and handed to the pure rule unsorted, so the sheet's
 * candidates appear in the order the user already sees on the Lists tab.
 *
 * Every page is drained rather than resolving against the first 50. Eligibility is a property
 * of the whole set — "exactly one" and "several" are different answers — and a user whose
 * fifty-first list is their second grocery list would otherwise be told there is only one and
 * never asked.
 */
export async function resolveListSlot(
  userId: string,
  slot: DefaultSlot,
): Promise<SlotResolution<List>> {
  const [lists, profile] = await Promise.all([
    ownedAndSharedLists(userId),
    getProfile(userId),
  ]);

  return resolveSlot(slot, lists, profile?.defaultLists);
}

/**
 * Every list the caller can reach, owned or shared — a slot is a property of the List and a
 * default is a property of the user, so a shared grocery list the caller is a member of is as
 * eligible as one they own.
 *
 * The drain is bounded by the 100-owned-list cap (P3-05) plus the caller's memberships, and
 * it goes through the ordinary paginated read rather than a new repository surface: there is
 * no new access pattern here, only more of pattern 7.
 */
async function ownedAndSharedLists(userId: string): Promise<readonly List[]> {
  const lists: List[] = [];
  let cursor: string | undefined;

  do {
    const page = await listListsForUser(userId, cursor);
    lists.push(...page.items.map((entry) => entry.list));
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return lists;
}

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
 * A stale pointer is not fatal — `resolveSlot` treats one as unset and asks — but it is the
 * difference between the user being asked once and the ingredients flow having a destination
 * it cannot explain, so both write paths clear eagerly and the read guards anyway.
 */
export function profileDefaultToClear(
  list: Pick<List, 'slot'>,
): { readonly slot: DefaultSlot } | undefined {
  return list.slot === null ? undefined : { slot: list.slot };
}
