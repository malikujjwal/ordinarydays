import type { ListItem } from './list.js';

/**
 * The ListItem an API response carries (P3-05): the stored shape minus `itemRevision`, the
 * storage-only mutation fence the identity locator mirrors (`data-model.md` §3.3). `rank`
 * stays — it is opaque to the client but drives the shared `(rank, itemId)` sort order.
 */
export type ListItemView = Omit<ListItem, 'itemRevision'>;
