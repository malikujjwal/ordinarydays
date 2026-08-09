import type { PatchUserInput } from '@od/shared/types';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { patchMe } from '../services/userService.js';
import { toUser } from './toUser.js';

/**
 * `PATCH /v1/me` (`api-contract.md` §2.1).
 *
 * The body has already been validated against `patchUserInput` by the route's `zValidator`,
 * which is **strict** — a field the endpoint does not accept is a `400` naming it rather than
 * a silent no-op. `email`, `cognitoSub` and `onboardingState` belong to the auth flow, and a
 * client that tried to set one should be told, not ignored.
 */
export async function patchMeHandler(
  c: Context<AppEnv>,
  patch: PatchUserInput,
  now: string,
): Promise<Response> {
  const profile = await patchMe(requireUserId(c), patch, now, c.get('logger'));

  return c.json({
    data: toUser(profile),
    meta: { requestId: c.get('requestId') },
  });
}
