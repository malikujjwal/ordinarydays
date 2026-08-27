import { MAX_ATTACHMENTS_PER_ACTIVITY } from '@od/shared/constants';
import { attachment as attachmentSchema } from '@od/shared/schemas';
import type { Attachment } from '@od/shared/types';
import { z } from 'zod';
import { IdempotencyRaceError, type IdempotencyReceipt } from '../lib/idempotency.js';
import { deleteItem, getItem, query } from './base.js';
import { receiptItem } from './idempotencyRepository.js';
import {
  activityMeta,
  attachmentDeletion as attachmentDeletionKey,
  attachmentDeletionPrefix,
  attachment as attachmentKey,
  attachmentPrefix,
  attachmentQuotaSlot,
  pendingUpload as pendingUploadKey,
  pendingUploadQuotaSlot,
} from './keys.js';
import type { StoredItem } from './migrate.js';
import type { PendingUpload } from './pendingUploadRepository.js';
import { TransactionBuilder, transactWrite } from './tx.js';

/**
 * The linked attachment rows in an Activity's partition (`data-model.md` §3.1, §4.3c, P3-22).
 *
 * Separate from `activityRepository.ts` for the reason `activityUpdateRepository.ts` is: an
 * attachment is a subordinate row with its own lifecycle, its own cap and its own cross-store
 * story, and folding four more methods into the file that already owns the Activity, its
 * index, its schedule and its cascade makes that file the place every phase edits at once.
 *
 * ## The two writes here are the two halves of one guarantee
 *
 * {@link linkAttachment} creates the row and **consumes the pending record in the same
 * transaction**, so the durable evidence of an in-flight copy disappears exactly when the
 * thing it was evidence for becomes real. {@link unlinkAttachment} removes the row and clears
 * the cover in the same transaction, so the hero can never point at nothing.
 *
 * Neither touches `updatedAt` or `lastActivityAt` except where the Activity's own
 * `primaryAttachmentId` actually changes — see {@link unlinkAttachment}.
 */

const ENTITY = 'Attachment';

const SCHEMA_VERSION = 1;

/** Parses a stored row into the domain shape, dropping every storage attribute. */
export function toAttachment(row: unknown): Attachment {
  return attachmentSchema.parse(row) as Attachment;
}

export type StoredAttachment = Attachment & { readonly quotaSlot?: number };

function toStoredAttachment(row: StoredItem): StoredAttachment {
  const attachment = toAttachment(row);
  const quotaSlot = z
    .number()
    .int()
    .min(0)
    .max(MAX_ATTACHMENTS_PER_ACTIVITY - 1)
    .optional()
    .parse(row.quotaSlot);
  return {
    ...attachment,
    ...(quotaSlot === undefined ? {} : { quotaSlot }),
  };
}

