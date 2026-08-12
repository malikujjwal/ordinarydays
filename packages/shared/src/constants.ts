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

/** Characters in `location.address`. The label uses {@link MAX_FREE_TEXT_LEN}. */
export const MAX_ADDRESS_LEN = 300;

/** Ingredient rows on one meal (`activities.md` §4.2). */
export const MAX_INGREDIENTS = 60;

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
