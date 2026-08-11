import type { UncompleteActivityInput } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { uncompleteActivity } from '../services/completionService.js';
import { idempotentJson } from './idempotentResponse.js';

export const UNCOMPLETE_ACTIVITY_PATH = '/:id/uncomplete';

export async function uncompleteActivityHandler(
  c: Context<AppEnv, typeof UNCOMPLETE_ACTIVITY_PATH>,
  input: UncompleteActivityInput,
  now: string,
): Promise<Response> {
  return idempotentJson(c, 200, async (receiptFor) =>
    uncompleteActivity(requireUserId(c), c.req.param('id'), input, now, receiptFor),
  );
}
