/** What the label needs to know about the plan it names. */
export interface LabelSourceMeal {
  readonly title: string;
}

/**
 * `ListItem.sourceLabel` — where a grocery item came from, in a few human words
 * (`plans-and-lists.md` §7.5, `phase-03` §P3-17).
 *
 * ## The rule
 *
 * The label is the source plan's trimmed title, always: `Chicken (8) — Chicken tacos`.
 * Amended 2026-09-11 (founder): the earlier day-based rules (`Sunday dinner`, `23 Aug
 * dinner`, and appending the title to disambiguate a repeated day label) are gone, because
 * the plan's name says more about why an item is on the list than the day it is cooked.
 *
 * ## Computed once, stored, never recomputed
 *
 * This runs at creation and its result is written onto the item. That is the whole design:
 * a label recomputed on read would silently change when the meal is renamed and become a lie
 * when the meal is deleted, and the item is supposed to record where it came from — which is
 * a fact about the past that later edits do not alter (acceptance criterion 15). Items
 * written under the earlier rules keep their stored day labels; nothing migrates them.
 * Nothing may call this with a stored item in hand.
 *
 * Two different meals with the same title produce the same words. That is fine: which meal
 * owns a segment is recorded by `activityId` in the item's `sourceProvenance`, never
 * recovered from the label text.
 */
export function provenanceLabel(meal: LabelSourceMeal): string {
  return meal.title.trim();
}
