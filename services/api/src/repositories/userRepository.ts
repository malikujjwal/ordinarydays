import type { DefaultSlot, PatchUserInput, User } from '@od/shared/types';
import { monotonicFactory } from 'ulid';
import { getItem, putItem, updateItem } from './base.js';
import { userProfile } from './keys.js';
import type { TransactItem } from './tx.js';

/**
 * The user profile — `USER#<userId>` / `PROFILE` (`data-model.md` §3.2, access pattern 6).
 *
 * **This is the tenant record.** Every item in the product is keyed by a `userId`, and this
 * is the row that says the user exists. Nothing in Phase 1 creates one: P1-21's seed script
 * writes the single local dev row, and Phase 4's post-confirmation trigger is the only thing
 * that will ever create a real one (`auth.md`).
 */

/**
 * A new user id — `usr_` plus a ULID.
 *
 * **Unused in Phase 1**, and written anyway. Phase 4's post-confirmation trigger needs a
 * generator; if it does not find one it will write its own, and then there are two places
 * that decide what a user id looks like. One of them will eventually disagree with
 * `schemas/common.ts`, which is the validator every stored row is checked against.
 *
 * ULIDs are sortable by creation time and need no coordination (`data-model.md` §8). The
 * **strict** assertion that an id is a ULID lives here, at the point of generation, rather
 * than in the shared validator — because `usr_local_dev` is the id the system runs as for
 * the whole of Phases 1 to 3, and a validator that rejected it is a validator somebody
 * deletes under pressure (P1-01).
 *
 * `monotonicFactory`, not the bare `ulid()`. Plain ULIDs share a timestamp within the same
 * millisecond and break the tie with 80 random bits, so two ids minted in the same tick sort
 * arbitrarily — which is exactly the guarantee §8 says the choice was made for. The
 * monotonic factory increments the random component instead, so ids from one process are
 * strictly ordered. Caught by the test asserting that two consecutive ids sort.
 */
const nextUlid = monotonicFactory();

export function newUserId(): string {
  return `usr_${nextUlid()}`;
}

/**
 * Writes a profile outright, creating or replacing it.
 *
 * **The only unconditional profile write, and it has exactly two callers ever.** P1-21's seed
 * script writes the one local dev row, and Phase 4's post-confirmation trigger creates a real
 * one. Everything else patches, conditionally — see {@link patchProfile} for why a create
 * that conjures a tenant record with three fields on it is the thing being avoided.
 *
 * Added in P1-21, which is the first caller: this repository shipped read-and-patch in P1-07
 * because nothing created a profile yet, and P1-07 said in as many words that the seed would
 * be the one to.
 *
 * Field by field rather than a spread, like every other write here: a spread would carry
 * whatever the caller happened to have on the object, including storage attributes if it read
 * the row first.
 */
export async function putProfile(user: User): Promise<void> {
  await putItem({
    ...userProfile(user.userId),
    entity: 'User',
    userId: user.userId,
    displayName: user.displayName,
    timezone: user.timezone,
    currency: user.currency,
    weekStartsOn: user.weekStartsOn,
    ...(user.defaultReminderOffset == null
      ? {}
      : { defaultReminderOffset: user.defaultReminderOffset }),
    ...(user.allDayReminderHour === undefined
      ? {}
      : { allDayReminderHour: user.allDayReminderHour }),
    ...(user.quietHours === undefined ? {} : { quietHours: user.quietHours }),
    ...(user.defaultLists === undefined ? {} : { defaultLists: user.defaultLists }),
    ...(user.email === undefined ? {} : { email: user.email }),
    ...(user.cognitoSub === undefined ? {} : { cognitoSub: user.cognitoSub }),
    ...(user.onboardingState === undefined
      ? {}
      : { onboardingState: user.onboardingState }),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    schemaVersion: user.schemaVersion,
  });
}

/** The profile, or `undefined` when the table has no row for this user. */
export function getProfile(userId: string): Promise<User | undefined> {
  return getItem<User & Record<string, unknown>>(userProfile(userId)) as Promise<
    User | undefined
  >;
}

