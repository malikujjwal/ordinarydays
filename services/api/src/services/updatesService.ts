import { UPDATES_PAGE_SIZE } from '@od/shared';
import type { Activity, ActivityUpdate } from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import type { IdempotencyReceipt } from '../lib/idempotency.js';
import { touchLastActivity } from '../repositories/activityRepository.js';
import {
  activityUpdatePut,
  deleteActivityUpdate,
  getActivityUpdate,
  listActivityUpdates,
  newUpdateId,
} from '../repositories/activityUpdateRepository.js';
import { receiptItem } from '../repositories/idempotencyRepository.js';
import {
  type TransactItem,
  TransactionBuilder,
  transactWrite,
} from '../repositories/tx.js';
import { assertActivityAccess } from './authz.js';

/**
 * The plan's activity feed (P3-19, `api-contract.md` §2.5).
 *
 * ## Two kinds of entry, one row, two writers
 *
 * A `user` entry comes from a person through `POST`. A `system` entry comes from the server
 * recording something that happened — a date set, a time changed, a plan completed — and is
 * written **only** through {@link writeSystemUpdate}, by the service that owns the event. That
 * asymmetry is the feed's whole credibility: `kind` is server-authored on both paths, so a
 * de-emphasised "Time changed to 8 PM" row is something the system actually did rather than
 * something a caller claimed.
 *
 * ## Which timestamp moves
 *
 * A posted update bumps `lastActivityAt` and never `updatedAt`
 * (`feature-to-schema-map.md`, "two timestamps, two jobs"). Bumping `updatedAt` would `409`
 * an owner's open edit sheet over somebody else's comment; not bumping `lastActivityAt` would
 * leave the Needs-a-date stage sorted by nothing anyone can see.
 *
 * **A system entry bumps neither**, which is a reading rather than a quotation, so it is
 * argued here. `data-model.md` §3.5 lists the bumpers as RSVP changes, posted updates and
 * added expenses — "anything that means *this plan is being discussed*" — and a record that
 * the date moved is not a discussion, it is the receipt for an edit. The edit that caused it
 * has already moved `updatedAt` through its own path, and moving `lastActivityAt` as well
 * would float a plan to the top of Needs a date because its owner corrected a typo in the
 * time. Raised in the PR rather than assumed.
 */

const NOT_FOUND = 'Update not found.';

/** Every refusal on the delete path, so none of them can be told apart from another. */
function updateNotFound(): AppError {
  return new AppError('not_found', NOT_FOUND);
}

export interface UpdatesPage {
  readonly updates: readonly ActivityUpdate[];
  readonly cursor?: string;
}

/**
 * One newest-first page (`GET /v1/activities/:id/updates`).
 *
 * `read`, so a participant of a shared plan sees the feed; in this phase that resolves to the
 * owner. The access check runs before the feed is touched, so a stranger cannot learn that a
 * plan has updates — or that it exists — by asking for them.
 */
export async function listUpdates(
  userId: string,
  activityId: string,
  cursor?: string,
): Promise<UpdatesPage> {
  await assertActivityAccess(userId, activityId, 'read');
  return listActivityUpdates(activityId, {
    limit: UPDATES_PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
  });
}

export interface PostedUpdate {
  readonly update: ActivityUpdate;
  readonly lastActivityAt: string;
}

/**
 * Posts a user entry (`POST /v1/activities/:id/updates`).
 *
 * **One transaction**: the `UPD#` row, the `META` and index rewrites that carry the new
 * `lastActivityAt`, and the idempotency receipt. Nothing here is safe to split — an entry
 * committed without its timestamp leaves the plan sorted where it was, and a timestamp
 * committed without its entry claims a discussion that is not there.
 *
 * `touchLastActivity` composes into the caller's transaction rather than sending its own,
 * which is what makes that possible; it also conditions `META` on the `updatedAt` it read, so
 * a concurrent edit loses here rather than having its version silently overwritten by a copy
 * of the row that predates it.
 *
 * `now` is a parameter, so every derived value — the id's seed, `createdAt`, the new
 * `lastActivityAt` — is assertable without freezing the clock.
 */
