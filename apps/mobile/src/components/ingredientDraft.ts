import { newLocalId } from '@/lib/localIds';

export interface DraftIngredient {
  /**
   * The row's `ing_` identity — stable for its lifetime, so React keys it by identity rather
   * than by position **and** the server can name the same row after a reorder.
   *
   * It was a local `row-N` counter until P3-17, described here as "never sent — the server
   * has no notion of an ingredient id". It is now sent, and is the same value the meal
   * stores: `data-model.md` §8's client-minted embedded-row identity. A row loaded from an
   * existing meal keeps the id it already has; only a genuinely new row mints one.
   */
  id: string;
  name: string;
  quantity: string;
  /** Unchecked by default (`activities.md` §4.2): the user picks what to copy, if anything. */
  selected: boolean;
}

/**
 * A new ingredient row, with a freshly minted `ing_` id.
 *
 * This used to be a counter, on the reasoning that the id never left the draft and reaching
 * for `expo-crypto` would put a native module behind a plus button. P3-17 makes the id part
 * of the stored meal, so it has to be a real ULID from the device's CSPRNG — the same
 * generator the reminder ids already use. It is still one call per tap of `+`.
 *
 * **Only a new row calls this.** Editing or reordering keeps the id it has, and
 * `fromActivityDetails` carries the stored id back in rather than re-minting, because
 * re-minting on open would make every id stale the moment a meal was edited.
 */
export function newIngredient(): DraftIngredient {
  return { id: newLocalId('ing'), name: '', quantity: '', selected: false };
}