/**
 * Applies a patch to an existing profile and returns the stored result.
 *
 * ## Two things this does not do
 *
 * It does not **create**. The update is conditional on the row existing, so a patch against
 * a missing profile fails rather than conjuring a tenant record with three fields on it —
 * which is what an unconditional `UpdateItem` would do, silently, and which would leave a
 * profile with no `createdAt` and no `schemaVersion` for every later reader to cope with.
 *
 * It does not **decide what may be patched**. The accepted field set is `patchUserInput` in
 * `packages/shared`, validated at the route. A repository that also filtered would be a
 * second, quieter copy of that rule.
 *
 * `null` is meaningful for `defaultReminderOffset` — it is *Off*, distinct from `0`, which
 * is a real "at the time" reminder (ADR-047). So a null is written as `REMOVE`, clearing the
 * attribute, rather than stored as a null or skipped as absent.
 */
export async function patchProfile(
  userId: string,
  patch: PatchUserInput,
  updatedAt: string,
): Promise<User | undefined> {
  const sets: string[] = ['#updatedAt = :updatedAt'];
  const removes: string[] = [];
  const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':updatedAt': updatedAt };

  for (const [field, value] of Object.entries(patch)) {
    names[`#${field}`] = field;
    if (value === null) {
      removes.push(`#${field}`);
      continue;
    }
    sets.push(`#${field} = :${field}`);
    values[`:${field}`] = value;
  }

  const expression = [
    `SET ${sets.join(', ')}`,
    removes.length > 0 ? `REMOVE ${removes.join(', ')}` : undefined,
  ]
    .filter((clause): clause is string => clause !== undefined)
    .join(' ');

  const updated = await updateItem<User & Record<string, unknown>>(userProfile(userId), {
    expression,
    names,
    values,
    // The profile must already exist. `pk` is on every stored item, so this is the cheapest
    // existence check available and needs no extra read.
    condition: 'attribute_exists(pk)',
  });

  return updated as User | undefined;
}

/**
 * The conditional transaction item that clears `defaultLists[slot]` when — and only when —
 * that exact slot still points at the list being removed (phase-03 §P3-05; P3-12's slot
 * changes reuse it).
 *
 * A **nested** `REMOVE`, never a whole-map `SET`, so sibling slots survive whatever else is
 * happening to them. The condition re-asserts the value the caller read: a newer destination
 * chosen concurrently on another device fails this item rather than being silently removed,
 * and the caller retries its transaction without it.
 */
/**
 * The mirror of {@link removeDefaultListTransactItem}: puts one slot back, and only while it
 * is still empty (P3-10, `api-contract.md` §2.7).
 *
 * A slot inverse restores "the exact `defaultLists[oldSlot]` entry removed by the forward
 * change ... only if the slot is still absent there; a newer destination choice makes the
 * whole inverse no longer applicable". The condition is what says that — this item failing
 * cancels the transaction it is part of, so the Undo writes nothing rather than overwriting
 * a choice the user has made since.
 *
 * A **nested** `SET` through a document path, never a whole-map write, so the sibling slots
 * survive whatever is happening to them. When the parent map is absent — a profile that has
 * never had a default — the document path cannot be written, so the caller's inverse fails
 * cleanly instead of inventing a map that a concurrent creator would then lose.
 */
export function restoreDefaultListTransactItem(
  userId: string,
  slot: DefaultSlot,
  listId: string,
): TransactItem {
  return {
    Update: {
      Key: userProfile(userId),
      UpdateExpression: 'SET #defaultLists.#slot = :listId',
      ConditionExpression:
        'attribute_exists(pk) AND attribute_not_exists(#defaultLists.#slot)',
      ExpressionAttributeNames: { '#defaultLists': 'defaultLists', '#slot': slot },
      ExpressionAttributeValues: { ':listId': listId },
    },
  };
}

export function removeDefaultListTransactItem(
  userId: string,
  slot: DefaultSlot,
  listId: string,
): TransactItem {
  return {
    Update: {
      Key: userProfile(userId),
      UpdateExpression: 'REMOVE #defaultLists.#slot',
      ConditionExpression: 'attribute_exists(pk) AND #defaultLists.#slot = :listId',
      ExpressionAttributeNames: { '#defaultLists': 'defaultLists', '#slot': slot },
      ExpressionAttributeValues: { ':listId': listId },
    },
  };
}
