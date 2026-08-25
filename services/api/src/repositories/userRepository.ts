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
 *
 * ## `defaultLists` is a nested patch, and that is the whole point
 *
 * Every other field here is a whole attribute, so patching it is one assignment. The slot map
 * is not: it holds three independent user choices, and `PATCH /v1/me` may carry any subset of
 * them (`api-contract.md` §2.1, `phase-03` §P3-12). So each supplied slot is applied through
 * its own **document path** — `SET defaultLists.<slot>` for an id, `REMOVE defaultLists.<slot>`
 * for a `null` — and an omitted slot is never named in the expression at all.
 *
 * `SET #defaultLists = :map` is what this must never emit. It would carry whatever the caller
 * read moments earlier, so a phone setting `groceries` would silently restore its stale
 * `watch` over a choice the tablet made in between: two devices, one surviving answer, no
 * conflict anywhere to notice. Document paths make those two writes independent.
 */
export async function patchProfile(
  userId: string,
  patch: PatchUserInput,
  updatedAt: string,
): Promise<User | undefined> {
  const nested = await applyProfileUpdate(userId, nestedSlotUpdate(patch, updatedAt));
  if (nested.applied) return nested.profile;

  /**
   * The condition failed and no slot was in play, so the only thing it can have been is
   * `attribute_exists(pk)`: there is no profile. That is the caller's `404`.
   */
  if (!touchesSlots(patch)) throw nested.conflict;

  /**
   * A **legacy profile with no slot map**. A document path cannot be written into an
   * attribute that does not exist, so the map is created holding exactly the slots this
   * patch sets — one key, usually — under a condition that makes it a create rather than an
   * overwrite. `attribute_not_exists` means there are no sibling slots to lose, which is the
   * property the whole-map ban exists to protect; slots this patch clears are simply absent
   * from the new map, which is what clearing them means.
   */
  const created = await applyProfileUpdate(
    userId,
    createdSlotMapUpdate(patch, updatedAt),
  );
  if (created.applied) return created.profile;

  /**
   * Lost the race: another device created the map between the two attempts. Now the document
   * path is writable, so the nested operation is retried — and it applies **only** this
   * patch's slots, leaving whatever the concurrent creator chose for the others.
   *
   * Three attempts is provably enough. If the profile exists, the first failure says the map
   * was absent and the second says it is now present; nothing in the product removes the map
   * as a whole — a slot is cleared one document path at a time — so it cannot vanish again
   * and this attempt's condition holds. If the profile does not exist, all three fail on
   * `attribute_exists(pk)` and the caller gets its `404`.
   */
  const retried = await applyProfileUpdate(userId, nestedSlotUpdate(patch, updatedAt));
  if (retried.applied) return retried.profile;
  throw retried.conflict;
}

/** Whether this patch names any slot at all; `{}` names none and needs no map. */
function touchesSlots(patch: PatchUserInput): boolean {
  return Object.values(patch.defaultLists ?? {}).some((value) => value !== undefined);
}

interface ProfileUpdate {
  readonly expression: string;
  readonly names: Record<string, string>;
  readonly values: Record<string, unknown>;
  readonly condition: string;
}

type ProfileUpdateResult =
  | { readonly applied: true; readonly profile: User | undefined }
  | { readonly applied: false; readonly conflict: unknown };

/**
 * One attempt. A failed condition is an answer here rather than an error — which of the two
 * conditions failed is what {@link patchProfile} decides next from — so it is returned;
 * anything else is a real storage failure and propagates untouched.
 */
async function applyProfileUpdate(
  userId: string,
  update: ProfileUpdate,
): Promise<ProfileUpdateResult> {
  try {
    const profile = await updateItem<User & Record<string, unknown>>(
      userProfile(userId),
      update,
    );
    return { applied: true, profile: profile as User | undefined };
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return { applied: false, conflict: error };
    }
    throw error;
  }
}