export async function postUpdate(
  userId: string,
  activityId: string,
  body: string,
  now: string,
  receiptFor?: (result: PostedUpdate) => IdempotencyReceipt,
): Promise<PostedUpdate> {
  const { activity } = await assertActivityAccess(userId, activityId, 'write');

  const update: ActivityUpdate = {
    updateId: newUpdateId(now),
    activityId,
    kind: 'user',
    authorUserId: userId,
    body,
    createdAt: now,
    schemaVersion: 1,
  };

  const items: TransactItem[] = [activityUpdatePut(update)];
  const touched = touchLastActivity(activity, now, indexedUserIdsFor(activity), items);

  const result: PostedUpdate = { update, lastActivityAt: touched.lastActivityAt };

  const builder = new TransactionBuilder(
    'postUpdate',
    receiptFor === undefined ? 0 : 1,
  ).add(...items);
  if (receiptFor !== undefined) builder.addReserved(receiptItem(receiptFor(result)));

  await transactWrite(builder.build(), { operation: 'postUpdate' });

  return result;
}

/**
 * Deletes one entry (`DELETE /v1/activities/:id/updates/:updateId`).
 *
 * **Author-only, `user` entries only, and every other outcome is the same `404`** — a missing
 * id, a system entry, and somebody else's entry all answer identically, because telling them
 * apart would report the existence and authorship of a row the caller may not read
 * (`api-contract.md` §2.5, `plans-and-lists.md` §2.1 row 9).
 *
 * The repository repeats both conditions on the delete itself, so the decision made from the
 * row that was read cannot be applied to a row that has changed since.
 *
 * It does **not** move `lastActivityAt`. Removing your own comment is not discussion, and
 * un-bumping is not possible anyway — the previous value is gone. The feed simply has one
 * fewer entry.
 */
export async function deleteUpdate(
  userId: string,
  activityId: string,
  updateId: string,
): Promise<void> {
  await assertActivityAccess(userId, activityId, 'read');

  const update = await getActivityUpdate(activityId, updateId);
  if (update === undefined) throw updateNotFound();
  if (update.kind !== 'user') throw updateNotFound();
  if (update.authorUserId !== userId) throw updateNotFound();

  try {
    await deleteActivityUpdate(update, userId);
  } catch (error) {
    // The conditions lost a race: the row changed between the read and the delete, so the
    // entry this request authorised no longer exists. Same answer as never having found it.
    if (error instanceof AppError && error.code === 'conflict') throw updateNotFound();
    throw error;
  }
}

/**
 * The **only** way a `system` entry is written, called by the service that owns the event.
 *
 * It returns transact items rather than sending them, so the entry commits in the *same*
 * transaction as the change it records. That is the point: a schedule write that succeeded
 * while its "Date set to Saturday" entry failed would leave a feed that disagrees with the
 * plan, and the feed's only job is to agree with the plan.
 *
 * It writes no `lastActivityAt` and touches no `META` — see this module's header for why a
 * system record is not discussion. That also keeps it composable: the caller's transaction
 * already rewrites `META` for its own reasons, and two writers on one item cancel a
 * transaction outright.
 */
export function writeSystemUpdate(
  activityId: string,
  body: string,
  now: string,
): TransactItem {
  const update: ActivityUpdate = {
    updateId: newUpdateId(now),
    activityId,
    kind: 'system',
    body,
    createdAt: now,
    schemaVersion: 1,
  };
  return activityUpdatePut(update);
}

/**
 * Who holds an index row for this activity: the owner, plus every participating user.
 *
 * Phase 6 supplies more than one. Named here rather than inlined because `touchLastActivity`
 * rewrites one index row per user, and a caller that passed only the owner on a shared plan
 * would leave every participant's Needs-a-date list sorted by a stale timestamp.
 */
function indexedUserIdsFor(activity: Activity): readonly string[] {
  return [activity.ownerId];
}
