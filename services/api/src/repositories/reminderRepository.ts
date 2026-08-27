import { reminder as reminderSchema } from '@od/shared/schemas';
import type { Reminder } from '@od/shared/types';
import { IdempotencyRaceError, type IdempotencyReceipt } from '../lib/idempotency.js';
import { deleteItem, queryAll } from './base.js';
import { receiptItem } from './idempotencyRepository.js';
import { activityMeta, reminder as reminderKey, reminderPrefix } from './keys.js';
import type { StoredItem } from './migrate.js';
import { TransactionBuilder, transactWrite } from './tx.js';

const ENTITY = 'Reminder';
const SCHEMA_VERSION = 1;

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

/** Writes one caller-owned reminder and its successful replay receipt atomically. */
export async function createForUser(
  activityId: string,
  userId: string,
  reminder: Pick<Reminder, 'reminderId' | 'offsetMinutes' | 'channel'>,
  now: string,
  idempotencyReceipt: IdempotencyReceipt,
): Promise<void> {
  const builder = new TransactionBuilder('createReminder', 1).add(
    {
      Put: {
        Item: {
          ...reminderKey(activityId, userId, reminder.reminderId),
          entity: ENTITY,
          reminderId: reminder.reminderId,
          activityId,
          userId,
          offsetMinutes: reminder.offsetMinutes,
          channel: reminder.channel,
          createdAt: now,
          updatedAt: now,
          schemaVersion: SCHEMA_VERSION,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    {
      ConditionCheck: {
        Key: activityMeta(activityId),
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#deletingAt)',
        ExpressionAttributeNames: { '#deletingAt': 'deletingAt' },
      },
    },
  );
  const receiptIndex = builder.length;
  builder.addReserved(receiptItem(idempotencyReceipt));
  await transactWrite(builder.build(), {
    operation: 'createReminder',
    onConditionFailed: (index) =>
      index === receiptIndex ? new IdempotencyRaceError() : undefined,
  });
}

/**
 * Deletes only a row under this caller's reminder prefix.
 *
 * Another user's opaque reminder id addresses no item here and trips the same conditional as
 * a typo, so the service can return `404` without first reading anybody else's row.
 */
export async function deleteForUser(
  activityId: string,
  userId: string,
  reminderId: string,
): Promise<void> {
  await deleteItem(reminderKey(activityId, userId, reminderId), {
    expression: 'attribute_exists(pk)',
  });
}
