import type { SkipActivityInput } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { skipActivity } from '../services/completionService.js';
import { idempotentJson } from './idempotentResponse.js';

export const SKIP_ACTIVITY_PATH = '/:id/skip';

export async function skipActivityHandler(
  c: Context<AppEnv, typeof SKIP_ACTIVITY_PATH>,
  input: SkipActivityInput,
  now: string,
): Promise<Response> {
  return idempotentJson(c, 200, async (receiptFor) =>
    skipActivity(requireUserId(c), c.req.param('id'), input, now, receiptFor),
  );
}
