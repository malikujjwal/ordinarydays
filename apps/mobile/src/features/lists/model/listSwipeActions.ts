import type { List } from '@od/shared/types';

/**
 * The swipe actions a Lists surface offers (`interaction-contract.md` §3.2).
 *
 * | Row | Swipe left |
 * | --- | --- |
 * | List you own | `Archive` · `Delete` |
 * | List you are a member of | `Leave` |
 *
 * There is **no swipe right and no long press**. The index is not reorderable: `ListIndex`
 * stores `role` and `addedAt` only (ADR-042), so there is no rank a drag could write to, and
 * §3.2 says so in as many words. §P3-25 still describes §3.2 as offering a long-press
 * `Reorder lists`; that sentence is stale — §3.2 was corrected — and it is raised in the pull
 * request rather than built.
 *
 * ## Why `role` is a parameter and not read from the list
 *
 * §3.2 keys these on the **pointer's** `role`, and `GET /v1/lists` does not serialize it: the
 * response is the `META` row, and `listView` has no `role` field. Ownership is therefore
 * derived from `ownerId` against the signed-in user. The screen exposes the member arm only
 * when Phase 6's self-membership DELETE callback is installed; it must never route Leave to
 * the owner-only list DELETE as a fallback.
 *
 * Taking the role as an argument rather than deriving it inside is what makes Phase 6 one
 * branch instead of a rewrite: when the pointer's role is available, the caller passes it and
 * nothing here changes.
 */

export type ListRowRole = 'owner' | 'member';

export type ListSwipeActionName = 'archive' | 'delete' | 'leave' | 'mark-watched';

export interface ListSwipeAction {
  readonly name: ListSwipeActionName;
  readonly label: string;
  /** Destructive actions never commit on a full swipe; they need the §1a.1 confirmation. */
  readonly destructive: boolean;
}

const ARCHIVE: ListSwipeAction = {
  name: 'archive',
  label: 'Archive',
  destructive: false,
};
const DELETE: ListSwipeAction = { name: 'delete', label: 'Delete', destructive: true };
const LEAVE: ListSwipeAction = { name: 'leave', label: 'Leave', destructive: true };
const MARK_WATCHED: ListSwipeAction = {
  name: 'mark-watched',
  label: 'Mark watched',
  destructive: false,
};

/** The row's own role, from the viewer. Phase 6 replaces the derivation, not the callers. */
export function roleFor(list: List, viewerUserId: string | undefined): ListRowRole {
  return viewerUserId !== undefined && list.ownerId === viewerUserId ? 'owner' : 'member';
}

export function listSwipeActions(role: ListRowRole): readonly ListSwipeAction[] {
  return role === 'owner' ? [ARCHIVE, DELETE] : [LEAVE];
}

/**
 * A `watch` **item** row's left-swipe actions, in §3.2's order (§P3-31).
 *
 * `Mark watched` · `Delete`, and §3.2 gives this row the one full-swipe commit in the item
 * table: `Mark watched` is not destructive — it is §8.1's any→any status change with a
 * six-second undo — so an over-swipe may commit it, exactly as the agenda's positive action
 * does. `Delete` is destructive and never commits on a swipe.
 *
 * A watch row's other §3.2 columns are not this task's: swipe **right** is `Plan this item`
 * (P3-33), and the row body opens the item sheet (P3-29).
 */
export function watchItemSwipeActions(): readonly ListSwipeAction[] {
  return [MARK_WATCHED, DELETE];
}

/**
 * Whether a full swipe may commit this column's first action.
 *
 * The rule §3.2 already encodes and `SwipeableListCard` states in prose: a destructive first
 * action has no shortcut, because §1a.1 puts a confirmation in front of it and a card that
 * vanished on an over-swipe would be acting without a tap.
 */
export function mayCommitOnFullSwipe(actions: readonly ListSwipeAction[]): boolean {
  const first = actions[0];
  return first !== undefined && !first.destructive;
}

/**
 * The same actions as `accessibilityActions` (`interaction-contract.md` §6).
 *
 * A gesture that is the only way to reach an action is an action a screen-reader user does not
 * have. The rotor exposes these under the same labels, and the row dispatches them through the
 * identical handler — one definition, two ways in.
 */
export function listAccessibilityActions(
  actions: readonly ListSwipeAction[],
): readonly { readonly name: string; readonly label: string }[] {
  return actions.map((action) => ({ name: action.name, label: action.label }));
}