function attachmentItem(record: Attachment, quotaSlot: number): StoredItem {
  return {
    ...attachmentKey(record.activityId, record.attachmentId),
    entity: ENTITY,
    attachmentId: record.attachmentId,
    activityId: record.activityId,
    key: record.key,
    contentType: record.contentType,
    byteSize: record.byteSize,
    createdAt: record.createdAt,
    quotaSlot,
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * Every attachment on one activity (access pattern 4).
 *
 * `Limit` is the model's cap, not a page size, so this is the **whole** collection and
 * returns no cursor. The confirm path is what keeps that true: it refuses a 21st.
 *
 * **Strongly consistent.** Two callers need it to be. The cap check must not let a 21st
 * through because an eventually consistent read missed the 20th, and a client that has just
 * confirmed an attachment and reopened the plan must see it — a detail read that came back
 * without it would look exactly like the confirmation having failed.
 */
export async function listAttachments(activityId: string): Promise<Attachment[]> {
  return (await listStoredAttachments(activityId)).map(
    ({ quotaSlot: _slot, ...row }) => row,
  );
}

/** Internal collection including the quota slot that must be released on unlink. */
export async function listStoredAttachments(
  activityId: string,
): Promise<StoredAttachment[]> {
  const prefix = attachmentPrefix(activityId);
  const page = await query<StoredItem>(
    { pk: prefix.pk },
    {
      skPrefix: prefix.skPrefix,
      limit: MAX_ATTACHMENTS_PER_ACTIVITY,
      consistentRead: true,
    },
  );
  return page.items.map(toStoredAttachment);
}

/** One attachment by id, or `undefined`. Strongly consistent for the same two reasons. */
export async function getAttachment(
  activityId: string,
  attachmentId: string,
): Promise<Attachment | undefined> {
  const row = await getItem<StoredItem>(attachmentKey(activityId, attachmentId), {
    consistentRead: true,
  });
  return row === undefined ? undefined : toAttachment(row);
}

/** Internal exact read including the fixed quota slot. */
export async function getStoredAttachment(
  activityId: string,
  attachmentId: string,
): Promise<StoredAttachment | undefined> {
  const row = await getItem<StoredItem>(attachmentKey(activityId, attachmentId), {
    consistentRead: true,
  });
  return row === undefined ? undefined : toStoredAttachment(row);
}

export class AttachmentAlreadyLinkedError extends Error {
  constructor() {
    super('The attachment was linked by another request.');
    this.name = 'AttachmentAlreadyLinkedError';
  }
}

export class AttachmentSlotUnavailableError extends Error {
  constructor() {
    super('The selected attachment quota slot is no longer available.');
    this.name = 'AttachmentSlotUnavailableError';
  }
}

export class ActivityUnavailableForAttachmentError extends Error {
  constructor() {
    super('The Activity is unavailable for attachment changes.');
    this.name = 'ActivityUnavailableForAttachmentError';
  }
}

export interface LinkAttachmentOptions {
  readonly pendingUpload: Pick<PendingUpload, 'attachmentId' | 'quotaSlot'>;
  readonly quotaSlot: number;
  readonly idempotencyReceipt?: IdempotencyReceipt;
}

/**
 * **The transaction the whole cross-store state machine turns on** (`api-contract.md` §2.6).
 *
 * Two items, and they must be atomic in both directions:
 *
 * - the `ATT#` row, conditioned on **not already existing**, so a retry that raced with
 *   itself cannot write a second row for one id;
 * - the delete of the caller's pending record, which is the durable note saying "an object
 *   may exist at the permanent key and nothing references it yet".
 *
 * Committing the row without consuming the record would leave a `confirming` row whose drain
 * would later try to complete a link that already exists. Consuming the record without the
 * row would strand the permanent object with nothing left pointing at it — the undiscoverable
 * orphan the record was written to prevent. Only together do they mean what they say.
 *
 * The temporary object is deleted **after** this returns, never in it: S3 is not part of the
 * transaction, and a delete issued first would destroy the source of a copy this may yet roll
 * back.
 */
export async function linkAttachment(
  userId: string,
  record: Attachment,
  options: LinkAttachmentOptions,
): Promise<void> {
  const builder = new TransactionBuilder(
    'linkAttachment',
    options.idempotencyReceipt === undefined ? 0 : 1,
  ).add(
    {
      Put: {
        Item: attachmentItem(record, options.quotaSlot),
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    {
      Put: {
        Item: {
          ...attachmentQuotaSlot(record.activityId, options.quotaSlot),
          entity: 'AttachmentQuotaSlot',
          attachmentId: record.attachmentId,
          activityId: record.activityId,
          quotaSlot: options.quotaSlot,
          schemaVersion: SCHEMA_VERSION,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    {
      ConditionCheck: {
        Key: activityMeta(record.activityId),
        ConditionExpression:
          'attribute_exists(pk) AND #ownerId = :userId AND attribute_not_exists(#deletingAt)',
        ExpressionAttributeNames: {
          '#ownerId': 'ownerId',
          '#deletingAt': 'deletingAt',
        },
        ExpressionAttributeValues: { ':userId': userId },
      },
    },
    { Delete: { Key: pendingUploadKey(userId, record.attachmentId) } },
  );
  if (options.pendingUpload.quotaSlot !== undefined) {
    builder.add({
      Delete: { Key: pendingUploadQuotaSlot(userId, options.pendingUpload.quotaSlot) },
    });
  }
  const receiptIndex = builder.length;
  if (options.idempotencyReceipt !== undefined) {
    builder.addReserved(receiptItem(options.idempotencyReceipt));
  }

  await transactWrite(builder.build(), {
    operation: 'linkAttachment',
    onConditionFailed: (index) => {
      if (index === 0) return new AttachmentAlreadyLinkedError();
      if (index === 1) return new AttachmentSlotUnavailableError();
      if (index === 2) return new ActivityUnavailableForAttachmentError();
      return options.idempotencyReceipt !== undefined && index === receiptIndex
        ? new IdempotencyRaceError()
        : undefined;
    },
  });
}

export interface AttachmentDeletion {
  readonly userId: string;
  readonly activityId: string;
  readonly attachmentId: string;
  readonly key: string;
  readonly coverCleared: boolean;
  readonly createdAt: string;
}

const storedAttachmentDeletion = z.object({
  userId: z.string().min(1),
  activityId: z.string().min(1),
  attachmentId: z.string().min(1),
  key: z.string().min(1),
  coverCleared: z.boolean(),
  createdAt: z.string().min(1),
});

function toAttachmentDeletion(row: StoredItem): AttachmentDeletion {
  return storedAttachmentDeletion.parse(row);
}

export async function getAttachmentDeletion(
  userId: string,
  activityId: string,
  attachmentId: string,
): Promise<AttachmentDeletion | undefined> {
  const row = await getItem<StoredItem>(
    attachmentDeletionKey(userId, activityId, attachmentId),
    { consistentRead: true },
  );
  return row === undefined ? undefined : toAttachmentDeletion(row);
}

export async function listAttachmentDeletions(
  userId: string,
): Promise<AttachmentDeletion[]> {
  const prefix = attachmentDeletionPrefix(userId);
  const page = await query<StoredItem>(
    { pk: prefix.pk },
    {
      skPrefix: prefix.skPrefix,
      limit: MAX_ATTACHMENTS_PER_ACTIVITY,
      consistentRead: true,
    },
  );
  return page.items.map(toAttachmentDeletion);
}

export async function completeAttachmentDeletion(
  work: Pick<AttachmentDeletion, 'userId' | 'activityId' | 'attachmentId'>,
): Promise<void> {
  await deleteItem(
    attachmentDeletionKey(work.userId, work.activityId, work.attachmentId),
  );
}

export class AttachmentCoverChangedError extends Error {
  constructor() {
    super('The Activity cover changed while the attachment was being removed.');
    this.name = 'AttachmentCoverChangedError';
  }
}

/**
 * Removes the row and, when this attachment is the cover, clears `primaryAttachmentId` in the
 * **same** write (P3-22 rule 4).
 *
 * ## Why the cover clear is conditional rather than unconditional
 *
 * `clearCover` comes from the META the service read, and the `Update` re-states that reading
 * as a condition on the exact field: `primaryAttachmentId = :attachmentId`. If a concurrent
 * `PATCH` moved the cover in between, the condition fails, the whole transaction is cancelled
 * and nothing is deleted — which is the right outcome, because the service's next attempt
 * reads fresh META and discovers the cover is no longer this attachment's to clear.
 *
 * ## Why neither timestamp moves when the cover is untouched
 *
 * An attachment is a subordinate row, like a posted update. `updatedAt` backs `If-Match`, so
 * bumping it would `409` an unrelated open edit sheet — the exact failure the two-timestamp
 * split exists to prevent (`data-model.md` §3.5). `lastActivityAt` sorts Needs-a-date and is
 * bumped by "anything that means this plan is being **discussed**" — RSVPs, posted updates,
 * added expenses. An owner attaching their own photo is not discussion, and floating their
 * plan up that list would be a behaviour change no product doc asks for.
 *
 * Clearing the cover **is** a change to a field on the Activity itself, so that write moves
 * `updatedAt` and nothing else: the row a client is holding no longer describes the row that
 * exists, and `If-Match` is how it finds out.
 */
export async function unlinkAttachment(
  userId: string,
  record: StoredAttachment,
  /**
   * Present exactly when this attachment is the cover. `now` is a parameter and not a clock
   * read: `coding-standards.md` §4.3 bans an implicit clock inside anything that has to be
   * testable, and the service already holds the request's instant.
   */
  clearCover: boolean,
  now: string,
): Promise<AttachmentDeletion> {
  const { activityId, attachmentId } = record;
  const builder = new TransactionBuilder('unlinkAttachment').add({
    Delete: {
      Key: attachmentKey(activityId, attachmentId),
      ConditionExpression: 'attribute_exists(pk)',
    },
  });

  if (record.quotaSlot !== undefined) {
    builder.add({ Delete: { Key: attachmentQuotaSlot(activityId, record.quotaSlot) } });
  }

  const activityConditionIndex = builder.length;
  if (clearCover) {
    builder.add({
      Update: {
        Key: activityMeta(activityId),
        UpdateExpression: 'REMOVE #primaryAttachmentId SET #updatedAt = :now',
        ConditionExpression:
          '#ownerId = :userId AND #primaryAttachmentId = :attachmentId AND attribute_not_exists(#deletingAt)',
        ExpressionAttributeNames: {
          '#ownerId': 'ownerId',
          '#primaryAttachmentId': 'primaryAttachmentId',
          '#updatedAt': 'updatedAt',
          '#deletingAt': 'deletingAt',
        },
        ExpressionAttributeValues: {
          ':userId': userId,
          ':attachmentId': attachmentId,
          ':now': now,
        },
      },
    });
  } else {
    builder.add({
      ConditionCheck: {
        Key: activityMeta(activityId),
        ConditionExpression:
          '#ownerId = :userId AND attribute_not_exists(#deletingAt) AND (attribute_not_exists(#primaryAttachmentId) OR #primaryAttachmentId <> :attachmentId)',
        ExpressionAttributeNames: {
          '#ownerId': 'ownerId',
          '#deletingAt': 'deletingAt',
          '#primaryAttachmentId': 'primaryAttachmentId',
        },
        ExpressionAttributeValues: {
          ':userId': userId,
          ':attachmentId': attachmentId,
        },
      },
    });
  }

  const work: AttachmentDeletion = {
    userId,
    activityId,
    attachmentId,
    key: record.key,
    coverCleared: clearCover,
    createdAt: now,
  };
  builder.add({
    Put: {
      Item: {
        ...attachmentDeletionKey(userId, activityId, attachmentId),
        entity: 'AttachmentDeletion',
        ...work,
        schemaVersion: SCHEMA_VERSION,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    },
  });

  await transactWrite(builder.build(), {
    operation: 'unlinkAttachment',
    onConditionFailed: (index) =>
      index === activityConditionIndex ? new AttachmentCoverChangedError() : undefined,
  });
  return work;
}
