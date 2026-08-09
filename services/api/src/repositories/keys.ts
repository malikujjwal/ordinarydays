/**
 * **Every `pk` and `sk` string in the product, and nothing else.**
 *
 * This is the file the tenancy story rests on. Key construction in one place is what makes
 * "every item is scoped to the user who owns it" auditable: there is exactly one file to
 * read to check it, and a reviewer can hold the whole key surface in their head at once
 * (`repo-structure.md` §2.4, `security-privacy.md` §1 row 4, `CLAUDE.md`).
 *
 * A `pk:` or `sk:` template literal anywhere else in the codebase is a review rejection, and
 * three mechanisms enforce it rather than trusting anyone to remember:
 * `src/lib/layering.test.ts`, `scripts/check-forbidden.mjs no-key-literals`, and
 * acceptance criterion 21.
 *
 * ## Two rules for anything added here
 *
 * 1. **Every builder that identifies user-owned data takes `userId` explicitly.** None has a
 *    default and none reads a constant. A `userProfile()` that returned the dev user with no
 *    argument would be a shortcut that costs a day in Phase 4 and a tenancy bug after it.
 * 2. **Builders are pure string construction.** No validation, no I/O, no clock. A key
 *    builder that rejected a malformed id would be a second validation layer disagreeing
 *    with the schemas; a key builder that read the time would make writes untestable.
 *
 * ## Scope
 *
 * This transcribes **all of `data-model.md` §3**, not only the item types Phase 1 writes.
 * The alternative — a builder per phase — means thirty later tasks each appending to the one
 * file the whole product's tenant isolation depends on, each conflicting with its neighbours
 * and each re-deriving a key format from a table they may not have read. The keys are pure
 * transcription from a canonical table that is already complete, they cost one line and one
 * assertion each, and having them all here means a reviewer sees the whole surface at once.
 * Item types that do not exist yet are marked with the phase that writes them.
 */

/** The `sk` of the canonical item in a partition that has one. */
const META = 'META';

// ── §3.1 Activity partition ─────────────────────────────────────────────────────────────

const activityPk = (activityId: string) => `ACT#${activityId}`;

/** The canonical Activity row. */
export const activityMeta = (activityId: string) => ({
  pk: activityPk(activityId),
  sk: META,
});

/** Every item under one activity — the plan-detail screen's single `Query` (pattern 4). */
export const activityPartition = (activityId: string) => ({ pk: activityPk(activityId) });

/** Phase 6. */
export const participant = (activityId: string, personId: string) => ({
  pk: activityPk(activityId),
  sk: `PART#${personId}`,
});

/** Phase 7. */
export const expense = (activityId: string, expenseId: string) => ({
  pk: activityPk(activityId),
  sk: `EXP#${expenseId}`,
});

/** Phase 3. `isoTs` first so the feed sorts chronologically within the partition. */
export const activityUpdate = (activityId: string, isoTs: string, updateId: string) => ({
  pk: activityPk(activityId),
  sk: `UPD#${isoTs}#${updateId}`,
});

/**
 * An occurrence override. Phase 2 writes these; the key exists now because the shape does
 * (`data-model.md` §4.5).
 *
 * `date` is the series' **nominal** date, not `overrideDate` — a rescheduled occurrence is
 * still keyed by the day the rule produced, which is what lets expansion find it.
 */
export const occurrence = (activityId: string, date: string) => ({
  pk: activityPk(activityId),
  sk: `OCC#${date}`,
});

/** The `sk` range for occurrences in a window (pattern 5). */
export const occurrenceRange = (activityId: string, from: string, to: string) => ({
  pk: activityPk(activityId),
  fromSk: `OCC#${from}`,
  toSk: `OCC#${to}`,
});

/** Phase 3. */
export const attachment = (activityId: string, attachmentId: string) => ({
  pk: activityPk(activityId),
  sk: `ATT#${attachmentId}`,
});

/** A thin prep-task pointer, so plan detail renders children from the same `Query`. */
export const childPointer = (activityId: string, childActivityId: string) => ({
  pk: activityPk(activityId),
  sk: `SUB#${childActivityId}`,
});

