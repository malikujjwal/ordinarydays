import type { ListItemRow } from '@/lib/sqlite/listItemsRepository';

/**
 * The platform boundary for item deletion.
 *
 * Web has no durable local projection, so the feature hook owns its online request. Native
 * exposes only transactional operations: every network write remains inside the sync adapter.
 */
export type DeleteListItemProjection =
  | { readonly kind: 'online' }
  | {
      readonly kind: 'durable';
      readonly prepare: (item: ListItemRow, intentId: string) => Promise<void>;
      readonly undo: (originalIntentId: string, inverseIntentId: string) => Promise<void>;
      readonly commit: (originalIntentId: string) => Promise<void>;
      readonly requestSync: () => void;
    };

/** Web has no SQLite projection; its query refresh owns the visible result. */
export function useDeleteListItem(): DeleteListItemProjection {
  return { kind: 'online' };
}
