import type { Activity } from './activity.js';
import type { ListItemActivityLink } from './list.js';
import type { ListItemView } from './listItemView.js';

/**
 * What the bridge answers with (`api-contract.md` §2.7, `phase-03` §P3-13).
 *
 * Three things, and the second is the point of the endpoint. `item` is the source ListItem
 * **unchanged** — not copied, not moved, not checked, not hidden, not given an Activity id
 * (`agent-playbook.md` §6.8, ADR-034). Returning it is what lets a client, a test, or a
 * reviewer see that the bridge linked rather than duplicated: same `itemId`, same title, same
 * `checked`, byte for byte with what was there before the call.
 *
 * `viewerLink` is singular and is the **caller's own** pointer. Another viewer's pointer is
 * never response data, so this stays one link rather than a collection: one viewer has at
 * most one current pointer per item, and v1 exposes no link history.
 */
export interface ScheduledListItem {
  activity: Activity;
  item: ListItemView;
  viewerLink: ListItemActivityLink;
}
