import type { List, ListBehaviour, ListBehaviourConfirmation } from '@od/shared/types';
import type { Confirmation } from '@/components/ConfirmDialog';
import { BEHAVIOUR_CONFIRM_LABELS } from './listSettings';

/**
 * The destructive behaviour-change dialog, composed from the server's own preview
 * ([`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §5.5,
 * [`interaction-contract.md`](../../../../../docs/01-product/interaction-contract.md) §1a.1,
 * §5.3's `409` row, §P3-32).
 *
 * ## Nothing here counts anything
 *
 * `fields` and `itemCount` arrive on the `409`'s typed `confirmation` and are used exactly as
 * they came. §P3-32 records why: "a count computed from a paginated cache would be wrong for a
 * long list, and being wrong in the sentence that precedes irreversible data loss is worse than
 * a round trip". So this module has no access to items, no branch on behaviour that guesses a
 * field list, and no fallback for a missing count — a confirmation the server did not author is
 * not one this client can show.
 *
 * The **sentence** is the client's, and only the sentence. `listMutationService.ts` says so
 * where the labels are defined: "The server sends the labels and the client composes the
 * sentence around its own list title, because the copy belongs to the surface that knows what
 * the list is called." The title is the one thing the response does not carry.
 *
 * ## The shape is §1a.1's, and the whole object is echoed back
 *
 * The dialog is `ConfirmDialog`: `Cancel` first, the verb repeated on a `danger` button, and the
 * `Keeps:` line whenever anything survives — which here is everything except the typed fields.
 * Confirming re-sends `POST /v1/lists/:id/behaviour` with the **complete** `confirmation` echoed
 * under a new stable key; this module never edits, trims or reorders it, because `itemVersion`
 * binds the user's decision to the item generation the server previewed.
 */

/** `Turn "Watchlist" into a plain list?` — the heading §5.5 mocks, per target. */
const HEADING_TAILS: Record<ListBehaviour, string> = {
  collection: 'into a plain list?',
  watch: 'into a watchlist?',
  meals: 'into a meals list?',
};

/**
 * `['Watch status', 'Season', 'Episode']` → `Watch status, season and episode`.
 *
 * The server orders the labels and capitalises each one for standalone use; running them into a
 * sentence lower-cases every label after the first, which is §5.5's rendering verbatim —
 * `Watch status, season and episode from 7 items`. Only the leading character moves, so a label
 * like `Movie or show` keeps its own internal casing.
 */
function sentenceCase(fields: readonly string[]): string {
  const spoken = fields.map((field, index) =>
    index === 0 ? field : `${field.charAt(0).toLowerCase()}${field.slice(1)}`,
  );
  const last = spoken[spoken.length - 1] ?? '';
  return spoken.length <= 1 ? last : `${spoken.slice(0, -1).join(', ')} and ${last}`;
}

const plural = (count: number, one: string, many: string) =>
  `${String(count)} ${count === 1 ? one : many}`;

export function behaviourChangeConfirmation(
  list: Pick<List, 'title'>,
  confirmation: ListBehaviourConfirmation,
): Confirmation {
  return {
    heading: `Turn "${list.title}" ${HEADING_TAILS[confirmation.toBehaviour]}`,
    removesLead: 'This will remove:',
    /*
     * One entry, so `ConfirmDialog` renders it as the sentence §5.5 mocks rather than as a
     * bulleted field list. The fields and the number inside it are the server's; the words
     * around them are this file's.
     */
    removes: [
      `${sentenceCase(confirmation.fields)} from ${plural(confirmation.itemCount, 'item', 'items')}`,
    ],
    keeps: 'every item, its title, its note, and its order.',
    confirmLabel: BEHAVIOUR_CONFIRM_LABELS[confirmation.toBehaviour],
  };
}
