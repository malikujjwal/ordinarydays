import { MAX_TITLE_LEN } from '../constants.js';

/**
 * An ingredient row rendered as a ListItem title (`plans-and-lists.md` §7.3 step 4).
 *
 * `Tortillas` with quantity `8` becomes `Tortillas (8)`. Pure, and total: every input a valid
 * meal can hold produces a valid title, which is the point of the truncation rule below.
 *
 * ## Why the name is never truncated
 *
 * Both `name` and `quantity` are bounded by `MAX_FREE_TEXT_LEN` (120) and the title by
 * `MAX_TITLE_LEN` (200), so `120 + ' (' + 120 + ')'` is 245 — a perfectly valid meal whose
 * perfectly valid ingredient cannot be spelled as a title. Something has to give, and it is
 * the quantity: the name is what the user reads in a shop aisle, and a `Tortillas` truncated
 * to `Tortil…` is a worse list than one that says `(8 packs of the small so…)`.
 *
 * So the name is preserved in full and only the quantity is trimmed, to whatever budget is
 * left inside the parentheses, ending in exactly one ellipsis. §P3-17 requires the 120 + 120
 * maximum to land on a deterministic `MAX_TITLE_LEN` title rather than making bulk insertion
 * fail on data the meal form accepted.
 *
 * ## What counts as "no quantity"
 *
 * Absent, empty, or whitespace only — all three render the bare name with no empty
 * parentheses trailing it. Both values are trimmed first, because a form field's value is
 * whatever the user left in it.
 */
export function formatIngredientTitle(name: string, quantity?: string): string {
  const trimmedName = name.trim();
  const trimmedQuantity = quantity?.trim() ?? '';
  if (trimmedQuantity === '') return trimmedName;

  const full = `${trimmedName} (${trimmedQuantity})`;
  if (full.length <= MAX_TITLE_LEN) return full;

  /**
   * What is left for the quantity once the name and the four fixed characters around it —
   * the space, both parentheses and the one ellipsis — are spoken for. The ellipsis is a
   * single `…`, not three dots, so this arithmetic is the same in code units as on screen.
   */
  const SURROUNDING = ' ()'.length + '…'.length;
  const budget = MAX_TITLE_LEN - trimmedName.length - SURROUNDING;

  /**
   * A name long enough to leave no room is not truncated to make space. It is returned
   * alone, without an empty `(…)` that would say only that something was lost. With
   * `MAX_FREE_TEXT_LEN` at 120 and `MAX_TITLE_LEN` at 200 this is unreachable, and it is
   * written anyway: this function must be total for whatever those two constants become.
   */
  if (budget <= 0) return trimmedName;

  return `${trimmedName} (${trimmedQuantity.slice(0, budget)}…)`;
}