/** The `sk` prefix for a plan's prep tasks (pattern 16). */
export const childPointerPrefix = (activityId: string) => ({
  pk: activityPk(activityId),
  skPrefix: 'SUB#',
});

/**
 * **A reminder belongs to one user, and the key says so.**
 *
 * `userId` sits before `reminderId` so the detail projection can filter to the caller and
 * the Phase 5 scheduler can read every row from the same `Query` (patterns 4 and 4b). Losing
 * that ordering would mean one of the two needs a second read.
 */
export const reminder = (activityId: string, userId: string, reminderId: string) => ({
  pk: activityPk(activityId),
  sk: `REM#${userId}#${reminderId}`,
});

/** Every reminder belonging to one user on one activity. */
export const reminderPrefix = (activityId: string, userId: string) => ({
  pk: activityPk(activityId),
  skPrefix: `REM#${userId}#`,
});

/** Phase 6. */
export const dateSuggestion = (
  activityId: string,
  isoTs: string,
  suggestionId: string,
) => ({
  pk: activityPk(activityId),
  sk: `SUGG#${isoTs}#${suggestionId}`,
});

// ── §3.2 User partition ─────────────────────────────────────────────────────────────────

const userPk = (userId: string) => `USER#${userId}`;

/**
 * The tenant record (§3.2, pattern 6).
 *
 * **`PROFILE`, not `META`.** Corrected in P1-07, which was the first task to read the item
 * rather than merely use its partition. `META` is this file's convention for *a partition
 * that has one canonical row* — `ACT#<id>` / `META` is right, because everything else under
 * an Activity hangs off it. The user partition is not that shape: it also holds `IDX#`,
 * `LIST#`, `PERSON#`, `PLINK#`, `LLINK#`, `BAL#`, `SETTLE#` and `DEVICE#` rows, none of
 * which is subordinate to the profile, which is why §3.2 names this row descriptively.
 *
 * The mismatch survived P1-05 because `keys.test.ts` asserted the value the code produced
 * rather than the value the table specifies, and because nothing had read a profile yet —
 * every other caller uses only `.pk`. Nothing had written one either, so this was a string
 * change rather than a migration.
 */
export const userProfile = (userId: string) => ({ pk: userPk(userId), sk: 'PROFILE' });

/**
 * One per activity the user owns **or participates in** — how a shared plan reaches someone
 * else's Today. This is the only item type that carries GSI1 keys.
 */
export const activityIndex = (userId: string, activityId: string) => ({
  pk: userPk(userId),
  sk: `IDX#${activityId}`,
});

/** Phase 3. A near-pure pointer: the canonical list lives in its own partition (§3.3). */
export const listPointer = (userId: string, listId: string) => ({
  pk: userPk(userId),
  sk: `LIST#${listId}`,
});

/** The `sk` prefix for a user's list pointers (pattern 7). */
export const listPointerPrefix = (userId: string) => ({
  pk: userPk(userId),
  skPrefix: 'LIST#',
});

/** Phase 7. */
export const person = (userId: string, personId: string) => ({
  pk: userPk(userId),
  sk: `PERSON#${personId}`,
});

export const personPrefix = (userId: string) => ({
  pk: userPk(userId),
  skPrefix: 'PERSON#',
});

/** Phase 6/7. `sortTs` before `activityId` so pattern 10 reads newest-first by sort order. */
export const personLink = (
  userId: string,
  personId: string,
  sortTs: string,
  activityId: string,
) => ({
  pk: userPk(userId),
  sk: `PLINK#${personId}#${sortTs}#${activityId}`,
});

export const personLinkPrefix = (userId: string, personId: string) => ({
  pk: userPk(userId),
  skPrefix: `PLINK#${personId}#`,
});

/** Phase 6. */
export const personListLink = (
  userId: string,
  personId: string,
  addedAt: string,
  listId: string,
) => ({
  pk: userPk(userId),
  sk: `LLINK#${personId}#${addedAt}#${listId}`,
});

export const personListLinkPrefix = (userId: string, personId: string) => ({
  pk: userPk(userId),
  skPrefix: `LLINK#${personId}#`,
});

