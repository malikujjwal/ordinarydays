import { MAX_ATTACHMENTS_PER_ACTIVITY } from '@od/shared/constants';
import { attachment as attachmentSchema } from '@od/shared/schemas';
import type { Attachment } from '@od/shared/types';
import { IdempotencyRaceError, type IdempotencyReceipt } from '../lib/idempotency.js';
import { getItem, query } from './base.js';
import { receiptItem } from './idempotencyRepository.js';
import {
  activityMeta,
  attachment as attachmentKey,
  attachmentPrefix,
  pendingUpload as pendingUploadKey,
} from './keys.js';
import type { StoredItem } from './migrate.js';
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

function attachmentItem(record: Attachment): StoredItem {
  return {
    ...attachmentKey(record.activityId, record.attachmentId),
    entity: ENTITY,
    attachmentId: record.attachmentId,
    activityId: record.activityId,
    key: record.key,
    contentType: record.contentType,
    byteSize: record.byteSize,
    createdAt: record.createdAt,
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
  const prefix = attachmentPrefix(activityId);
  const page = await query<StoredItem>(
    { pk: prefix.pk },
    {
      skPrefix: prefix.skPrefix,
      limit: MAX_ATTACHMENTS_PER_ACTIVITY,
      consistentRead: true,
    },
  );
  return page.items.map(toAttachment);
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
  idempotencyReceipt?: IdempotencyReceipt,
): Promise<void> {
  const builder = new TransactionBuilder(
    'linkAttachment',
    idempotencyReceipt === undefined ? 0 : 1,
  ).add(
    {
      Put: {
        Item: attachmentItem(record),
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    { Delete: { Key: pendingUploadKey(userId, record.attachmentId) } },
  );
  const receiptIndex = builder.length;
  if (idempotencyReceipt !== undefined) {
    builder.addReserved(receiptItem(idempotencyReceipt));
  }

  await transactWrite(builder.build(), {
    operation: 'linkAttachment',
    onConditionFailed: (index) =>
      idempotencyReceipt !== undefined && index === receiptIndex
        ? new IdempotencyRaceError()
        : undefined,
  });
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
  activityId: string,
  attachmentId: string,
  /**
   * Present exactly when this attachment is the cover. `now` is a parameter and not a clock
   * read: `coding-standards.md` §4.3 bans an implicit clock inside anything that has to be
   * testable, and the service already holds the request's instant.
   */
  clearCover?: { readonly now: string },
): Promise<void> {
  const builder = new TransactionBuilder('unlinkAttachment').add({
    Delete: {
      Key: attachmentKey(activityId, attachmentId),
      ConditionExpression: 'attribute_exists(pk)',
    },
  });

  if (clearCover !== undefined) {
    builder.add({
      Update: {
        Key: activityMeta(activityId),
        UpdateExpression: 'REMOVE #primaryAttachmentId SET #updatedAt = :now',
        ConditionExpression: '#primaryAttachmentId = :attachmentId',
        ExpressionAttributeNames: {
          '#primaryAttachmentId': 'primaryAttachmentId',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':attachmentId': attachmentId,
          ':now': clearCover.now,
        },
      },
    });
  }

  await transactWrite(builder.build(), { operation: 'unlinkAttachment' });
}
