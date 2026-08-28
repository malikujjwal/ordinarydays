import { compareListItems } from '@od/shared/rank';
import type { ListItemRow } from '@/lib/sqlite/listItemsRepository';

/**
 * The decisions list detail makes about a **partially loaded** list (§P3-27, criterion 36).
 *
 * Pure, and separate from the screen for the reason `indexDrain.ts` is: the rule that must
 * never be got wrong here is about a page that is not the whole list, and a rule expressed
 * inside a component can only be tested by rendering one at a scroll position.
 */

export interface ItemPageProgress {
  /** META's count. **Never** derived from loaded rows. */
  readonly itemCount: number;
  readonly loadedCount: number;
  /** Whether every page has landed. A prefix that stopped draining is not a whole list. */
  readonly complete: boolean;
}

/**
 * Whether `Nothing here` may be shown.
 *
 * **Both halves, and they are not redundant.** `itemCount === 0` is the server's own answer,
 * so a list whose first page has not arrived is never called empty. `loadedCount === 0` covers
 * the other direction: an item created offline is visible before any count has caught up with
 * it, and an empty state over a row the user just typed is the worse of the two errors.
 *
 * Nothing here reads the loaded page as the whole list — that is the mistake criterion 36
 * names, and it is why the count is a parameter rather than `items.length`.
 */
export function mayShowEmptyState(progress: ItemPageProgress, settled: boolean): boolean {
  return settled && progress.itemCount === 0 && progress.loadedCount === 0;
}

/**
 * Whether a bulk action may act on what is on screen.
 *
 * `Clear checked` deletes the checked set **server-side**, so the count in its label has to be
 * the whole list's or the button lies about what it is about to do. Until every page has
 * landed it is not offered — the alternative is a menu that says `Clear checked (3)` on a list
 * with forty checked rows further down.
 */
export function mayActOnWholeList(progress: ItemPageProgress): boolean {
  return progress.complete && progress.loadedCount >= progress.itemCount;
}

/** Fetch the next page at 80 % scroll depth (`interaction-contract.md` §5.1). */
export const ITEM_SCROLL_FETCH_RATIO = 0.8;

/**
 * Merges a page into a projection by `itemId`, in authoritative order.
 *
 * Later wins on a duplicate id, because the later copy came from the newer read. The sort is
 * `compareListItems`, never arrival order: a page boundary is an artefact of paging and two
 * clients that ordered by arrival would disagree about a list they both have in full.
 */
export function mergeItemPages(
  ...pages: readonly (readonly ListItemRow[])[]
): readonly ListItemRow[] {
  const byId = new Map<string, ListItemRow>();
  for (const page of pages) {
    for (const item of page) byId.set(item.itemId, item);
  }
  return [...byId.values()].sort(compareListItems);
}

/** Checked rows among those loaded. Only meaningful once {@link mayActOnWholeList} holds. */
export function doneCount(items: readonly ListItemRow[]): number {
  return items.reduce((count, item) => count + (item.state === 'done' ? 1 : 0), 0);
}
