import type { Activity } from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import {
  activityFromPartition,
  batchGetActivityMeta,
  getActivityIndex,
  getActivityMeta,
  getActivityPartitionStrong,
  listParticipants,
} from '../repositories/activityRepository.js';
import { getListPointer, type ListAccessGrant } from '../repositories/listRepository.js';
import type { StoredItem } from '../repositories/migrate.js';

/**
 * The single place the activity authorisation rules from
 * [`api-contract.md` §3](../../../../docs/02-architecture/api-contract.md) are enforced
 * (P1-10 rule 2).
 *
 * ## Why this is written in full in Phase 1
 *
 * Every activity in Phase 1 belongs to the only user there is, so every call takes the owner
 * branch and the participant read never fires. It is written anyway, and P1-10 says why: the
 * owner / participant / stranger distinction is **a rule about keys, not about
 * authentication**, and it is testable today with two invented user ids. Deferring it to
 * Phase 6 would mean adding an access check to eleven existing call sites, and the one that
 * got missed would be the leak.
 *
 * ## The two rules that are easy to get wrong
 *
 * **A stranger gets `not_found`, never `403`** (`definition-of-done.md` §7 rule 5). `403`
 * confirms the activity exists, which is a fact a stranger is not entitled to. `403` is used
 * only where the caller already knows it exists — a participant reaching for an owner-only
 * action, who can see the plan and is being told they may not complete it.
 *
 * **A participant of a parent may act on its child.** Completing a *plan* asserts a shared
 * fact about an event, so only the owner may say so; completing a *prep task* ticks an item
 * on a shared checklist, and if Alice books the hotel she must be able to tick `Book hotel`
 * whoever typed it (`api-contract.md` §3, `plans-and-lists.md` §3, ADR-051). That is one rule
 * here rather than a branch in every endpoint.
 */

/**
 * What the caller is about to do, named by what it needs rather than by the verb.
 *
 * `write` and `owner` are separate because the difference is the whole prep-task decision: a
 * participant may edit and complete a child activity (`write`) and may not reschedule,
 * rename, delete or complete the plan itself (`owner`).
 */
export type AccessLevel = 'read' | 'write' | 'owner';

/** What the check resolved, for a caller that needs to know how it got in. */
export interface ActivityAccess {
  readonly activity: Activity;
  readonly isOwner: boolean;
  /** True when access came through the parent's participant set, not this activity's. */
  readonly viaParent: boolean;
}

/** What a successful pointer-based List check resolved. */
export interface ListAccess {
  readonly index: ListAccessGrant;
  readonly isOwner: boolean;
}

const NOT_FOUND = 'Activity not found.';
const LIST_NOT_FOUND = 'List not found.';
const AUTHORITATIVE_ACTIVITY_READ = { consistentRead: true } as const;

/**
 * `403`, and the only place one is produced for an activity. The caller can already see this
 * activity, so naming the limit is not a disclosure — it is the answer to their question.
 */
const OWNER_ONLY = 'Only the person who created this can change it.';
const LIST_OWNER_ONLY = 'Only the list owner can make this change.';

/**
 * The single List access check (`security-privacy.md` row 4a).
 *
 * The exact caller/list pointer built by `keys.ts` is the grant. A missing pointer is always 404;
 * an existing member asking for an owner-only action gets 403 because existence is already
 * known to them. MEMBER and LLINK rows are never consulted.
 */
export async function assertListAccess(
  userId: string,
  listId: string,
  level: AccessLevel,
): Promise<ListAccess> {
  const index = await getListPointer(userId, listId);
  if (index === undefined) throw new AppError('not_found', LIST_NOT_FOUND);
  if (index.role === 'owner') return { index, isOwner: true };
  if (level === 'owner') throw new AppError('forbidden', LIST_OWNER_ONLY);
  return { index, isOwner: false };
}

/**
 * Whether a stored `PART#` row belongs to this user.
 *
 * `Participant.userId` is optional — a guest has none (`data-model.md` §4.7) — so an absent
 * one must never match an absent caller id. It cannot here, because `userId` is required
 * before this is reached, but the comparison is written to be obviously safe rather than
 * safe-by-context.
 */
function belongsTo(row: StoredItem, userId: string): boolean {
  return typeof row.userId === 'string' && row.userId === userId;
}

