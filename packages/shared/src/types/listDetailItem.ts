import type { ListItemActivityLink } from './list.js';
import type { ListItemView } from './listItemView.js';

/**
 * One row of a list detail's item page (P3-05): the item plus the **caller's own**
 * `ListItemActivityLink`, present only when this viewer has planned the item and may still
 * read that Activity. Another member's pointer is never response data (ADR-034).
 */
export interface ListDetailItem {
  item: ListItemView;
  viewerLink?: ListItemActivityLink;
}
