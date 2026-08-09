import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { getMe } from '../services/userService.js';
import { toUser } from './toUser.js';

/**
 * `GET /v1/me` (`api-contract.md` §2.1).
 *
 * **There is no local branch anywhere in this path**, which is the point of P1-01's seam:
 * `identity` resolved `usr_local_dev`, this reads whatever `c.get('userId')` says, the
 * repository loads that profile, and the response is that profile. In Phase 4 the same three
 * lines serve a Cognito subject. Local mode returning the seeded dev profile rather than a
 * `401` falls out of the seam; it is not special-cased.
 */
export async function getMeHandler(c: Context<AppEnv>): Promise<Response> {
  const profile = await getMe(requireUserId(c), c.get('logger'));

  return c.json({
    data: toUser(profile),
    meta: { requestId: c.get('requestId') },
  });
}
