import { getList } from '@od/shared/client';
import { itemOriginatesFrom } from '@od/shared/lists';
import type { ListItemView } from '@od/shared/types';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { apiClient } from '@/lib/apiClient';

/**
 * A meal ingredient's `Added` state, derived rather than stored (Option B, 2026-09-16;
 * `docs/reports/destination-flow-simplification-20260916.md`). `Added` used to be a marker
 * written once onto the meal (`addedToListId`) and never invalidated: delete the item, change
 * the destination, or delete the list, and the meal still claimed it was `Added`. This hook
 * replaces that marker with a read of the **destination list's own items** — the moment one
 * of those events happens, the next read says so, because there is no separate record of
 * "added" left to disagree with it.
 */
export interface IngredientPresenceView {
  /** Every `ingredientId` this activity has a live item for on the checked destination. */
  readonly present: ReadonlySet<string>;
  /**
   * `false` while there is no destination to check, or the read of it has not landed yet.
   * A caller must render `false` the same way it renders "not present" — never `Added` on a
   * guess, which is exactly the bug this hook exists to remove.
   */
  readonly known: boolean;
}

const UNKNOWN_PRESENCE: IngredientPresenceView = { present: new Set(), known: false };

/** One cache entry per destination list, shared by every ingredient section reading it. */
export function ingredientPresenceKey(listId: string): readonly unknown[] {
  return ['ingredient-presence', listId] as const;
}

/**
 * Every ingredient id an item on this page answers for, routed through the one shared
 * predicate (`@od/shared/lists`) rather than re-testing `origin.activityId`/`ingredientId`
 * here directly — a second copy of that comparison is exactly the drift Option B replaces.
 */
function presentIngredientIds(
  items: readonly Pick<ListItemView, 'origins'>[],
  activityId: string,
): ReadonlySet<string> {
  const present = new Set<string>();
  for (const item of items) {
    for (const origin of item.origins ?? []) {
      if (itemOriginatesFrom(item, activityId, origin.ingredientId)) {
        present.add(origin.ingredientId);
      }
    }
  }
  return present;
}

/**
 * Whether the checked destination list holds a live item for each of this meal's
 * ingredients, read on **web**.
 *
 * Web keeps no durable mutation queue (`queryClient.ts`) and `useListDetail` holds its
 * projection in screen-local state rather than the query cache (the `503` fence's own
 * reason), so there is no existing shared cache entry for one list's items to read here.
 * This reads the destination directly through the same `GET /v1/lists/:id?includeItems`
 * transport, keyed so every mounted ingredient section for one destination shares the one
 * request — and so `useAddIngredients` can invalidate exactly this entry after a write.
 */
export function useIngredientPresence(
  activityId: string,
  destinationListId: string | undefined,
): IngredientPresenceView {
  const enabled = destinationListId !== undefined;
  const query = useQuery({
    queryKey: ingredientPresenceKey(destinationListId ?? ''),
    queryFn: ({ signal }) =>
      getList(apiClient, destinationListId as string, { includeItems: true }, signal),
    enabled,
    networkMode: 'offlineFirst',
    retry: false,
  });

  return useMemo(() => {
    if (!enabled || query.status !== 'success') return UNKNOWN_PRESENCE;
    // Zod's optional output uses `T | undefined`; the domain model uses property absence.
    const items = (query.data.items ?? []).map((entry) => entry.item as ListItemView);
    return { present: presentIngredientIds(items, activityId), known: true };
  }, [enabled, query.status, query.data, activityId]);
}