async function isParticipant(activityId: string, userId: string): Promise<boolean> {
  const rows = await listParticipants(activityId, AUTHORITATIVE_ACTIVITY_READ);
  return rows.some((row) => belongsTo(row, userId));
}

/**
 * Resolves the activity and asserts the caller may do `level` to it.
 *
 * Returns the activity it loaded, so the caller does not read the canonical row a second
 * time — every activity-scoped service method needs both the check and the row, and issuing
 * two `GetItem`s for one request is how the round-trip budget goes
 * (`definition-of-done.md` §6).
 *
 * ## Round trips
 *
 * One `GetItem` on the owner path, which is every request in Phase 1. A non-owner costs one
 * `Query` for this activity's participants, and a non-owner on a **child** costs one further
 * `GetItem` and `Query` for the parent — three round trips, at the budget and only on the
 * path that cannot be reached until Phase 6.
 *
 * Every one of those authority reads is strongly consistent. Participant removal is the
 * revocation mechanism (`security-privacy.md` section 1.1); an eventually consistent read
 * could admit a removed participant on the request immediately after removal. Consistency is
 * an invariant of this helper rather than a caller option, so a new route cannot weaken its
 * authorisation check by omission.
 *
 * @throws `not_found` when the activity does not exist, or the caller has no relationship to
 * it. The two are deliberately indistinguishable.
 * @throws `forbidden` when the caller is a participant reaching for an owner-only action.
 */
export async function assertActivityAccess(
  userId: string,
  activityId: string,
  level: AccessLevel,
): Promise<ActivityAccess> {
  const activity = await getActivityMeta(activityId, AUTHORITATIVE_ACTIVITY_READ);

  // A missing activity and an activity belonging to a stranger produce the same answer, from
  // the same line, so the two cannot drift apart into a timing or a message difference.
  if (activity === undefined) throw new AppError('not_found', NOT_FOUND);

  if (activity.ownerId === userId) {
    return { activity, isOwner: true, viaParent: false };
  }

  const granted = await grantFromParticipation(activity, userId, level);
  if (granted !== undefined) return granted;

  throw new AppError('not_found', NOT_FOUND);
}

/**
 * Everything the access rule checks **after** ownership, in one place.
 *
 * Extracted in P3-15 so the batched multi-activity check below reaches the same verdict as
 * the single-activity one from the same code. Two implementations of an authorisation rule
 * that agree today are two implementations that disagree later, and this is the rule the
 * list projection's caller-scoping rests on (`security-privacy.md` row 15a).
 *
 * Takes the activity rather than its id, so a caller that already holds the row — the batch
 * path does — does not read it a second time.
 */
async function grantFromParticipation(
  activity: Activity,
  userId: string,
  level: AccessLevel,
): Promise<ActivityAccess | undefined> {
  if (await isParticipant(activity.activityId, userId)) {
    return grantToParticipant(activity, level, false);
  }

  /**
   * A prep task inherits its parent's participant set — and **only** for `read` and `write`.
   * An owner-only action on a child is still the child owner's, which matters because a prep
   * task's own delete is not a shared-checklist tick.
   */
  if (activity.parentActivityId !== undefined) {
    const parent = await getActivityMeta(
      activity.parentActivityId,
      AUTHORITATIVE_ACTIVITY_READ,
    );
    if (parent !== undefined && parent.ownerId === userId) {
      return grantToParticipant(activity, level, true);
    }
    if (
      parent !== undefined &&
      (await isParticipant(activity.parentActivityId, userId))
    ) {
      return grantToParticipant(activity, level, true);
    }
  }

  return undefined;
}

