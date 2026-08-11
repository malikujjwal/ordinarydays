import type { ReminderInput } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import {
  createReminder,
  listReminders,
  removeReminder,
} from '../services/reminderService.js';
import { idempotentJson } from './idempotentResponse.js';

export const REMINDERS_PATH = '/:id/reminders';
export const REMINDER_PATH = '/:id/reminders/:reminderId';

export async function listRemindersHandler(
  c: Context<AppEnv, typeof REMINDERS_PATH>,
): Promise<Response> {
  const reminders = await listReminders(requireUserId(c), c.req.param('id'));
  return c.json({ data: reminders, meta: { requestId: c.get('requestId') } });
}

export async function createReminderHandler(
  c: Context<AppEnv, typeof REMINDERS_PATH>,
  input: ReminderInput,
  now: string,
): Promise<Response> {
  return idempotentJson(c, 201, async (receiptFor) =>
    createReminder(requireUserId(c), c.req.param('id'), input, now, (result) =>
      receiptFor(result),
    ),
  );
}

export async function deleteReminderHandler(
  c: Context<AppEnv, typeof REMINDER_PATH>,
): Promise<Response> {
  const reminderId = await removeReminder(
    requireUserId(c),
    c.req.param('id'),
    c.req.param('reminderId'),
  );
  return c.json({ data: { reminderId }, meta: { requestId: c.get('requestId') } });
}
