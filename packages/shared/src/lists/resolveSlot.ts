import type { DefaultSlot } from '../types/user.js';

/**
 * Where do these items go? — the four-step rule from
 * `data-model.md` §4.6 "Default slots" and ADR-033, as one pure function
 * (`phase-03` §P3-12).
 *
 * ## Why this is the only implementation
 *
 * Every "add these to X" flow asks the same question: ingredients from a meal, episodes from
 * a watch item, the destination sheet the client renders before either. §P3-12 says it in as
 * many words — "There must be exactly one implementation; a second copy in the ingredients
 * path is how the two drift". So it lives in `packages/shared`, where the API and the app
 * both reach it, rather than in whichever service happened to need it first.
 *
 * ## What it deliberately does not do
 *
 * It performs **no I/O and reads no clock**: the caller supplies the lists it already has and
 * the profile map it already read, so the same inputs always produce the same answer and a
 * test needs neither a table nor a frozen clock.
 *
 * It **writes nothing**. Steps 1 and 2 are pure reads, and step 3's answer is stored by the
 * caller through `PATCH /v1/me` after the user picks — never here, and never as a side effect
 * of resolving. Opening a list must not change where future items go, and most-recently-used
 * is rejected outright (ADR-033).
 *
 * It **chooses no template, title or style** in the empty case. The slot explains why a
 * destination is needed; it does not decide what new list to create, and returning a
 * `templateKey` from here is exactly the inference `plans-and-lists.md` §5.8 forbids.
 *
 * It **never reorders**. Candidates come back in the order the caller supplied, because the
 * caller is what knows the order the user sees — a sort here would silently disagree with
 * the list index the sheet is rendered from.
 */

/**
 * The minimum a row must expose to be considered for a slot.
 *
 * A structural constraint rather than the full `List`, so the client's index projection and
 * the server's stored row both satisfy it without either constructing the other's shape. The
 * three fields are exactly the eligibility test and nothing more.
 */
export interface SlotEligibleList {
  readonly listId: string;
  /** Eligibility for a destination. `null` is never a candidate — `Packing` is not groceries. */
  readonly slot: DefaultSlot | null;
  readonly archived: boolean;
}

/**
 * The three answers, and there is no fourth.
 *
 * Generic in the caller's own row type so `ask` hands back the rows it was given — titles,
 * icons and all — rather than a projection the sheet would have to re-join against the list
 * it already holds.
 *
 * `use` carries the destination even when nothing was asked: "the resolved destination is
 * returned to the client even in the `use` case, because the sheet has to show where the
 * items are going. Silent step 1 means 'do not ask', not 'do not tell'" (§P3-12).
 * `wasDefault` separates step 1 from step 2 — the only eligible list, versus the one the user
 * chose when there were several.
 */
export type SlotResolution<T extends SlotEligibleList = SlotEligibleList> =
  | { readonly kind: 'use'; readonly listId: string; readonly wasDefault: boolean }
  | { readonly kind: 'ask'; readonly candidates: readonly T[] }
  | { readonly kind: 'none'; readonly slot: DefaultSlot };

export function resolveSlot<T extends SlotEligibleList>(
  slot: DefaultSlot,
  lists: readonly T[],
  defaultLists: Partial<Record<DefaultSlot, string>> | undefined,
): SlotResolution<T> {
  /** Eligible: holds this slot and is not archived. Filter preserves the caller's order. */
  const candidates = lists.filter((list) => list.slot === slot && !list.archived);

  const [only] = candidates;
  /**
   * Step 4. Exactly this shape, and nothing else on it: no `templateKey`, no title, no
   * recommendation. The client may offer `New list`; deciding which one is the user's.
   */
  if (only === undefined) return { kind: 'none', slot };

  /**
   * Step 1. One eligible list is used silently — and `wasDefault` is `false` even when the
   * profile happens to name it, because no default was needed to answer. The distinction is
   * what lets the sheet tell "your only groceries list" from "the one you chose".
   */
  if (candidates.length === 1) {
    return { kind: 'use', listId: only.listId, wasDefault: false };
  }

  /**
   * Step 2, then step 3. A default is honoured only while it still names an eligible list:
   * a pointer at a list that was deleted, archived, or had its slot changed is treated as
   * unset and falls through to the question.
   *
   * This is the read-side half of a belt-and-braces pair. P3-05's delete and P3-09's slot
   * change both clear the profile entry in the same transaction as the list write, so a
   * stale pointer should not exist; if one ever does, it produces a question rather than a
   * dead end (§P3-12 edge cases).
   */
  const chosen = defaultLists?.[slot];
  return chosen !== undefined && candidates.some((list) => list.listId === chosen)
    ? { kind: 'use', listId: chosen, wasDefault: true }
    : { kind: 'ask', candidates };
}
