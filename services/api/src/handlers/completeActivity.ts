import type { CompleteActivityInput } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { completeActivity } from '../services/completionService.js';
import { idempotentJson } from './idempotentResponse.js';

export const COMPLETE_ACTIVITY_PATH = '/:id/complete';

export async function completeActivityHandler(
  c: Context<AppEnv, typeof COMPLETE_ACTIVITY_PATH>,
  input: CompleteActivityInput,
  now: string,
): Promise<Response> {
  return idempotentJson(c, 200, async (receiptFor) =>
    completeActivity(requireUserId(c), c.req.param('id'), input, now, receiptFor),
  );
}
