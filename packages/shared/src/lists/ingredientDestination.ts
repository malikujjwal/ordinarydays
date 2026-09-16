import type { List, ListCapabilities, ListTemplate } from '../types/list.js';

/**
 * What a list is structurally able to be a destination for, derived from the fields already
 * stored on it — never a second, independently-maintained flag.
 *
 * This is the **one** copy of every destination-capability rule (`docs/reports/
 * destination-flow-simplification-20260916.md`): the API guard that refuses a write, the API
 * response field a client reads instead of re-deriving the rule, the native list projection,
 * the optimistic pending-create row, and the creation catalogue all call this function rather
 * than inspecting `itemStateMode`/`featureConfig` themselves. A second implementation is
 * exactly how the offer (what the client shows) and the refuse (what the server enforces)
 * drifted apart once already — a picker could offer a list the API then refused.
 *
 * `ingredients` requires checkbox state because ingredient deduplication distinguishes
 * unchecked rows (extend them) from checked rows (create a fresh row); a list with no item
 * state, or with named stages, has no such distinction to make.
 *
 * The structural input lets the same rule classify stored Lists and creation templates —
 * a template has never been written, so there is nothing to read a capability off except the
 * same shape a stored List already carries.
 */
export function listCapabilities(
  list: Pick<List | ListTemplate, 'itemStateMode'>,
): ListCapabilities {
  return { ingredients: list.itemStateMode.mode === 'checkbox' };
}

/**
 * Whether a list can receive the ordinary rows created by the meal-ingredients flow.
 *
 * A thin delegation to {@link listCapabilities} so every existing call site — the API guard
 * and the client's capability routing — keeps compiling unchanged while capability itself
 * moves to the one shared derivation.
 */
export function canReceiveIngredients(
  list: Pick<List | ListTemplate, 'itemStateMode'>,
): boolean {
  return listCapabilities(list).ingredients;
}
