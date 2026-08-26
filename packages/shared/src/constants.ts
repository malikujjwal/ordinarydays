/**
 * Limits both sides of the wire enforce.
 *
 * Any number the client and the server must agree on lives here and is imported by both.
 * Two copies of `50` is a bug waiting (`tech-stack.md` §5.1).
 */

/** Participants per Activity, including the owner. */
export const MAX_PARTICIPANTS = 50;

/** Widest date window a single agenda query may request. */
export const MAX_AGENDA_DAYS = 62;

/** Largest attachment accepted through a presigned upload. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Items in one List. */
export const MAX_LIST_ITEMS = 500;

/** Characters in an Activity or ListItem title. */
export const MAX_TITLE_LEN = 200;

/** Characters in a notes field. */
export const MAX_NOTES_LEN = 4000;

/** Reminders one user may set on one Activity. Reminders are per user (`data-model.md` §3.1). */
export const MAX_REMINDERS_PER_USER_PER_ACTIVITY = 3;

/** Active recurring series per user. Exceeding this is a warning, not an error. */
export const MAX_ACTIVE_SERIES = 200;

/** Paused iOS writes retained in the process-death mutation queue. */
export const MAX_OFFLINE_MUTATIONS = 200;

/**
 * How long a persisted offline intent may replay **without asking the user** (P2-48/P2-49).
 *
 * **One constant, two consumers, and they must never diverge.** The client stops replaying an
 * intent automatically this many days after the intent was *created*; the server keeps a
 * deletion tombstone this many days after the entity was *deleted*. Deletion happens at or
 * after creation, so the tombstone provably outlives the replay window — but only because
 * these are the same number. Tune one alone and the hole reopens silently: a create whose
 * response was lost replays after its tombstone has gone, the conditional write succeeds, and
 * an activity the user deleted weeks ago comes back.
 *
 * **DynamoDB's lazy TTL deletion is not part of the safety margin.** It removes expired items
 * late — typically within 48 hours, with no guarantee — so a tombstone usually survives
 * longer than this. That slack is a bonus, never load-bearing.
 *
 * The intent itself is **never deleted** on reaching this age — it moves to
 * `needs_confirmation` and waits for the user (`interaction-contract.md` §5.4). Retention is
 * indefinite; only automation is bounded.
 */
export const MAX_AUTOMATIC_INTENT_AGE_DAYS = 30;

/**
 * The UI's offer window for a reversible single action, in seconds
 * (`interaction-contract.md` §4). Bulk actions get ten; that literal arrives with P3-10.
 *
 * It is the **presentation** deadline — the instant the client stops offering Undo — and
 * never the server's replay deadline, which is `MAX_AUTOMATIC_INTENT_AGE_DAYS`.
 */
export const UNDO_OFFER_SECONDS = 6;

/**
 * The UI's offer window for a reversible **bulk** action, in seconds
 * (`interaction-contract.md` §4).
 *
 * Ten rather than six "because there is more to notice": a toast that says `7 items cleared`
 * is asking the user to check seven rows are gone, not one. Same presentation-deadline
 * semantics as {@link UNDO_OFFER_SECONDS}.
 */
export const BULK_UNDO_OFFER_SECONDS = 10;

/** How far back `include=overdue` rolls incomplete tasks forward. */
export const OVERDUE_WINDOW_DAYS = 30;

/** Undated saved tasks rendered inline under Today's bounded ANYTIME section. */
export const TODAY_ANYTIME_SAVED_LIMIT = 20;

/** Rows rendered before Today's EARLIER TODAY section offers its local expander. */
export const TODAY_EARLIER_COLLAPSED_LIMIT = 10;

/** Rolled-forward tasks required before Today's ANYTIME overdue group collapses. */
export const TODAY_OVERDUE_COLLAPSE_THRESHOLD = 5;

/** Rolled-forward tasks retained when Today's overdue group is collapsed. */
export const TODAY_OVERDUE_COLLAPSED_LIMIT = 3;

/**
 * Characters in a free-text sub-field: `service`, `organiser`, ingredient
 * `name`, reservation `name`/`reference` (`activities.md` §3 rule 6).
 */
export const MAX_FREE_TEXT_LEN = 120;

/**
 * Rendered provenance accumulated on a ListItem.
 *
 * A single label can contain a full 200-character Activity title, so the generic 120-character
 * free-text bound cannot describe this server-authored field. Extensions are never truncated:
 * the service validates the completed label and refuses the whole action before DynamoDB when
 * this generous item-local bound would be exceeded.
 */
export const MAX_SOURCE_LABEL_LEN = 4000;

/** Storage-only activity-keyed segments behind one rendered `sourceLabel`. */
export const MAX_SOURCE_PROVENANCE_SEGMENTS = 500;

/** Characters in `location.address`. The label uses {@link MAX_FREE_TEXT_LEN}. */
export const MAX_ADDRESS_LEN = 300;

/** Ingredient rows on one meal (`activities.md` §4.2). */
export const MAX_INGREDIENTS = 60;

/**
 * Ingredients one `add-to-list` action may carry (P3-17).
 *
 * Lower than {@link MAX_INGREDIENTS} on purpose, and the reason is arithmetic: the action
 * commits its list rows, the List META update, the meal's provenance and its idempotency
 * receipt in **one** DynamoDB transaction, and a transaction holds at most 100 items. Each
 * created row costs three (the ranked row, its locator, a tombstone check), so 30 rows plus
 * the deletion gate, META, the Activity and the receipt is 94 — and 60 would be 184.
 *
 * A meal may still hold 60 ingredients; adding more than 30 at once takes two taps. That is
 * the cheaper side of the trade: the alternative is chunking, which is what made the first
 * version of this action non-atomic (raised in review).
 */
export const MAX_INGREDIENTS_PER_ADD = 30;

/**
 * Rule segments in one recurring series (`data-model.md` §4.2).
 *
 * Segments are append-only — every "all future occurrences" edit adds one — so this is the
 * number of times a series' rule may be changed before the user must start a new series.
 */
export const MAX_RECURRENCE_SEGMENTS = 20;

/**
 * Date suggestions on one undated plan (`data-model.md` §4.3a). A nudge toward a date, not
 * a scheduling poll.
 */
export const MAX_DATE_SUGGESTIONS = 5;

/**
 * Longest `lexoRank` the generator will emit (`coding-standards.md` §9). An open end steps by
 * one (~61 inserts per character), so sequential appends never reach this inside the 500-item
 * cap; a bounded gap is bisected (~6 per character), so pathological repeated insertion into
 * one gap can — the typed overflow then triggers the bounded list repair (P3-04/P3-08),
 * never a corrupt order. The `ITEM#<rank>#<itemId>` sort key stays far under DynamoDB's
 * 1,024 bytes.
 */
export const MAX_LEXO_RANK_LENGTH = 64;

/**
 * Lists one user may **own** (`api-contract.md` §2.7, `phase-03` §P3-05). Creation counts
 * only owner pointers against it; incoming shared-list memberships do not consume the quota
 * and are served by pagination, which is why the Lists-tab cursor is not optional.
 */
export const MAX_OWNED_LISTS = 100;
