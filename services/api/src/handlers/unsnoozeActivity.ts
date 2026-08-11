import type { UnsnoozeActivityInput } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { unsnoozeActivity } from '../services/completionService.js';
import { idempotentJson } from './idempotentResponse.js';

export const UNSNOOZE_ACTIVITY_PATH = '/:id/unsnooze';

export async function unsnoozeActivityHandler(
  c: Context<AppEnv, typeof UNSNOOZE_ACTIVITY_PATH>,
  input: UnsnoozeActivityInput,
  now: string,
): Promise<Response> {
  return idempotentJson(c, 200, async (receiptFor) =>
    unsnoozeActivity(requireUserId(c), c.req.param('id'), input, now, receiptFor),
  );
}
