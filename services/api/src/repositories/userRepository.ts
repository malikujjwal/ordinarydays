import type { PatchUserInput, User } from '@od/shared/types';
import { monotonicFactory } from 'ulid';
import { getItem, updateItem } from './base.js';
import { userProfile } from './keys.js';

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
