import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { duplicateActivity } from '../services/activityService.js';

/**
 * `POST /v1/activities/:id/duplicate` (`api-contract.md` §2.3, `activities.md` §7.1).
 *
 * Copies `objectKind`, title, type, details, location and notes — and nothing else. Schedule,
 * reminders, participants, expenses, attachments, prep children, lists and completion state
 * are all left behind, each for a reason `activities.md` records as a decision. The copy is
 * owned by the caller and carries no relationship to the original.
 *
 * `201`, because it creates. Its registry entry carries `creates`, so `idempotency` requires
 * an `Idempotency-Key` — the case that flag exists for, since a retried duplicate is the one
 * request where "it worked but I did not hear back" produces two identical activities and no
 * way to tell which is which.
 *
 * The title comes back suffixed ` (copy)`; the client opens the copy in the edit state so the
 * user can rename it before it settles (`activities.md` §7.1). No body is read — there is
 * nothing to send, and accepting fields here would be a second create path.
 */
export const DUPLICATE_ACTIVITY_PATH = '/:id/duplicate';

export async function duplicateActivityHandler(
  c: Context<AppEnv, typeof DUPLICATE_ACTIVITY_PATH>,
): Promise<Response> {
  const copy = await duplicateActivity(
    requireUserId(c),
    c.req.param('id'),
    new Date().toISOString(),
  );

  return c.json(
    {
      data: copy,
      meta: { requestId: c.get('requestId') },
    },
    201,
  );
}
