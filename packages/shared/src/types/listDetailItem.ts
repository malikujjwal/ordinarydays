import type { ListItemActivityLink } from './list.js';
import type { ListItemPlanState } from './listItemPlanState.js';
import type { ListItemView } from './listItemView.js';

/**
 * One row of a list detail's item page (P3-05): the item, the **caller's own**
 * `ListItemActivityLink`, and the trimmed state of the Plan that link names (P3-15). Present
 * only when this viewer has planned the item and may still read that Activity; another
 * member's pointer is never response data (ADR-034).
 *
 * The pair arrives together or not at all — the link is the pointer, the plan is what it
 * resolved to, and a pointer whose Activity the caller cannot read is omitted rather than
 * serialised as a dead link. Without the plan a row could not tell a scheduled Plan from an
 * unscheduled or completed one, which is the whole of the state line (P3-34).
 */
export interface ListDetailItem {
  item: ListItemView;
  viewerLink?: ListItemActivityLink;
  viewerPlan?: ListItemPlanState;
}
