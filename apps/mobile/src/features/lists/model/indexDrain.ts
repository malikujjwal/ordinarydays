/**
 * The Lists index's **auto-drain** rule (`plans-and-lists.md` §5.6, §P3-25).
 *
 * ## The bug this exists to prevent
 *
 * `GET /v1/lists` pages **access pointers**, and the endpoint does not filter by `archived`.
 * The visible list is a client-side filter over those pages. So a page can contribute **zero
 * visible rows and still have a cursor** — fifty archived pointers on page one, active lists on
 * page two. A screen that stopped at "the page came back" would show `No lists yet` over a
 * cursor it never followed, and a screen that stopped at "the page was empty" would do the same
 * thing for the same reason.
 *
 * **Filtering is not pagination completion.** `No lists yet` is legal only once the cursor is
 * exhausted. That is the whole rule, and it is stated as a pure function so it can be tested
 * without a screen, a network or a scroll position.
 *
 * ## Why the caller schedules rather than loops
 *
 * §P3-25 requires that synchronous work per render cycle is bounded and further pages are
 * scheduled asynchronously, so a long run of filtered rows cannot monopolise rendering. This
 * module decides **whether** one more page is wanted; the hook decides **when** to ask, one
 * page per cycle. A `while` loop here would be the thing the rule forbids.
 */

export interface DrainInput {
  /** Rows the active filter actually shows right now. */
  readonly visibleCount: number;
  /** Roughly how many rows fill the viewport. The drain's floor, never a page size. */
  readonly viewportRows: number;
  /** Whether the server has more pointers behind a cursor. */
  readonly hasMore: boolean;
  /** True while a page is already in flight, so a cycle cannot stack requests. */
  readonly isFetching: boolean;
}

/**
 * Whether to ask for one more page.
 *
 * Deliberately **not** "keep going until everything is loaded". The floor is the viewport: once
 * the filtered view can fill the screen the user has something to act on and the rest arrives
 * on scroll at 80 % depth, which is the ordinary pagination rule (`interaction-contract.md`
 * §5.1). Draining past that would page an entire hundred-list account on a screen showing six.
 */
export function shouldDrainMore(input: DrainInput): boolean {
  if (!input.hasMore || input.isFetching) return false;
  return input.visibleCount < input.viewportRows;
}

/**
 * Whether the empty state may be shown.
 *
 * The negative half of the same rule, and the one worth naming separately: an empty **filtered**
 * view is not an empty account. `No lists yet` requires the cursor to be exhausted **and** no
 * page still in flight — otherwise the screen flashes an empty state between pages, which reads
 * as "you have nothing" for as long as the request takes.
 */
export function mayShowEmptyState(input: {
  readonly visibleCount: number;
  readonly hasMore: boolean;
  readonly isFetching: boolean;
  readonly hasLoadedOnce: boolean;
}): boolean {
  return (
    input.hasLoadedOnce && input.visibleCount === 0 && !input.hasMore && !input.isFetching
  );
}

/**
 * Rows the active filter shows, given what has been materialized.
 *
 * `Show archived` is a **client-side filter over the same data** — never a second endpoint —
 * so switching it reuses every page already loaded and only then continues the same bounded
 * drain. Archived rows are a separate de-emphasised group rather than a mix, so the two are
 * returned apart rather than as one flagged array.
 */
export function partitionByArchived<T extends { readonly archived: boolean }>(
  rows: readonly T[],
): { readonly active: readonly T[]; readonly archived: readonly T[] } {
  const active: T[] = [];
  const archived: T[] = [];
  // One pass, and order preserved within each group: the index renders in **server pointer
  // order** and never re-sorts (ADR-042 — `ListIndex` stores no rank, so there is nothing a
  // client sort could be faithful to).
  for (const row of rows) (row.archived ? archived : active).push(row);
  return { active, archived };
}
