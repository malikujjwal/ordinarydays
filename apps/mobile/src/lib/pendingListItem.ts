import { lexoRankBetween } from '@od/shared/rank';
import { type CreateListItemInput, listItemView } from '@od/shared/schemas';
import type { ListItemRow } from '@/lib/sqlite/listItemsRepository';

/**
 * The item row a native create stores before the server has seen it (P3-27, ADR-055).
 *
 * The `pendingListFromInput` shape one level down, with one thing the List create did not
 * have to answer: **where the row goes**.
 *
 * ## The rank is local, and it is the same function the server runs
 *
 * `lexoRankBetween` is P3-03's, so an appended item gets a rank after the last committed one
 * exactly as the server would allocate it, and two items typed in sequence sort in the order
 * they were typed. It is still **not authoritative**: the server allocates under its own
 * `rankVersion`, and acknowledgement replaces this row wholesale. Equal ranks between a local
 * row and a server one are expected rather than exceptional — `(rank, itemId)` is what makes
 * the order stable either way (`plans-and-lists.md` §5.11.5).
 *
 * `checked` is `false` because a create cannot set it: the field is server-derived and
 * `createListItemInput` rejects it outright.
 */
export function pendingListItemFromInput(
  input: CreateListItemInput,
  listId: string,
  itemId: string,
  rank: string,
): ListItemRow {
  /*
   * Parsed rather than assembled, for the reason `fromRow` is: this row is about to be
   * committed and then rendered, and the same schema that validates one arriving from the
   * network should validate one this device built. The assertion is the modality gap only —
   * Zod's optional output is `T | undefined` where the domain model uses property absence.
   */
  return listItemView.parse({
    itemId,
    listId,
    rank,
    title: input.title,
    state: 'open',
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.features === undefined ? {} : { features: input.features }),
  }) as ListItemRow;
}

/**
 * The rank an appended item takes, from the last row currently committed.
 *
 * Appending is the only position the inline add row can produce — §5.6's rapid entry has no
 * way to express "before that one", and `afterItemId` is absent on its request for the same
 * reason. A list with no rows yet gets the first rank.
 */
export function appendedRank(items: readonly { rank: string }[]): string {
  return lexoRankBetween(items.at(-1)?.rank);
}
