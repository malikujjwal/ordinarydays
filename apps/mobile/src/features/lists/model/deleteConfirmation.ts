import type { List } from '@od/shared/types';
import type { Confirmation } from '@/components/ConfirmDialog';

/**
 * What `Delete list` asks (`interaction-contract.md` §1a.1, `plans-and-lists.md` §5.6).
 *
 * §1a.1 is emphatic that a dialog reading `Are you sure?` or `This can't be undone.` alone is
 * **a defect, not a style choice**: the user cannot weigh a decision they have not been told the
 * size of. So every number here is real and comes from the row itself.
 *
 * §5.6 names the two facts a list deletion has to state: how many of the owner's linked Plans
 * **survive**, and how many other members lose the list. The first is a `Keeps:` line because
 * it is reassurance — `Plan this item` created independent Activities and deleting the list
 * does not touch them — and the second is a loss, because it happens to someone else.
 *
 * ## What this can honestly count, and what it cannot
 *
 * `itemCount` and `memberCount` are on the `META` row the index already has. The **linked-plan**
 * count is not: it lives in the per-viewer `LNK#` projections, which the index does not read and
 * `GET /v1/lists` does not serialize. Rather than invent a number or fetch a page to
 * decorate a dialog, the `Keeps:` line states the guarantee without a count when there is no
 * count to state. A wrong number here would be worse than none — §1a.1 exists so the user can
 * trust the figures.
 *
 * Named in the pull request as the one place §5.6 asks for a count this phase cannot supply.
 */

const plural = (count: number, one: string, many: string) =>
  `${String(count)} ${count === 1 ? one : many}`;

export function deleteListConfirmation(
  list: Pick<List, 'title' | 'itemCount' | 'memberCount'>,
): Confirmation {
  const items = `${plural(list.itemCount, 'List item', 'List items')} will be removed`;
  const removes = [items];

  // `memberCount` includes the owner, so "other members" is one fewer. A shared list is the
  // only case where a delete costs somebody else something, and it is the case §5.6 wants said.
  const others = Math.max(0, list.memberCount - 1);
  removes.push(
    others === 0
      ? 'No other people will lose access'
      : `${plural(others, 'other person', 'other people')} will lose access`,
  );
  const people = removes[1] ?? 'No other people will lose access';

  return {
    heading: `Delete "${list.title}"?`,
    removesLead: 'This removes:',
    removes,
    keeps: 'Linked Plans remain where they are.',
    summary: 'This cannot be undone. Linked Plans are not deleted.',
    consequences: [
      { kind: 'removed', text: items },
      { kind: 'kept', text: 'Linked Plans will remain' },
      { kind: 'access', text: people },
    ],
    // Repeats the verb. Never `OK`, never `Continue` (§1a.1 rule 1).
    confirmLabel: 'Delete list',
  };
}
