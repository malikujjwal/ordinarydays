import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { removeActivity } from '../services/activityService.js';

/**
 * `DELETE /v1/activities/:id` (`api-contract.md` §2.3).
 *
 * Owner only. A participant gets `403` — they can see the plan and are being told they may
 * not delete it — and anyone else gets `404`, which is also what an activity that does not
 * exist returns, so a guessed id confirms nothing.
 *
 * `200` with the envelope rather than `204`, per the convention P1-08 recorded in
 * `api-contract.md` §1: every response carries `{ data, meta }` and a `204` has no body to
 * carry one in. `data` names the id that is gone.
 *
 * **Safe to call twice.** The removal batches rather than transacting — a partition with many
 * participants and updates exceeds a transaction's 100 items — so a partial failure is
 * expected to be finished by a retry. The second call finds nothing and answers `404`, which
 * is the honest report rather than a crash (P1-14).
 *
 * The prep tasks survive, with their `parentActivityId` cleared. That happens in the service,
 * before anything is removed; this handler has no cascade in it and should not grow one.
 */
export const DELETE_ACTIVITY_PATH = '/:id';

export async function deleteActivityHandler(
  c: Context<AppEnv, typeof DELETE_ACTIVITY_PATH>,
): Promise<Response> {
  const activityId = await removeActivity(
    requireUserId(c),
    c.req.param('id'),
    new Date().toISOString(),
  );

  return c.json({
    data: { activityId },
    meta: { requestId: c.get('requestId') },
  });
}
