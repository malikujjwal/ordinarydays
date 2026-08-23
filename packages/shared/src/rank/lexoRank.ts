import { MAX_LEXO_RANK_LENGTH } from '../constants.js';
import type { Brand } from '../time/types.js';

/**
 * Fractional indexing for list items (`coding-standards.md` §9, `data-model.md` §3.3).
 *
 * Reordering must be a single-item write, never a renumber of the list. A rank is a string
 * over base62 in **ASCII collation order** — `0-9` < `A-Z` < `a-z` — which is also DynamoDB's
 * byte order for the `ITEM#<rank>#<itemId>` sort key, so the sort the database performs and
 * the sort this code performs are the same sort. Nothing here uses `localeCompare` or
 * `Intl.Collator`, and nothing ever may: the order has to be identical on Hermes, Node and in
 * a browser, and equal to what a `Query` returns.
 *
 * Pure. No I/O, no clock, no randomness, no locale. The same inputs always give the same
 * rank, which is what lets a conflicting caller (P3-04's `rankVersion` retry) re-read its
 * neighbours and obtain a *different* rank from the fresh gap rather than the same stale one.
 *
 * This module **never repairs**. Overflow and equal neighbours are thrown as typed errors so
 * the repository can run the bounded list-rank repair and retry; the normal drag path has no
 * permission to renumber a list.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RADIX = ALPHABET.length; // 62
const BASE62 = /^[0-9A-Za-z]*$/;

export type LexoRank = Brand<string, 'LexoRank'>;

/** A caller bug: bounds that are not strictly ordered, or a rank that is not base62. */
export class LexoRankError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LexoRankError';
  }
}

/**
 * The gap between the neighbours has been subdivided so often that a strictly-between rank
 * would exceed {@link MAX_LEXO_RANK_LENGTH}. Distinct from {@link LexoRankError} on purpose:
 * this is not a caller bug, it is the signal for P3-04/P3-08 to run `repairListRanks`,
 * re-read the neighbours and retry.
 */
export class LexoRankOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LexoRankOverflowError';
  }
}

/**
 * Returns a rank strictly between `prev` and `next`.
 *
 * A missing bound — `null`, `undefined` or an omitted argument — means "no neighbour on
 * that side": `lexoRankBetween()` for the first item, `lexoRankBetween(last)` to append,
 * `lexoRankBetween(null, first)` to prepend (`coding-standards.md` §9).
 *
 * Two strategies, chosen by whether the gap is bounded on both sides:
 *
 * - **Two neighbours — midpoint subdivision.** Walk both strings one character at a time. At
 *   the first position where the two characters are more than one apart, emit their midpoint
 *   and stop. Where they are adjacent, prefer copying `prev`'s character and descending a
 *   place; if that branch cannot fit inside the cap, diverge upward instead — take `next`'s
 *   character alone, which is a rank whenever `next` continues past it. Each insert halves a bounded gap, so
 *   one character buys about six inserts; repeated insertion into *one* bounded gap reaches
 *   the cap after a few hundred inserts, which is what the overflow error is for.
 * - **An open end — step by one.** Appending increments `prev`'s last character (`'V'` →
 *   `'W'`); once it is `'z'`, a `'1'` is appended (`'z'` → `'z1'`). Prepending decrements
 *   `next`'s last character (`'V'` → `'U'`); once it is `'1'`, that character becomes `'0'`
 *   and a `'z'` is appended (`'1'` → `'0z'`). One character buys about 61 inserts, so a list
 *   built by sequential appends (or prepends) stays far under the cap through the 500-item
 *   list limit and never triggers repair. At the cap the step carries (or borrows) into an
 *   earlier position instead — `'A' + 'z' × 63` is followed by `'B'`. No neighbours at all
 *   gives the midpoint `'V'`, leaving equal room on both sides.
 *
 * Overflow is thrown **only when no valid rank of at most `MAX_LEXO_RANK_LENGTH` characters
 * exists** between the bounds — never merely because the first strategy tried ran out of
 * room.
 *
 * The emitted final character always has an index >= 1, so **no rank ever ends in `'0'`**.
 * That invariant is what makes padding a short `prev` with `'0'` safe: if `'V0'` could be a
 * rank, then `lexoRankBetween('V', 'V0')` would have no answer — which is why a supplied
 * bound ending in `'0'` is rejected rather than trusted.
 *
 * @throws {LexoRankError} when a supplied bound is not a well-formed rank — a character
 *   outside base62, an explicit empty string, or a terminal `'0'` — or when both bounds are
 *   present and `prev >= next`, including `lexoRankBetween(a, a)`, which is a programming
 *   error and never a rank (§P3-03: repair and re-read instead of calling this with equal
 *   bounds).
 * @throws {LexoRankOverflowError} when no rank of at most `MAX_LEXO_RANK_LENGTH` characters
 *   fits between the bounds.
 */