/**
 * Phase 7. Keyed by `(personId, currency)` because expenses are never converted between
 * currencies — someone who owes €20 and is owed $30 has two rows, and the UI shows two
 * figures rather than a meaningless sum.
 */
export const balance = (userId: string, personId: string, currency: string) => ({
  pk: userPk(userId),
  sk: `BAL#${personId}#${currency}`,
});

export const balancePrefix = (userId: string) => ({
  pk: userPk(userId),
  skPrefix: 'BAL#',
});

/** Phase 7. Immutable audit history, never a second balance delta. */
export const settlement = (
  userId: string,
  personId: string,
  isoTs: string,
  settlementId: string,
) => ({
  pk: userPk(userId),
  sk: `SETTLE#${personId}#${isoTs}#${settlementId}`,
});

export const settlementPrefix = (userId: string, personId: string) => ({
  pk: userPk(userId),
  skPrefix: `SETTLE#${personId}#`,
});

/** Phase 5 push delivery; the endpoints that write it are P1-08. */
export const device = (userId: string, deviceId: string) => ({
  pk: userPk(userId),
  sk: `DEVICE#${deviceId}`,
});

export const devicePrefix = (userId: string) => ({
  pk: userPk(userId),
  skPrefix: 'DEVICE#',
});

/** Phase 9. */
export const shortcut = (userId: string, shortcutId: string) => ({
  pk: userPk(userId),
  sk: `SHORTCUT#${shortcutId}`,
});

// ── §3.3 List partition ─────────────────────────────────────────────────────────────────

const listPk = (listId: string) => `LIST#${listId}`;

/** Phase 3. The **canonical** list, not the owner's pointer. */
export const listMeta = (listId: string) => ({ pk: listPk(listId), sk: META });

export const listPartition = (listId: string) => ({ pk: listPk(listId) });

/** Phase 6. Non-owner members only; the owner is synthesised from the pointer. */
export const listMember = (listId: string, personId: string) => ({
  pk: listPk(listId),
  sk: `MEMBER#${personId}`,
});

/**
 * Phase 3. Sorted by `(rank, itemId)` — the tie-break is not optional, because two members
 * inserting at the same position concurrently produce identical ranks.
 */
export const listItem = (listId: string, rank: string, itemId: string) => ({
  pk: listPk(listId),
  sk: `ITEM#${rank}#${itemId}`,
});

export const listItemPrefix = (listId: string) => ({
  pk: listPk(listId),
  skPrefix: 'ITEM#',
});

/**
 * Phase 3. **Viewer first, deliberately.** A shared list item can lead to one person's
 * private Plan and another's; there is no global link on the item. Keying by viewer gives
 * each one at most one state line per item, and lets member removal delete exactly their
 * pointers with `begins_with LNK#<viewer>#` (pattern 8c).
 */
export const listItemActivityLink = (
  listId: string,
  viewerUserId: string,
  itemId: string,
) => ({
  pk: listPk(listId),
  sk: `LNK#${viewerUserId}#${itemId}`,
});

export const listItemActivityLinkPrefix = (listId: string, viewerUserId: string) => ({
  pk: listPk(listId),
  skPrefix: `LNK#${viewerUserId}#`,
});

// ── §3.4 Lookup partitions ──────────────────────────────────────────────────────────────

/** Phase 6. Carries a `ttl`. Tokens are random bytes, never ULIDs — see §8. */
export const inviteToken = (token: string) => ({ pk: `INVITE#${token}`, sk: META });

/**
 * Phase 4. **Lower-cased**, because an email lookup that depended on the casing somebody
 * typed would fail to match the same person.
 */
export const emailLookup = (email: string) => ({
  pk: `EMAIL#${email.toLowerCase()}`,
  sk: 'USER',
});

/** Phase 6. The reverse index that makes guest→account linking a `Query`, never a `Scan`. */
export const guestEmail = (email: string, ownerId: string, personId: string) => ({
  pk: `GUESTEMAIL#${email.toLowerCase()}`,
  sk: `OWNER#${ownerId}#PERSON#${personId}`,
});

