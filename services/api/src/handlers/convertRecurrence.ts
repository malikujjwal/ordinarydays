import type { ConvertRecurrenceInput } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { convertRecurrence } from '../services/activityService.js';
import { idempotentJson } from './idempotentResponse.js';

export const CONVERT_RECURRENCE_PATH = '/:id/recurrence/convert';

/** Atomic "Does not repeat" conversion for one explicitly selected occurrence. */
export async function convertRecurrenceHandler(
  c: Context<AppEnv, typeof CONVERT_RECURRENCE_PATH>,
  input: ConvertRecurrenceInput,
  now: string,
): Promise<Response> {
  return idempotentJson(c, 200, (receiptFor) =>
    convertRecurrence(requireUserId(c), c.req.param('id'), input, now, (activity) =>
      receiptFor(activity),
    ),
  );
}
