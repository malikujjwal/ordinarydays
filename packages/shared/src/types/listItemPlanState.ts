import type { ActivitySchedule } from './activity.js';
import type { ActivityStatus, PlanType } from './vocabulary.js';

/**
 * The caller's linked Plan, trimmed to what a list row can say about it (P3-15, P3-34).
 *
 * **Deliberately not the Activity.** A list row renders one line — `Planned Saturday · 7 PM`,
 * `Next session Friday · 8 PM`, `Done Saturday` — and shipping the whole Activity to draw it
 * would make the list projection a second Activity-detail contract, with two shapes to keep
 * in step and a private Plan's every field travelling into a list response.
 *
 * Three fields, each earning its place. The Activity's id is **not** among them: it is already
 * on the `viewerLink` this always travels with, and one id in two places is one id that can
 * disagree with itself. The state line's tap target reads it from the link
 * (`interaction-contract.md` §6.2).
 *
 * - `type` — the verb differs by kind: an event is `Planned`, a watch session is
 *   `Next session`. Inferring it from the list's behaviour would be wrong for a `custom` Plan
 *   made from a `watch` list, which the bridge explicitly allows.
 * - `status` — `Done Saturday` versus `Planned Saturday`, and the un-complete that reverts it.
 * - `schedule` — the date and time the line renders, and **the display gate**: a line shows
 *   only when the hydrated Activity has `schedule.date`, so an unscheduled Plan keeps its
 *   pointer and loses its line (`plans-and-lists.md` §6.2).
 *
 * What is absent is as deliberate. No `title`: the row shows the **item's** title, and the two
 * are independent after the one-time seed (P3-14). No watch progress: `Watching · S2 E4` comes
 * from the item's own `details`, not from the Plan. No `outcome`: every completion renders
 * `Done`, and a skip removes the pointer entirely, so no line survives to vary.
 */
export interface ListItemPlanState {
  type: PlanType;
  status: ActivityStatus;
  schedule?: ActivitySchedule;
}
