import { MAX_UNRESOLVED_UPLOADS } from '@od/shared/constants';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';
import { IdempotencyRaceError, type IdempotencyReceipt } from '../lib/idempotency.js';
import { deleteItem, getItem, query, updateItem } from './base.js';
import { receiptItem } from './idempotencyRepository.js';
import {
  pendingUpload as pendingUploadKey,
  pendingUploadPrefix,
  pendingUploadQuotaSlot,
} from './keys.js';
import type { StoredItem } from './migrate.js';
import { TransactionBuilder, transactWrite } from './tx.js';

/**
 * The caller's durable pending-upload records — `USER#<userId>` / the upload prefix
 * (`data-model.md` §3.2, §4.3c, access pattern 6b).
 *
 * ## Why this row exists at all
 *
 * An attachment is written across two stores, and a crash between them has to be
 * discoverable. This record is what makes it so: it is written before a URL is issued, marked
 * `confirming` before any permanent copy, and consumed by the transaction that writes the
 * `Attachment` row. Every crash point therefore leaves evidence a later request can act on,
 * rather than an object in a bucket that nothing in the database has ever heard of.
 *
 * ## Why the shape is not in `packages/shared`
 *
 * It is internal, and §4.3c says so. The client never sees a `tmpKey`, a `finalKey` or a
 * `state`; publishing them as a schema would make an implementation detail a contract that
 * the next change to the state machine breaks. `Attachment` — what a caller does see — is
 * shared, and is P3-22's.
 */

const ENTITY = 'PendingUpload';

const SCHEMA_VERSION = 1;

/**
 * A new attachment id — `att_` plus a ULID (`data-model.md` §8).
 *
 * `monotonicFactory`, not the bare `ulid()`, for the reason `newDeviceId` records: ids minted
 * in the same millisecond otherwise break the tie with random bits and sort arbitrarily. Here
 * that matters twice over, because this ULID is also the object key's filename — two uploads
 * started in one tick must not be able to produce the same key.
 */
const nextUlid = monotonicFactory();

export function newAttachmentId(): string {
  return `att_${nextUlid()}`;
}

/**
 * The ULID inside an attachment id, which is the object key's filename.
 *
 * Derived rather than carried alongside, so the id and the key can never name different
 * objects — a pair of stored values could drift, and one confirmation reading the wrong half
 * would copy somebody's picture over somebody else's key.
 */
export function attachmentUlid(attachmentId: string): string {
  return attachmentId.slice('att_'.length);
}

/**
 * The stored row (`data-model.md` §4.3c).
 *
 * `activityId` is absent until confirmation names a target, which is the whole reason this
 * row is keyed by the uploader: at the moment it is written there is no Activity to key it
 * under, and there may never be one.
 */
export interface PendingUpload {
  readonly attachmentId: string;
  readonly userId: string;
  readonly tmpKey: string;
  readonly finalKey: string;
  readonly contentType: 'image/jpeg' | 'image/png' | 'image/heic' | 'image/webp';
  readonly byteSize: number;
  readonly state: 'awaiting_upload' | 'confirming';
  readonly activityId?: string;
  readonly createdAt: string;
  readonly cleanupAfter: string;
  /** Internal fixed slot used to enforce the unresolved-upload cap atomically. */
  readonly quotaSlot?: number;
}

/**
 * The row parser. Local, and the only Zod in this file.
 *
 * A stored row is `unknown` at this boundary however confident we are that we wrote it, and
 * `state` in particular drives what the drain does to an object — casting it would mean an
 * unreadable row silently became `awaiting_upload` and had its temporary object deleted
 * underneath an in-flight confirmation.
 */
const storedPendingUpload = z.object({
  attachmentId: z.string().min(1),
  userId: z.string().min(1),
  tmpKey: z.string().min(1),
  finalKey: z.string().min(1),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/heic', 'image/webp']),
  byteSize: z.number().int().positive(),
  state: z.enum(['awaiting_upload', 'confirming']),
  activityId: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  cleanupAfter: z.string().min(1),
  quotaSlot: z
    .number()
    .int()
    .min(0)
    .max(MAX_UNRESOLVED_UPLOADS - 1)
    .optional(),
});