export function lexoRankBetween(prev?: string | null, next?: string | null): LexoRank {
  const lower = prev ?? null;
  const upper = next ?? null;
  // Validated up front, not lazily inside the walk as §9's original sketch did: the walk
  // stops at the first position with room, so a lazy check never sees a bad character past
  // that point. A rank is storage data the repository hands back; if one is corrupt, this is
  // where that must surface.
  if (lower !== null) assertWellFormed(lower, 'prev');
  if (upper !== null) assertWellFormed(upper, 'next');
  if (lower !== null && upper !== null && lower >= upper) {
    throw new LexoRankError(
      `lexoRankBetween: prev must sort before next (${lower} >= ${upper})`,
    );
  }

  const out =
    lower !== null && upper === null
      ? stepAfter(lower)
      : lower === null && upper !== null
        ? stepBefore(upper)
        : between(lower ?? '', upper, MAX_LEXO_RANK_LENGTH);
  if (out === null) {
    throw new LexoRankOverflowError(
      `lexoRankBetween: no rank between ${lower ?? ''} and ${upper ?? ''} fits in ${MAX_LEXO_RANK_LENGTH} characters`,
    );
  }
  return out as LexoRank;
}

function assertWellFormed(rank: string, side: 'prev' | 'next'): void {
  if (rank === '') throw new LexoRankError(`lexoRankBetween: ${side} is an empty string`);
  if (!BASE62.test(rank)) {
    throw new LexoRankError(
      `lexoRankBetween: ${side} has an invalid character (${rank})`,
    );
  }
  if (rank.endsWith('0')) {
    throw new LexoRankError(
      `lexoRankBetween: ${side} ends in '0', which no rank may (${rank})`,
    );
  }
}

const index = (s: string, i: number): number => ALPHABET.indexOf(s.charAt(i));

/**
 * The shortest rank strictly above `lower` (`''` = no lower bound) and strictly below `upper`
 * (`null` = no upper bound) that fits in `budget` characters, or `null` if none exists.
 *
 * At each position the two bound characters are either far apart (emit the midpoint), equal
 * (copy and continue with both remainders) or adjacent. Adjacent is the only fork: the rank
 * may take `lower`'s character and then exceed `lower`'s remainder with nothing above it
 * (§9's "copy and descend", preferred because it stays dense next to `prev`), or it may take
 * `upper`'s character — and then that character alone is already a valid rank whenever
 * `upper` continues past it. Every rank between the bounds begins one of those ways, so a
 * `null` here really means none fits.
 */
function between(lower: string, upper: string | null, budget: number): string | null {
  if (budget === 0) return null;
  const la = lower === '' ? 0 : index(lower, 0);
  const hb = upper === null ? RADIX : index(upper, 0);
  const restA = lower.slice(1);
  const restB = upper === null ? null : upper.slice(1);

  if (hb - la > 1) return ALPHABET.charAt(la + ((hb - la) >> 1));
  if (hb === la) {
    // Equal, so `upper` is longer than this prefix (the bounds are strictly ordered) and
    // both remainders still bind.
    const tail = between(restA, restB, budget - 1);
    return tail === null ? null : ALPHABET.charAt(la) + tail;
  }
  // Adjacent. First: copy `lower`'s character and descend with no upper bound.
  const descend = between(restA, null, budget - 1);
  if (descend !== null) return ALPHABET.charAt(la) + descend;
  // Then: diverge upward to `upper`'s character alone. It is above `lower` (a larger
  // character), below `upper` exactly when `upper` continues past it, and never `'0'`
  // (it is `la + 1`). Anything under `upper`'s remainder would be longer, so this is the
  // only candidate worth having.
  return restB === null || restB === '' ? null : ALPHABET.charAt(hb);
}