/**
 * Which of these activities the caller may **read**, resolved in bounded batches rather than
 * one authorisation per id (P3-15, raised in review).
 *
 * ## Why this exists
 *
 * The list projection authorises one Activity per viewer link. Doing that through
 * `assertActivityAccess` costs a `GetItem` each, **sequentially** — a fifty-item page with
 * fifty links is fifty round trips. Once shared Plans arrive it is worse than one read each:
 * a non-owner also costs a participant `Query`, and a prep task adds its parent's META and
 * participants on top. Batching the META reads alone would leave those behind.
 *
 * ## What is batched, and what cannot be
 *
 * Every META arrives in **one** `BatchGetItem` — which retries `UnprocessedKeys` and fails
 * loudly rather than silently short — and ownership, the only evidence most links will ever
 * need, is decided from that batch with no further read at all.
 *
 * Participant evidence cannot join it: `PART#` rows are keyed by `personId`, not by user, so
 * membership is a `Query` per activity and DynamoDB has no multi-partition Query batch. Those
 * resolve for the non-owned remainder only, in **bounded chunks** — never a `Promise.all` over
 * the page. Firing fifty Queries at once trades serial latency for a burst, which is the same
 * cost in a different shape and is exactly what the bounded-batch design exists to avoid.
 *
 * In this phase that remainder is always empty: no Activity has participants until Phase 6,
 * so every link is resolved by the single batch. When sharing lands, the right fix is to make
 * participation answerable from a **keyed** row so it can join the batch — the caller's own
 * index entry is the obvious candidate — but that changes which row is authoritative for
 * access, which is a Phase 6 decision and not one to make here by implication.
 *
 * ## What it deliberately does not do
 *
 * It does not throw. A caller asking about many activities wants to know which ones it may
 * read, and a missing row and a stranger's row are the same answer — absent from the result
 * — for the same reason `assertActivityAccess` answers `404` to both: a pointer must not
 * become a way to probe for an Activity's existence.
 */
/**
 * How many participant `Query`s may be in flight at once.
 *
 * Small on purpose. This path exists to stop a page issuing one read per link, and replacing
 * a serial walk with a simultaneous burst of the same size would miss the point — it moves
 * the cost from latency to throughput pressure and makes throttling more likely, not less.
 */
const PARTICIPANT_READ_CHUNK = 5;

export async function readableActivities(
  userId: string,
  activityIds: readonly string[],
): Promise<Map<string, Activity>> {
  const unique = [...new Set(activityIds)];
  if (unique.length === 0) return new Map();

  const metas = await batchGetActivityMeta(unique);
  const readable = new Map<string, Activity>();
  const unresolved: Activity[] = [];

  for (const activity of metas) {
    if (activity.ownerId === userId) {
      readable.set(activity.activityId, activity);
      continue;
    }
    unresolved.push(activity);
  }

  for (let start = 0; start < unresolved.length; start += PARTICIPANT_READ_CHUNK) {
    const chunk = unresolved.slice(start, start + PARTICIPANT_READ_CHUNK);
    const grants = await Promise.all(
      chunk.map(async (activity) => ({
        activity,
        granted: await grantFromParticipation(activity, userId, 'read'),
      })),
    );
    for (const { activity, granted } of grants) {
      if (granted !== undefined) readable.set(activity.activityId, activity);
    }
  }

  return readable;
}

/**
 * Legacy partition-shaped authorization helper retained for non-detail callers and fixtures.
 * The bounded detail route uses {@link assertActivityReadAccessFromMeta} below.
 */
export async function assertActivityReadAccessFromPartition(
  userId: string,
  partition: readonly StoredItem[],
): Promise<ActivityAccess> {
  const activity = activityFromPartition(partition);
  if (activity === undefined) throw new AppError('not_found', NOT_FOUND);
  if (activity.ownerId === userId) {
    return { activity, isOwner: true, viaParent: false };
  }
  if (
    partition.some(
      (row) => row.sk?.toString().startsWith('PART#') && belongsTo(row, userId),
    )
  ) {
    return { activity, isOwner: false, viaParent: false };
  }
  if (activity.parentActivityId !== undefined) {
    const parentPartition = await getActivityPartitionStrong(activity.parentActivityId);
    const parent = activityFromPartition(parentPartition);
    if (
      parent !== undefined &&
      (parent.ownerId === userId ||
        parentPartition.some(
          (row) => row.sk?.toString().startsWith('PART#') && belongsTo(row, userId),
        ))
    ) {
      return { activity, isOwner: false, viaParent: true };
    }
  }
  throw new AppError('not_found', NOT_FOUND);
}

/**
 * Bounded detail authorization from the already-read canonical META row.
 *
 * Non-owner evidence is the exact caller/activity index grant named by access pattern 4,
 * strongly read by key. Parent inheritance repeats the same pair for the parent and never
 * opens either user-growing Activity partition.
 */