/**
 * Rebuilt field by field from the parsed row rather than handed back whole, so that
 * `activityId` is **absent** when it is absent instead of present-and-undefined —
 * `exactOptionalPropertyTypes` keeps those apart, and the drain reads the difference. It is
 * also the same rule every projection in this codebase follows: a stored row carries `pk`,
 * `sk` and `entity` alongside the domain fields, and naming the fields is what keeps a future
 * storage attribute from arriving on a caller by accident.
 */
function toPendingUpload(row: StoredItem): PendingUpload {
  const parsed = storedPendingUpload.parse(row);
  return {
    attachmentId: parsed.attachmentId,
    userId: parsed.userId,
    tmpKey: parsed.tmpKey,
    finalKey: parsed.finalKey,
    contentType: parsed.contentType,
    byteSize: parsed.byteSize,
    state: parsed.state,
    ...(parsed.activityId === undefined ? {} : { activityId: parsed.activityId }),
    createdAt: parsed.createdAt,
    cleanupAfter: parsed.cleanupAfter,
    ...(parsed.quotaSlot === undefined ? {} : { quotaSlot: parsed.quotaSlot }),
  };
}

/** A concurrent request claimed the selected quota slot before this transaction committed. */
export class PendingUploadSlotUnavailableError extends Error {
  constructor() {
    super('The selected pending-upload quota slot is no longer available.');
    this.name = 'PendingUploadSlotUnavailableError';
  }
}

/**
 * Writes the record, optionally with the idempotency receipt in the same transaction.
 *
 * **The receipt and the record commit together or not at all**, which is what stops a replay
 * being answered with a URL for a record that was never stored. It is a transaction for that
 * one reason: the domain half is a single `Put` and would otherwise need none.
 *
 * The condition is `attribute_not_exists(pk)` — a fresh ULID cannot collide, so this asserts
 * it rather than trusting it. A failure here is a bug in id generation, not a user error.
 */