/**
 * Append: the smallest step up from `prev`. `'V'` → `'W'`; `'z'` → `'z1'`. At the cap there
 * is no room to append, so carry into the nearest earlier position that can still go up —
 * `'A' + 'z' × 63` → `'B'`. Only a rank of nothing but `'z'` at the cap has no successor.
 */
function stepAfter(prev: string): string | null {
  const last = index(prev, prev.length - 1);
  if (last < RADIX - 1) return prev.slice(0, -1) + ALPHABET.charAt(last + 1);
  if (prev.length < MAX_LEXO_RANK_LENGTH) return prev + ALPHABET.charAt(1);
  for (let k = prev.length - 1; k >= 1; k--) {
    const c = index(prev, k - 1);
    if (c < RADIX - 1) return prev.slice(0, k - 1) + ALPHABET.charAt(c + 1);
  }
  return null;
}

/**
 * Prepend: the largest step down from `next`. `'V'` → `'U'`; `'1'` → `'0z'`. At the cap there
 * is no room for the `'0z'` tail, so borrow from the nearest earlier position that can still
 * go down — `'B' + '0' × 62 + '1'` → `'A'`. A `'1'` at that position becomes `'0z'`, which
 * always fits because the position is short of the cap; a `'0'` cannot go lower and is
 * skipped.
 */
function stepBefore(next: string): string | null {
  const last = index(next, next.length - 1);
  // `last` is >= 1 (no rank ends in '0'), so decrementing never lands on '0' unless it was
  // '1' — and then the character becomes '0' with a 'z' behind it, the largest rank below.
  if (last > 1) return next.slice(0, -1) + ALPHABET.charAt(last - 1);
  if (next.length < MAX_LEXO_RANK_LENGTH) {
    return next.slice(0, -1) + ALPHABET.charAt(0) + ALPHABET.charAt(RADIX - 1);
  }
  for (let k = next.length - 1; k >= 1; k--) {
    const c = index(next, k - 1);
    if (c > 1) return next.slice(0, k - 1) + ALPHABET.charAt(c - 1);
    if (c === 1) {
      return next.slice(0, k - 1) + ALPHABET.charAt(0) + ALPHABET.charAt(RADIX - 1);
    }
  }
  return null;
}

/** The rank of the first item in an empty list. Stable: `'V'`. */
export const FIRST_RANK: LexoRank = lexoRankBetween();

/**
 * The `(rank, itemId)` total order every reader uses — the repository, the projection and the
 * client — so there is exactly one implementation (`data-model.md` §3.3, acceptance
 * criterion 29).
 *
 * Structural on purpose: a repository row, a response projection and a client item all carry
 * these two fields and nothing else is needed. The `itemId` tie-break is **defensive**, for
 * Undo-restored, legacy or seeded duplicate ranks within one committed generation; it is not
 * the allocation strategy, and it is not chronology — a client-minted ULID carries a device
 * clock (`data-model.md` §8). It is uniqueness and a stable tie-break, nothing more.
 *
 * Code-unit comparison only. `localeCompare` would diverge from DynamoDB's byte order and
 * between runtimes.
 */
export function compareListItems(
  a: { rank: string; itemId: string },
  b: { rank: string; itemId: string },
): -1 | 0 | 1 {
  if (a.rank < b.rank) return -1;
  if (a.rank > b.rank) return 1;
  if (a.itemId < b.itemId) return -1;
  if (a.itemId > b.itemId) return 1;
  return 0;
}
