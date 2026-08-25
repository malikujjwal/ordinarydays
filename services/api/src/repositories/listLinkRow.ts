import type { ListItemActivityLink } from '@od/shared/types';
import { listItemActivityLink } from './keys.js';
import type { StoredItem } from './migrate.js';

/**
 * The one stamped `ListItemActivityLink` row, in a module both repositories can reach.
 *
 * ## Why it is not in either of them
 *
 * The row belongs to the list partition, so `listRepository` wrote it and owned its entity
 * name. P3-13's bridge has to write it **inside** the durable Activity-create transaction —
 * the Plan, the owner index, the caller's reminders and this pointer are one atomic unit, and
 * splitting them would let a Plan exist that no item points at. That transaction is composed
 * in `activityRepository`, which cannot import `listRepository`: `listRepository` already
 * imports `activityRepository` for provenance clearing, and the cycle fails
 * `no-circular` (`repo-structure.md` §3 rule 7).
 *
 * The alternatives were worse. A second copy of the row shape in `activityRepository` is a
 * schema defined twice (`coding-standards.md` §11.8) and would drift the moment a field is
 * added. Passing a prebuilt `TransactItem` down through the service would put a storage type
 * in a service signature to dodge a layering rule rather than satisfy it.
 *
 * So the row moves to a module beneath both, which is where a thing two repositories share
 * belongs. `keys.ts` is not that module — it builds keys, and a stamped row is a row.
 */

/** `ListItemActivityLink`, the one spelling. Both repositories read it from here. */
export const LIST_ITEM_ACTIVITY_LINK_ENTITY = 'ListItemActivityLink';

/**
 * The stored row for one viewer's pointer.
 *
 * `linkedAt` doubles as `createdAt`/`updatedAt`: a pointer is written whole and replaced
 * whole — a viewer scheduling again overwrites their own row at the same key — so there is no
 * state in which the three could differ.
 */
export function listItemActivityLinkRow(
  link: ListItemActivityLink,
  now: string,
): StoredItem {
  return {
    ...listItemActivityLink(link.listId, link.viewerUserId, link.itemId),
    ...link,
    entity: LIST_ITEM_ACTIVITY_LINK_ENTITY,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
}
