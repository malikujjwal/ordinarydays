import { ianaTimezone, type ScheduleActivityInput } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { AppError } from '../lib/errors.js';
import { requireUserId } from '../middleware/identity.js';
import { scheduleActivity } from '../services/scheduleService.js';
import { idempotentJson } from './idempotentResponse.js';

export const SCHEDULE_ACTIVITY_PATH = '/:id/schedule';

export async function scheduleActivityHandler(
  c: Context<AppEnv, typeof SCHEDULE_ACTIVITY_PATH>,
  input: ScheduleActivityInput,
  now: string,
): Promise<Response> {
  const headerTimezone = c.req.header('X-Client-Timezone');
  const selected = input.timezone ?? headerTimezone ?? 'UTC';
  const parsed = ianaTimezone.safeParse(selected);
  if (!parsed.success) {
    throw new AppError('validation_failed', 'Timezone must be an IANA timezone.', [
      {
        path: input.timezone === undefined ? 'X-Client-Timezone' : 'timezone',
        message: 'Timezone must be an IANA timezone.',
      },
    ]);
  }

  return idempotentJson(c, 200, (receiptFor) =>
    scheduleActivity(
      requireUserId(c),
      c.req.param('id'),
      input,
      parsed.data,
      now,
      receiptFor,
    ),
  );
}
