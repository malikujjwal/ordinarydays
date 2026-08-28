import type { ListItemActivityLink } from './list.js';
import type { ListItemPlanState } from './listItemPlanState.js';
import type { ListItemView } from './listItemView.js';

/**
 * One row of a list detail's item page (P3-05): the item, the **caller's own**
 * `ListItemActivityLink`, and the trimmed state of the Plan that link names (P3-15). Present
 * only when this viewer has planned the item and may still read that Activity; another
 * member's pointer is never response data (ADR-034).
 *
 * **Two shapes, not one with two optional fields**, the same choice {@link ListSettingsMutation}
 * makes and for the same reason. The link is the pointer and the plan is what it resolved to,
 * so a row has both or neither: a link without state cannot render a state line, and state
 * without a link names a Plan the row cannot navigate to. Independent optionals would let a
 * server emit half a pair and a client believe it.
 *
 * A pointer whose Activity the caller cannot read is omitted rather than serialised as a dead
 * link. Without the plan a row could not tell a scheduled Plan from an unscheduled or
 * completed one, which is the whole of the state line (P3-35).
 */
export type ListDetailItem =
  | { item: ListItemView }
  | {
      item: ListItemView;
      viewerLink: ListItemActivityLink;
      viewerPlan: ListItemPlanState;
    };
