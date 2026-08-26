import type { PlansQuery } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { getPlans } from '../services/plansService.js';

/** `GET /v1/plans` (`api-contract.md` §2.2a). */
export const PLANS_PATH = '/';

export async function getPlansHandler(
  c: Context<AppEnv, typeof PLANS_PATH>,
  query: PlansQuery,
  now: string,
): Promise<Response> {
  const data = await getPlans(requireUserId(c), query, now);
  return c.json({ data, meta: { requestId: c.get('requestId') } });
}
