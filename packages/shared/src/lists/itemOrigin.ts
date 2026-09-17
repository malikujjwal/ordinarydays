import type { ItemOrigin, ListItem } from '../types/list.js';

/**
 * Whether a list item answers for a specific Activity ingredient (Option B, 2026-09-16;
 * `docs/reports/destination-flow-simplification-20260916.md`).
 *
 * A meal's `Added` state used to be a marker stored on the **meal** (`addedToListId`), and
 * nothing ever invalidated it: delete the item, change the destination, or delete the whole
 * list, and the meal still claimed it was `Added`. This is the one rule that replaces it —
 * `Added` is now presence, derived from whether the **destination list's own item** still
 * originates from this meal's ingredient, which self-corrects the moment the item does not.
 *
 * `origins` (`@od/shared/types`) is the flattened, label-free projection of
 * `ListItem.sourceProvenance` a client actually needs: which `(activityId, ingredientId)`
 * pairs a row answers for, without exposing the rendered labels `sourceProvenance` also
 * carries. The server derives it once, in the same response mapper every `ListItem` goes
 * through (`toListItem`); a client never re-derives it from raw provenance, and never will —
 * `sourceProvenance` is omitted from `ListItemView`.
 */
export type { ItemOrigin };

/** The subset of `sourceProvenance` this module reads — never the rendered `label`. */
interface ProvenanceSegment {
  readonly activityId: string;
  readonly ingredientIds?: readonly string[];
}

/**
 * Flattens stored `sourceProvenance` segments into the wire-facing `origins` shape.
 *
 * The **only** call site is the server's `ListItem` → response mapper (`toListItem`). A
 * segment written before Option B (2026-09-16) has no `ingredientIds` and contributes
 * nothing — absence is not a guess, so a legacy row never claims presence for an ingredient
 * it cannot name.
 */
export function originsFromProvenance(
  provenance: readonly ProvenanceSegment[] | undefined,
): ItemOrigin[] {
  return (provenance ?? []).flatMap((segment) =>
    (segment.ingredientIds ?? []).map((ingredientId) => ({
      activityId: segment.activityId,
      ingredientId,
    })),
  );
}

/**
 * The one predicate for "does this item answer for this meal's ingredient?" — the completion
 * follow-up's remaining count and the client's presence hook both call this rather than
 * re-deriving it, so a second copy cannot drift from what `origins` actually means.
 */
export function itemOriginatesFrom(
  item: Pick<ListItem, 'origins'>,
  activityId: string,
  ingredientId: string,
): boolean {
  return (item.origins ?? []).some(
    (origin) => origin.activityId === activityId && origin.ingredientId === ingredientId,
  );
}
