import type { Activity } from './activity.js';
import type { ActivityUpdate } from './activityUpdate.js';
import type { AgendaCapabilities, AgendaItemStatus } from './agenda.js';
import type { Attachment } from './attachment.js';
import type { Reminder } from './reminder.js';

/** An activity read is either the stored series/one-off or one named virtual occurrence. */
export type ActivityDetailTarget =
  | { readonly kind: 'activity'; readonly activityId: string }
  | {
      readonly kind: 'occurrence';
      readonly activityId: string;
      /** The recurrence's nominal date, even when the occurrence moved. */
      readonly date: string;
    };

/** Server-authoritative effective state for one recurring occurrence. */
export interface OccurrenceDetailProjection {
  /** The recurrence identity used by every occurrence write. */
  nominalDate: string;
  /** Effective rendered date after a move or cross-day snooze. */
  date: string;
  time?: string;
  endTime?: string;
  status: AgendaItemStatus;
  isSnoozed: boolean;
  completedAt?: string;
}

/**
 * What `GET /v1/activities/:id` returns (`api-contract.md` §2.3). Schema in
 * `../schemas/activity.ts`; `activity.test.ts` pins the two together.
 *
 * ## Why this is its own file
 *
 * `reminder.test.ts` asserts that the word `reminders` **appears nowhere in
 * `types/activity.ts`** — ADR-047's guard, written in the phase where there is nothing yet to
 * leak, because that is the only time it is cheap to enforce. `Activity` has no `reminders[]`
 * and must never grow one: reminders are per-user items in the Activity's partition, and
 * merging them into the entity is how one user's reminders reach everybody on a shared plan
 * in Phase 6.
 *
 * A *detail response* legitimately carries the caller's own, so the two live apart. Putting
 * this next to `Activity` would have meant loosening a guard that is doing its job — the
 * wrong trade, and the reason this file exists rather than an exception in that test.
 *
 * ## Additive by construction
 *
 * Phase 1 defines `{ activity, reminders }` because those are the only two that exist.
 * `api-contract.md` §2.3 also names participants, expenses, updates, attachments, children
 * and date suggestions; each arrives as an **optional field added here** rather than as a
 * redefinition, so a client written against this keeps working when P6 adds `participants`.
 * That is the whole reason the response is an object of named collections rather than a bare
 * `Activity`.
 *
 * > **Owned by P1-12, defined by P1-26**, which needed it before the endpoint existed.
 */
export interface ActivityDetail {
  /** Server-authored action authority for this caller; absent only in an older cached response. */
  capabilities?: AgendaCapabilities;
  /**
   * The caller's own, filtered server-side in the projection before serialising
   * (`security-privacy.md` §1 row 15). A shared plan has one schedule and many reminder
   * sets; nobody sees anybody else's, not even that they have any.
   */
  reminders: Reminder[];
  activity: Activity;
  /** Present exactly for an occurrence-targeted read. Never inferred from agenda cache. */
  occurrence?: OccurrenceDetailProjection;
  /** Real stored completed-occurrence rows used by destructive recurrence confirmations. */
  completedOccurrenceCount?: number;
  /**
   * The newest page of the plan's feed, embedded so opening a plan is **one** request
   * (§2.3, P3-36's one-request rule). `updatesCursor` continues it through P3-19's
   * `GET .../updates?cursor=`; its absence means the feed ends here rather than that paging
   * is unavailable.
   */
  updates?: ActivityUpdate[];
  updatesCursor?: string;
  /**
   * Every image linked to this activity, capped at
   * `MAX_ATTACHMENTS_PER_ACTIVITY` by the confirm path (P3-22).
   *
   * Bounded by the model rather than by a page size, which is why there is no cursor beside
   * it: twenty rows is the whole collection, and a client that receives them has them all.
   * Each carries a **key**, never a URL — media is served by unguessable key (ADR-023), and
   * the API returns a key only for an image this caller may already see.
   */
  attachments?: Attachment[];
}
