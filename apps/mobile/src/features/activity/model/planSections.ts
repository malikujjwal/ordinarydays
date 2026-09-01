import type { ActivityChild, SourceListSummary } from '@od/shared/types';

/**
 * The reconciled Plan-detail section rules (P3-37, `plans-and-lists.md` §2.1, amended
 * 2026-08-25): settings always render; **sections do not exist until they hold something**;
 * a section of 1–3 rows renders in full; 4 or more shows three then `Show all n`. Pure, so
 * every row of the visibility matrix is a unit test.
 */

/** How many rows a peeking section shows before deferring to `Show all n`. */
export const PEEK_ROWS = 3;

export interface PeekedRows<T> {
  readonly shown: readonly T[];
  /** The `n` of `Show all n` — the whole collection, not the hidden remainder. */
  readonly showAllCount: number | undefined;
}

/** 1–3 in full; 4+ peeks at three. `expanded` renders everything the screen already holds. */
export function peekRows<T>(rows: readonly T[], expanded: boolean): PeekedRows<T> {
  if (expanded || rows.length <= PEEK_ROWS) {
    return { shown: rows, showAllCount: undefined };
  }
  return { shown: rows.slice(0, PEEK_ROWS), showAllCount: rows.length };
}

/** `2 of 5` — the PREP header's ratio, exact because the collection is model-capped. */
export function prepProgress(children: readonly ActivityChild[]): string {
  const done = children.filter((child) => child.status === 'completed').length;
  return `${done} of ${children.length}`;
}

/** `8 items · 3 checked` — the LISTS row's drillable counts (P3-25's one vocabulary). */
export function sourceListLine(summary: SourceListSummary): string {
  const items = `${summary.itemCount} ${summary.itemCount === 1 ? 'item' : 'items'}`;
  return summary.doneCount > 0 ? `${items} · ${summary.doneCount} checked` : items;
}

/** Which named chips the `Add to this plan` row offers: the empty sections with an entry. */
export interface AddToPlanChips {
  readonly prepTask: boolean;
  readonly list: boolean;
  readonly update: boolean;
}

/**
 * A chip exists when its section is empty **and** its flow is wired (the callback exists).
 * A populated section carries its own add affordance instead, so the chip row never
 * duplicates an entry the section already offers.
 */
export function addToPlanChips(input: {
  readonly children: readonly ActivityChild[];
  readonly sourceLists: readonly SourceListSummary[];
  readonly updatesVisible: boolean;
  readonly wired: { prepTask: boolean; list: boolean; update: boolean };
}): AddToPlanChips {
  return {
    prepTask: input.wired.prepTask && input.children.length === 0,
    list: input.wired.list && input.sourceLists.length === 0,
    update: input.wired.update && input.updatesVisible,
  };
}

/**
 * `today` / `yesterday` / `3 days ago` — the update row's relative stamp, computed from the
 * injected `today` so the component never reads a clock (`coding-standards.md` §4.3).
 */
export function relativeUpdateTime(createdAt: string, today: string): string {
  const createdDate = createdAt.slice(0, 10);
  if (createdDate >= today) return 'today';
  const created = Date.parse(`${createdDate}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  const days = Math.max(1, Math.round((now - created) / 86_400_000));
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/**
 * §2.2's Updates visibility: hidden when the plan is private **and** there are no entries.
 * On a private plan the section first appears once a system entry exists; only then does it
 * offer the composer (P3-40 owns the composer itself).
 */
export function updatesSectionVisible(
  visibility: 'private' | 'shared',
  updateCount: number,
): boolean {
  return visibility !== 'private' || updateCount > 0;
}
