import type { PatchUserInput, User } from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { getProfile, patchProfile } from '../repositories/userRepository.js';

/**
 * The profile behind `GET`/`PATCH /v1/me` (P1-07).
 *
 * Thin, because there is genuinely one rule here: **a missing profile is `404`**, and the
 * message says nothing about how to fix it locally. The same code path serves a Phase 4 user
 * whose post-confirmation trigger failed, and a production error must not describe a
 * developer workflow. The hint goes in the log line, where it helps on a laptop and is
 * invisible to a user.
 */

const NOT_FOUND = 'Profile not found.';

/**
 * Logged, never returned. `warn` rather than `error`: on a laptop this is the ordinary
 * "you have not run the seed script yet" case, and paging on it would be noise.
 */
function warnMissing(log: Logger | undefined, userId: string): void {
  log?.warn(
    { userId },
    'no profile for this user — run `pnpm seed:local` locally, or check the post-confirmation trigger',
  );
}

export async function getMe(userId: string, log?: Logger): Promise<User> {
  const profile = await getProfile(userId);
  if (profile === undefined) {
    warnMissing(log, userId);
    throw new AppError('not_found', NOT_FOUND);
  }
  return profile;
}

/**
 * Applies a validated patch and returns the stored profile.
 *
 * `now` is a parameter rather than a `Date.now()` call, so `updatedAt` is assertable without
 * freezing the clock (`coding-standards.md` §4.3).
 */
export async function patchMe(
  userId: string,
  patch: PatchUserInput,
  now: string,
  log?: Logger,
): Promise<User> {
  try {
    const updated = await patchProfile(userId, patch, now);
    if (updated === undefined) {
      warnMissing(log, userId);
      throw new AppError('not_found', NOT_FOUND);
    }
    return updated;
  } catch (error) {
    /**
     * The conditional write's failure means the row is not there. Mapped to the same `404`
     * the read produces, rather than left to `errorHandler`'s DynamoDB table, which turns a
     * `ConditionalCheckFailedException` into `409 conflict` — a status that would tell the
     * client to resolve a concurrent edit against a profile that does not exist.
     */
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      warnMissing(log, userId);
      throw new AppError('not_found', NOT_FOUND);
    }
    throw error;
  }
}
