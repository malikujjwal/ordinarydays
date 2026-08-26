import { UPDATES_PAGE_SIZE } from '@od/shared';
import { activityUpdate as activityUpdateSchema } from '@od/shared/schemas';
import type { ActivityUpdate } from '@od/shared/types';
import { decodeTime, monotonicFactory } from 'ulid';
import { deleteItem, getItem, query } from './base.js';
import { activityUpdate, activityUpdatePrefix } from './keys.js';
import type { StoredItem } from './migrate.js';
import type { TransactItem } from './tx.js';

/**
 * The `UPD#` rows in an Activity partition: the plan's feed (P3-19).
 *
 * Its own file rather than more of `activityRepository.ts`, for the reason `repo-structure.md`
 * §2.4 gives: the Activity repository owns the entity and its index projections, while the
 * feed is a separate collection in the same partition with its own paging rule. The one place
 * they must meet — a posted entry moving `lastActivityAt` — meets in a **transaction the
 * service composes**, not in either repository reaching into the other.
 *
 * Nothing here sends a transaction. {@link activityUpdatePut} returns an item so the caller
 * commits it beside `touchLastActivity`'s items and the idempotency receipt in one write; a
 * repository that sent its own would make that atomicity impossible to express.
 */

const ENTITY = 'ActivityUpdate';
const SCHEMA_VERSION = 1;
const ID_PREFIX = 'upd_';

/**
 * One monotonic factory **per timestamp**, recreated whenever the seed changes.
 *
 * A single shared `monotonicFactory` cannot be used here, and the reason is the exact
 * property it advertises: asked for an id at a timestamp **earlier** than one it has already
 * issued, it clamps to the later one rather than going backwards. Two requests that capture
 * `now` and then pause — for authorisation, for a retry — can easily commit out of order, and
 * the earlier one would then be stored at `UPD#<T1>#<id>` while its id encoded `T2`. The row
 * would be visible in the feed and permanently unreachable by {@link keyFor}: every delete
 * of it a `404` for an entry plainly there.
 *
 * Recreating on a changed seed keeps both properties that matter: the encoded time is always
 * the caller's, and ids minted inside one millisecond still increment rather than ordering on
 * random bits. Both the read and the write are synchronous, so nothing interleaves between
 * them.
 */
let seedMs: number | undefined;
let seedFactory = monotonicFactory();

/**
 * An id **seeded from the entry's own `createdAt`**, which is what makes the row addressable.
 *
 * The sort key is `UPD#<createdAt>#<updateId>` (`data-model.md` §3.1), so reaching one row
 * needs its timestamp — and `DELETE /v1/activities/:id/updates/:updateId` arrives with only an
 * id. The three ways out were: page the feed looking for it, which is an unbounded read of a
 * partition the user grows without limit and is exactly what `data-model.md` §5 forbids; add a
 * locator row, which the List items have as `ITEMID#` but which changes the key table for one
 * endpoint; or make the id carry the timestamp it was minted at, which is a property ULIDs
 * already have and nothing else has to know about.
 *
 * So the seed is the parsed `createdAt`, and {@link keyFor} decodes it back. Both directions
 * are byte-exact because the timestamp is milliseconds either way and `toISOString` is its
 * only spelling. `updateKeyRoundTrips` pins that, because the day it stops being true is the
 * day deletes start answering `404` for entries that are plainly there.
 *
 * `monotonicFactory`, not bare `ulid`: two entries posted inside one millisecond share a
 * `createdAt`, so the id is the tie-break the sort key falls back on, and random bits would
 * order them arbitrarily.
 */
export function newUpdateId(createdAt: string): string {
  const seed = Date.parse(createdAt);
  if (seed !== seedMs) {
    seedFactory = monotonicFactory();
    seedMs = seed;
  }
  const updateId = `${ID_PREFIX}${seedFactory(seed)}`;

  /**
   * Checked here, not merely documented. Everything about this row's addressability rests on
   * the id decoding back to its own `createdAt`, and the failure mode when it does not is
   * silent: the entry commits, renders, and can never be deleted. One `decodeTime` on a write
   * path that already does a transaction is not a cost worth trading for that.
   */
  if (!updateKeyRoundTrips(createdAt, updateId)) {
    throw new Error(
      `A minted update id does not encode its own createdAt (${createdAt}). The row would be unreachable.`,
    );
  }

  return updateId;
}

/**
 * The stored key for an entry, from its id alone.
 *
 * `undefined` for an id whose ULID does not decode — a malformed id is a `404`, not a crash,
 * because it names an entry that cannot exist.
 */