export const guestEmailPrefix = (email: string) => ({
  pk: `GUESTEMAIL#${email.toLowerCase()}`,
});

/** Phase 7. Resolves a globally unique expense id to its activity (pattern 12a). */
export const expenseLocator = (expenseId: string) => ({
  pk: `EXPENSE#${expenseId}`,
  sk: META,
});

/** Phase 7. */
export const settlementLocator = (settlementId: string) => ({
  pk: `SETTLEMENT#${settlementId}`,
  sk: META,
});

/**
 * **User-scoped, and that is a security requirement rather than a nicety.** A bare
 * `IDEM#<key>` partition would let one user's client-generated key return another user's
 * stored response. Carries a `ttl` of now + 24 h. P1-04 writes these.
 */
export const idempotency = (userId: string, key: string) => ({
  pk: `IDEM#${userId}#${key}`,
  sk: META,
});

/**
 * A fixed-window rate-limit counter, `ttl` set to the window end. P1-03 writes these.
 *
 * `subject` is a user id for authenticated routes and a **SHA-256 hash** of the client IP
 * for public ones — a raw address is never written to DynamoDB or to a log line
 * (`security-privacy.md`). Hashing is the caller's job; this builder only assembles.
 */
export const rateLimit = (scope: string, subject: string, windowStart: string) => ({
  pk: `RATE#${scope}#${subject}`,
  sk: windowStart,
});

// ── §3.5 GSI1 buckets ───────────────────────────────────────────────────────────────────

/**
 * GSI1 is populated **only on `ActivityIndex` items**, into exactly four buckets.
 *
 * Which bucket an activity lands in is decided by one pure function,
 * `deriveGsi1Bucket` — `packages/shared/src/activities/bucket.ts`, Phase 2. These builders
 * assemble the keys once that answer exists; they do not decide it, and adding a fifth
 * builder here without a row in §3.5 is how a ghost bucket appears.
 *
 * **`#P` and `#N` are separate, and there is no single "unscheduled" bucket.** Both are
 * undated and they mean opposite things: `#N` is *today, whenever* (a solo errand) and `#P`
 * is *someday, undecided* (a group plan with no date). Collapsing them was the model's
 * largest product error — it put an undecided group plan in Today's Anytime list.
 */
const gsi1pk = (userId: string, bucket: 'S' | 'P' | 'N' | 'R') => `U#${userId}#${bucket}`;

/** Today, Plans → Upcoming, date ranges. `localDateTime` is `YYYY-MM-DDTHH:mm`, wall clock. */
export const gsi1Scheduled = (
  userId: string,
  localDateTime: string,
  activityId: string,
) => ({
  gsi1pk: gsi1pk(userId, 'S'),
  gsi1sk: `${localDateTime}#${activityId}`,
});

/** Plans → Needs a date. **Never Today.** Sorted by `lastActivityAt`, descending. */
export const gsi1NeedsDate = (
  userId: string,
  lastActivityAt: string,
  activityId: string,
) => ({
  gsi1pk: gsi1pk(userId, 'P'),
  gsi1sk: `${lastActivityAt}#${activityId}`,
});

/** Today's Anytime section. */
export const gsi1Anytime = (userId: string, createdAt: string, activityId: string) => ({
  gsi1pk: gsi1pk(userId, 'N'),
  gsi1sk: `${createdAt}#${activityId}`,
});

/**
 * Recurrence expansion. `seriesStartDate` is the **first** segment's `effectiveFrom`, which
 * is immutable — so appending a segment never rewrites this index key.
 */
export const gsi1Recurring = (
  userId: string,
  seriesStartDate: string,
  activityId: string,
) => ({
  gsi1pk: gsi1pk(userId, 'R'),
  gsi1sk: `${seriesStartDate}#${activityId}`,
});

/** The GSI1 partition for one bucket, for a query that reads a whole feed. */
export const gsi1Bucket = (userId: string, bucket: 'S' | 'P' | 'N' | 'R') => ({
  gsi1pk: gsi1pk(userId, bucket),
});