export async function putPendingUpload(
  record: PendingUpload,
  idempotencyReceipt?: IdempotencyReceipt,
): Promise<void> {
  const item: StoredItem = {
    ...pendingUploadKey(record.userId, record.attachmentId),
    entity: ENTITY,
    attachmentId: record.attachmentId,
    userId: record.userId,
    tmpKey: record.tmpKey,
    finalKey: record.finalKey,
    contentType: record.contentType,
    byteSize: record.byteSize,
    state: record.state,
    ...(record.activityId === undefined ? {} : { activityId: record.activityId }),
    createdAt: record.createdAt,
    cleanupAfter: record.cleanupAfter,
    ...(record.quotaSlot === undefined ? {} : { quotaSlot: record.quotaSlot }),
    schemaVersion: SCHEMA_VERSION,
  };

  const builder = new TransactionBuilder(
    'putPendingUpload',
    idempotencyReceipt === undefined ? 0 : 1,
  ).add({ Put: { Item: item, ConditionExpression: 'attribute_not_exists(pk)' } });
  const slotIndex = record.quotaSlot === undefined ? undefined : builder.length;
  if (record.quotaSlot !== undefined) {
    builder.add({
      Put: {
        Item: {
          ...pendingUploadQuotaSlot(record.userId, record.quotaSlot),
          entity: 'PendingUploadQuotaSlot',
          attachmentId: record.attachmentId,
          userId: record.userId,
          quotaSlot: record.quotaSlot,
          createdAt: record.createdAt,
          updatedAt: record.createdAt,
          schemaVersion: SCHEMA_VERSION,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    });
  }
  const receiptIndex = builder.length;
  if (idempotencyReceipt !== undefined) {
    builder.addReserved(receiptItem(idempotencyReceipt));
  }

  await transactWrite(builder.build(), {
    operation: 'putPendingUpload',
    onConditionFailed: (index) => {
      if (index === slotIndex) return new PendingUploadSlotUnavailableError();
      return idempotencyReceipt !== undefined && index === receiptIndex
        ? new IdempotencyRaceError()
        : undefined;
    },
  });
}

/**
 * Every unresolved record this user holds (access pattern 6b).
 *
 * `Limit` is the cap itself, not the cap plus one. Twenty rows coming back means "at least
 * twenty", which is all a caller enforcing the cap needs to know — and because the cap is
 * what stops a twenty-first from ever being written, there is nothing beyond the page to
 * miss. It returns no cursor for the same reason: a bounded set has no next page.
 *
 * **Strongly consistent.** The read decides whether to delete an object and whether to refuse
 * the request, and an eventually consistent page can omit a record written seconds ago — the
 * single most likely case, since a client that just uploaded is a client about to upload
 * again.
 */
export async function listPendingUploads(userId: string): Promise<PendingUpload[]> {
  const prefix = pendingUploadPrefix(userId);
  const page = await query<StoredItem>(
    { pk: prefix.pk },
    {
      skPrefix: prefix.skPrefix,
      limit: MAX_UNRESOLVED_UPLOADS,
      consistentRead: true,
    },
  );
  return page.items.map(toPendingUpload);
}

/**
 * One record by id, or `undefined` (P3-22).
 *
 * **Strongly consistent, and the tenancy check is the key itself.** The partition is the
 * caller's, so another user's `attachmentId` addresses a row that does not exist here and
 * confirmation answers `404` without ever comparing an owner field — there is no ownership
 * field to compare and no way to compare the wrong one.
 */
export async function getPendingUpload(
  userId: string,
  attachmentId: string,
): Promise<PendingUpload | undefined> {
  const row = await getItem<StoredItem>(pendingUploadKey(userId, attachmentId), {
    consistentRead: true,
  });
  return row === undefined ? undefined : toPendingUpload(row);
}

/**
 * Records the target Activity and marks the record `confirming` — **before any permanent
 * copy** (`api-contract.md` §2.6, P3-22).
 *
 * This write is the entire reason a crash after the copy is recoverable. Once it lands, the
 * row names both the object about to be created and the Activity it was meant for, so a
 * later drain can finish the link or delete both keys. Without it, a copy that succeeded and
 * a transaction that did not would leave a permanent object no row has ever referred to.
 *
 * ## The condition, and why it accepts one `confirming` case
 *
 * `awaiting_upload` is the ordinary transition. A row **already** `confirming` for the *same*
 * Activity is a retry of this same operation resuming, so it is accepted and the write is a
 * no-op in substance. A row `confirming` for a *different* Activity is refused: the object is
 * mid-flight toward somewhere else, and re-pointing it would abandon the first target's
 * copy with nothing left recording where it went.
 */
export async function markPendingConfirming(
  userId: string,
  attachmentId: string,
  activityId: string,
): Promise<void> {
  await updateItem(pendingUploadKey(userId, attachmentId), {
    expression: 'SET #state = :confirming, #activityId = :activityId',
    names: { '#state': 'state', '#activityId': 'activityId' },
    values: {
      ':confirming': 'confirming',
      ':activityId': activityId,
      ':awaiting': 'awaiting_upload',
    },
    condition:
      'attribute_exists(pk) AND (#state = :awaiting OR (#state = :confirming AND #activityId = :activityId))',
  });
}

/**
 * Removes one record.
 *
 * Unconditional, deliberately. The drain deletes the temporary object first and then the row;
 * if the row has already gone — two requests draining concurrently — both wanted the same
 * outcome and both got it. A conditional delete would turn that race into an error on a
 * request that had nothing to do with it.
 */
export async function deletePendingUpload(
  userId: string,
  attachmentId: string,
  quotaSlot?: number,
): Promise<void> {
  if (quotaSlot === undefined) {
    await deleteItem(pendingUploadKey(userId, attachmentId));
    return;
  }

  await transactWrite(
    new TransactionBuilder('deletePendingUpload')
      .add(
        { Delete: { Key: pendingUploadKey(userId, attachmentId) } },
        { Delete: { Key: pendingUploadQuotaSlot(userId, quotaSlot) } },
      )
      .build(),
    { operation: 'deletePendingUpload' },
  );
}
