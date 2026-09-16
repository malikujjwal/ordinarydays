import type { List, ListTemplate } from '../types/list.js';

/**
 * Whether a list can receive the ordinary rows created by the meal-ingredients flow.
 *
 * This predicate is shared by the client picker and the API guard deliberately: the client
 * must never offer a destination that the server will refuse. Slots only route a write and
 * do not enable it. Checkbox state is required because ingredient deduplication distinguishes
 * unchecked rows (extend them) from checked rows (create a fresh row).
 *
 * The structural input lets the same rule classify stored Lists and creation templates.
 */
export function canReceiveIngredients(
  list: Pick<List | ListTemplate, 'itemStateMode'>,
): boolean {
  return list.itemStateMode.mode === 'checkbox';
}
