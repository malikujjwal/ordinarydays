import type { DefaultSlot } from '@od/shared/types';

/**
 * The words the add-to flows say (P3-43, `plans-and-lists.md` §5.8, §7.3, §8.1, §9.2).
 * Pure, so the buttons that name a write are testable as strings.
 *
 * Every commit button names **the exact write and its destination** (`CLAUDE.md` rule 2):
 * a count and a list, or a title and a list — never `Save` or `Add`.
 */

/** `Add 3 to Groceries` — the ingredient action once a destination is named. */
export function addSelectedLabel(count: number, listTitle: string): string {
  return `Add ${count} to ${listTitle}`;
}

/** `Add 3 selected` — the same action while the destination is still to be chosen. */
export function addSelectedPendingLabel(count: number): string {
  return `Add ${count} selected`;
}

/** The creation form's combined write (§9.2 step 4): `Save plan and add 3 items to Groceries`. */
export function savePlanAndAddItemsLabel(count: number, listTitle: string): string {
  return `Save plan and add ${count} ${count === 1 ? 'item' : 'items'} to ${listTitle}`;
}

/** The Watch form's combined write (§8.1): `Save plan and add Severance to Watch Later`. */
export function savePlanAndAddTitleLabel(title: string, listTitle: string): string {
  return `Save plan and add ${title} to ${listTitle}`;
}

/** The destination row's leading copy, per slot. */
export function destinationLead(slot: DefaultSlot): string {
  switch (slot) {
    case 'groceries':
      return 'Add ingredients to:';
    case 'watch':
      return 'Also add a list item to:';
    case 'meals':
      return 'Add to:';
  }
}

/** The one-time question (§5.8), per slot. */
export function destinationQuestion(slot: DefaultSlot): string {
  switch (slot) {
    case 'groceries':
      return 'Which list should ingredients go to?';
    case 'watch':
      return 'Which list should this go to?';
    case 'meals':
      return 'Which list should this go to?';
  }
}

export const CHOOSE_OR_CREATE = 'Choose or create a list';
/** The `ask` case's row, before the one-time question has been answered. */
export const CHOOSE_A_LIST = 'Choose a list';
export const REMEMBER_THIS_CHOICE = 'Remember this choice';
export const CHOOSE_ANOTHER_LIST = 'Choose another list';
export const NEW_LIST = 'New list';
/** §5.3's row for a refused ingredient action: the whole write is refused, nothing partial. */
export const INGREDIENTS_CHANGED =
  'Some of those ingredients have changed. Reopen the meal and try again.';
