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