export async function assertActivityReadAccessFromMeta(
  userId: string,
  activity: Activity,
  options: { readonly preloadedDirectIndex?: StoredItem | null } = {},
): Promise<ActivityAccess> {
  if (activity.ownerId === userId) {
    return { activity, isOwner: true, viaParent: false };
  }
  const direct =
    options.preloadedDirectIndex === undefined
      ? await getActivityIndex(userId, activity.activityId, { consistentRead: true })
      : (options.preloadedDirectIndex ?? undefined);
  if (direct !== undefined) {
    return { activity, isOwner: false, viaParent: false };
  }
  if (activity.parentActivityId !== undefined) {
    const parent = await getActivityMeta(
      activity.parentActivityId,
      AUTHORITATIVE_ACTIVITY_READ,
    );
    if (parent?.ownerId === userId) {
      return { activity, isOwner: false, viaParent: true };
    }
    if (parent !== undefined) {
      const inherited = await getActivityIndex(userId, parent.activityId, {
        consistentRead: true,
      });
      if (inherited !== undefined) {
        return { activity, isOwner: false, viaParent: true };
      }
    }
  }
  throw new AppError('not_found', NOT_FOUND);
}

/**
 * The fields a **participant** may not patch on a plan they are on (P1-13).
 *
 * `api-contract.md` §3 puts it in words — a participant "cannot reschedule, rename, delete,
 * or remove others" — and P1-13 names the five. What is left for them is their own RSVP,
 * their own reminders, date suggestions, updates and expenses, each of which is its own
 * endpoint rather than a field on this one.
 *
 * **`status` is deliberately not on this list**, because P1-13 does not put it there. A
 * participant cancelling somebody else's plan looks like it should be refused the same way,
 * and completion already is (ADR-048, owner-only). Nothing can exercise the difference until
 * participants exist in Phase 6; it is called out here rather than quietly added, because
 * adding a restriction the contract does not name is the same class of decision as dropping
 * one it does.
 */
/**
 * `primaryAttachmentId` joins the list in P3-22, and it is not the "restriction the contract
 * does not name" the note above warns against: `plans-and-lists.md` §2.1 row 8 makes adding
 * and deleting attachments owner-only, and `Set as cover` is the third item on that same
 * long-press menu. A participant who could not add or remove an image but could promote one
 * to the plan's hero would be an inconsistency, not a permission.
 */
const PARTICIPANT_MAY_NOT_PATCH = [
  'title',
  'location',
  'objectKind',
  'type',
  'primaryAttachmentId',
] as const;

const PARTICIPANT_REFUSED =
  'Only the person who created this plan can change its title, date or place.';

/**
 * Refuses the fields a participant may not touch — **in `authz.ts`, not in the handler**,
 * which is P1-13's instruction and the same rule as everything else here: one place decides
 * who may do what, so the next endpoint cannot re-derive it slightly differently.
 *
 * Three callers reach this and only one is refused:
 *
 * - the **owner** patches anything;
 * - a participant acting on a **prep task** patches anything, because a prep task is an item
 *   on a shared checklist and "may complete, uncomplete and **edit** it, whoever created it"
 *   (`api-contract.md` §3, ADR-051) — that is what `viaParent` records;
 * - a participant patching the **plan itself** is refused these five.
 *
 * `403`, not `404`: the caller can see this plan, so naming the limit answers their question
 * rather than disclosing anything.
 */
export function assertPatchableFields(
  access: ActivityAccess,
  patch: Readonly<Record<string, unknown>>,
): void {
  if (access.isOwner || access.viaParent) return;

  const refused = PARTICIPANT_MAY_NOT_PATCH.filter((field) => field in patch);
  if (refused.length === 0) return;

  throw new AppError(
    'forbidden',
    PARTICIPANT_REFUSED,
    refused.map((field) => ({ path: field, message: PARTICIPANT_REFUSED })),
  );
}

/**
 * The participant verdict, shared by the three ways of becoming one.
 *
 * `read` and `write` are granted; `owner` is `403` rather than `404`, because a participant
 * can already see the activity and telling them it does not exist would be a lie they can
 * disprove by scrolling.
 */
function grantToParticipant(
  activity: Activity,
  level: AccessLevel,
  viaParent: boolean,
): ActivityAccess {
  if (level === 'owner') throw new AppError('forbidden', OWNER_ONLY);
  return { activity, isOwner: false, viaParent };
}