/** `updatedAt` plus every patched field except the slot map, which the two builders own. */
function scalarClauses(patch: PatchUserInput, updatedAt: string) {
  const sets: string[] = ['#updatedAt = :updatedAt'];
  const removes: string[] = [];
  const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':updatedAt': updatedAt };

  for (const [field, value] of Object.entries(patch)) {
    if (field === 'defaultLists') continue;
    names[`#${field}`] = field;
    if (value === null) {
      removes.push(`#${field}`);
      continue;
    }
    sets.push(`#${field} = :${field}`);
    values[`:${field}`] = value;
  }

  return { sets, removes, names, values };
}

function expressionOf(sets: readonly string[], removes: readonly string[]): string {
  return [
    `SET ${sets.join(', ')}`,
    removes.length > 0 ? `REMOVE ${removes.join(', ')}` : undefined,
  ]
    .filter((clause): clause is string => clause !== undefined)
    .join(' ');
}

/**
 * The ordinary shape: one document path per supplied slot, and the map itself never assigned.
 *
 * The condition requires the parent map for **any** slot in the patch, not only for a slot
 * being set. A clear against a profile that has no map is a no-op either way, but failing the
 * condition routes it through the create below, so one branch handles every absent-map case
 * rather than two behaviours that have to agree.
 */
function nestedSlotUpdate(patch: PatchUserInput, updatedAt: string): ProfileUpdate {
  const { sets, removes, names, values } = scalarClauses(patch, updatedAt);
  const conditions = ['attribute_exists(pk)'];

  for (const [slot, listId] of Object.entries(patch.defaultLists ?? {})) {
    if (listId === undefined) continue;
    names['#defaultLists'] = 'defaultLists';
    names[`#slot_${slot}`] = slot;
    if (listId === null) {
      removes.push(`#defaultLists.#slot_${slot}`);
      continue;
    }
    sets.push(`#defaultLists.#slot_${slot} = :slot_${slot}`);
    values[`:slot_${slot}`] = listId;
  }

  if ('#defaultLists' in names) conditions.push('attribute_exists(#defaultLists)');

  return {
    expression: expressionOf(sets, removes),
    names,
    values,
    condition: conditions.join(' AND '),
  };
}

/**
 * The legacy-profile shape: create the map holding this patch's set slots, and only while
 * there is no map to overwrite.
 *
 * This is the one place a whole-map `SET` is correct, and `attribute_not_exists` is what
 * makes it so — there are no siblings to lose. A patch that only clears slots creates no map
 * at all: it lands its other fields and leaves the profile exactly as slot-less as it was.
 */
function createdSlotMapUpdate(patch: PatchUserInput, updatedAt: string): ProfileUpdate {
  const { sets, removes, names, values } = scalarClauses(patch, updatedAt);
  const map = Object.fromEntries(
    Object.entries(patch.defaultLists ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== null && entry[1] !== undefined,
    ),
  );

  names['#defaultLists'] = 'defaultLists';
  if (Object.keys(map).length > 0) {
    sets.push('#defaultLists = :defaultLists');
    values[':defaultLists'] = map;
  }

  return {
    expression: expressionOf(sets, removes),
    names,
    values,
    condition: 'attribute_exists(pk) AND attribute_not_exists(#defaultLists)',
  };
}

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

/**
 * The conditional transaction item that clears `defaultLists[slot]` when — and only when —
 * that exact slot still points at the list being removed (phase-03 §P3-05, §P3-09's slot
 * change, §P3-12).
 *
 * A **nested** `REMOVE`, never a whole-map `SET`, so sibling slots survive whatever else is
 * happening to them. The condition re-asserts the value the caller read: a newer destination
 * chosen concurrently on another device fails this item rather than being silently removed,
 * and the caller retries its transaction without it.
 *
 * **It lives here, and there is exactly one of it.** §P3-12 puts the `defaultLists`
 * invariants in `services/listSlotService.ts`, and the decision half of them is there — which
 * slot a list write may clear, and why the write attempts it unconditionally. This half
 * cannot follow: it builds a DynamoDB update over the profile key, so it belongs to the
 * repository layer (`CLAUDE.md`, `repo-structure.md` §3.1), and both callers are inside
 * `listRepository`, which a service may not be imported by. The service names this function
 * as the single implementation instead of copying it.
 */
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