export function keyFor(
  activityId: string,
  updateId: string,
): { pk: string; sk: string } | undefined {
  if (!updateId.startsWith(ID_PREFIX)) return undefined;
  try {
    const createdAt = new Date(
      decodeTime(updateId.slice(ID_PREFIX.length)),
    ).toISOString();
    return activityUpdate(activityId, createdAt, updateId);
  } catch {
    return undefined;
  }
}

/** The invariant {@link newUpdateId} and {@link keyFor} depend on, asserted rather than assumed. */
export function updateKeyRoundTrips(createdAt: string, updateId: string): boolean {
  const decoded = keyFor('act_probe', updateId);
  return decoded?.sk === `UPD#${createdAt}#${updateId}`;
}

/** The stored row for one entry, keyed by its own `createdAt`. */
function updateItem(update: ActivityUpdate): StoredItem {
  return {
    ...activityUpdate(update.activityId, update.createdAt, update.updateId),
    entity: ENTITY,
    ...update,
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * The put for one entry, for a caller composing the whole write.
 *
 * Conditional on absence: the id is server-minted so a collision is not a real scenario, but an
 * unconditional put is the one that silently overwrites when a scenario turns out to be real.
 * It costs a server-minted write nothing and removes the case.
 */
export function activityUpdatePut(update: ActivityUpdate): TransactItem {
  return {
    Put: { Item: updateItem(update), ConditionExpression: 'attribute_not_exists(pk)' },
  };
}

export interface ActivityUpdatePageResult {
  readonly updates: ActivityUpdate[];
  readonly cursor?: string;
}

/**
 * One newest-first page of the feed (access pattern 4, `api-contract.md` §2.5).
 *
 * `ascending: false` is the whole ordering story, and it is free: the sort key leads with the
 * timestamp, so reading the prefix backwards **is** newest-first. Nothing sorts in memory,
 * which is what keeps the page boundary honest — a caller re-sorting a page would be ordering
 * fifty rows out of a feed that has more.
 *
 * The cursor carries the exact key attributes it pages on, so one minted here cannot be
 * replayed against a different query.
 */
export async function listActivityUpdates(
  activityId: string,
  options: { readonly cursor?: string; readonly limit?: number } = {},
): Promise<ActivityUpdatePageResult> {
  const prefix = activityUpdatePrefix(activityId);
  const page = await query<StoredItem>(
    { pk: prefix.pk },
    {
      skPrefix: prefix.skPrefix,
      ascending: false,
      limit: options.limit ?? UPDATES_PAGE_SIZE,
      keyAttributes: ['pk', 'sk'],
      /**
       * **Strongly consistent, because a client reads its own post.** P3-39 posts optimistically
       * and then refetches; an eventually consistent page can come back without the entry it
       * just created, which reads as the post having failed. It is a base-table Query on one
       * partition, so this is cheap and available — unlike on the GSI.
       */
      consistentRead: true,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    },
  );

  return {
    updates: page.items.map(toActivityUpdate),
    ...(page.nextCursor === undefined ? {} : { cursor: page.nextCursor }),
  };
}

/** Parses a stored row into the domain shape, dropping every storage attribute. */
export function toActivityUpdate(row: unknown): ActivityUpdate {
  return activityUpdateSchema.parse(row) as ActivityUpdate;
}

/**
 * One entry by id: a single `GetItem`, because {@link keyFor} reconstructs the sort key.
 *
 * A missing entry is `undefined`. The endpoint turns that, an entry of the wrong kind, and one
 * written by somebody else into the **same** `404` — see `updatesService`.
 */
export async function getActivityUpdate(
  activityId: string,
  updateId: string,
): Promise<ActivityUpdate | undefined> {
  const key = keyFor(activityId, updateId);
  if (key === undefined) return undefined;
  const row = await getItem<StoredItem>(key, { consistentRead: true });
  return row === undefined ? undefined : toActivityUpdate(row);
}

/**
 * Deletes one entry, conditionally on it still being this author's own `user` row.
 *
 * The condition is not belt-and-braces over the service's check. Between reading the entry and
 * deleting it another request can land, and a delete authorised against what was read would
 * otherwise apply to whatever is there now. Both halves are authorisation: kind, so a system
 * record cannot be removed, and author, so nobody removes somebody else's
 * (`plans-and-lists.md` §2.1 row 9).
 */
export async function deleteActivityUpdate(
  update: ActivityUpdate,
  authorUserId: string,
): Promise<void> {
  await deleteItem(activityUpdate(update.activityId, update.createdAt, update.updateId), {
    expression:
      'attribute_exists(pk) AND #kind = :kind AND #authorUserId = :authorUserId',
    names: { '#kind': 'kind', '#authorUserId': 'authorUserId' },
    values: { ':kind': 'user', ':authorUserId': authorUserId },
  });
}
