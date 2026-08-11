import { reminder as reminderSchema } from '@od/shared/schemas';
import type { Reminder } from '@od/shared/types';
import { queryAll } from './base.js';
import { reminderPrefix } from './keys.js';
import type { StoredItem } from './migrate.js';

/** Reads one caller's reminders on one Activity; no other prefix can enter this result. */
export async function listForUser(
  activityId: string,
  userId: string,
): Promise<Reminder[]> {
  const prefix = reminderPrefix(activityId, userId);
  const rows = await queryAll<StoredItem>(
    { pk: prefix.pk },
    { skPrefix: prefix.skPrefix },
  );
  return rows.map((row) => reminderSchema.parse(row));
}
