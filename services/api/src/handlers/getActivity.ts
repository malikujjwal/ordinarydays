import type { ActivityDetailQuery } from '@od/shared/schemas';
import type { ActivityDetailTarget } from '@od/shared/types';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { getActivityDetail } from '../services/activityService.js';

/**
 * `GET /v1/activities/:id` (`api-contract.md` §2.3).
 *
 * ## The response is an object of named collections, not a bare Activity
 *
 * `ActivityDetail` is `{ activity, reminders }` in Phase 1. The contract describes the full
 * shape as activity + participants + expenses + updates + attachments + children + the
 * caller's own reminders + date suggestions; six of those eight have no schema, no key
 * builder and no row anywhere yet. Each **is added as its phase lands** rather than changing
 * the envelope, which is the whole reason this is an object rather than the activity itself:
 * a client written against Phase 1 keeps working when P6-xx adds `participants`.
 *
 * ## The one rule that is not visible here
 *
 * `reminders` is the **caller's own**, always. Every participant's reminder rows live in the
 * partition this reads, so returning what was read would hand one user another user's
 * reminders — a leak nobody would notice, because you cannot see what is missing from your
 * own response (`security-privacy.md` §1 row 15). The filter is in `projectDetail`, one
 * layer down, because it is a projection policy rather than a route concern (P1-10 rule 6);
 * this handler could not apply it even if it wanted to, which is the point.
 *
 * A caller with no relationship to the activity gets `404`, never `403`, so a guessed id
 * cannot confirm that an activity exists.
 */
export const GET_ACTIVITY_PATH = '/:id';

export async function getActivityHandler(
  c: Context<AppEnv, typeof GET_ACTIVITY_PATH>,
  query: ActivityDetailQuery,
  now: string,
): Promise<Response> {
  const activityId = c.req.param('id');
  const target: ActivityDetailTarget =
    query.occurrenceDate === undefined
      ? { kind: 'activity', activityId }
      : { kind: 'occurrence', activityId, date: query.occurrenceDate };
  const detail = await getActivityDetail(requireUserId(c), target, now);

  return c.json({
    data: detail,
    meta: { requestId: c.get('requestId') },
  });
}
