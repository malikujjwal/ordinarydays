import {
  MAX_ATTACHMENTS_PER_ACTIVITY,
  MAX_UNRESOLVED_UPLOADS,
  PENDING_UPLOAD_CLEANUP_DAYS,
} from '@od/shared/constants';
import { instant } from '@od/shared/schemas';
import type {
  Attachment,
  DeletedAttachment,
  RequestUploadUrlInput,
  RequestUploadUrlResult,
} from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import type { IdempotencyReceipt } from '../lib/idempotency.js';
import type { Logger } from '../lib/logger.js';
import {
  copyObject,
  deleteObject,
  finalObjectKey,
  headObject,
  presignUpload,
  tmpObjectKey,
} from '../lib/s3.js';
import { getActivityMeta } from '../repositories/activityRepository.js';
import {
  ActivityUnavailableForAttachmentError,
  AttachmentAlreadyLinkedError,
  AttachmentCoverChangedError,
  type AttachmentDeletion,
  AttachmentSlotUnavailableError,
  completeAttachmentDeletion,
  getAttachment,
  getAttachmentDeletion,
  getStoredAttachment,
  linkAttachment,
  listActivityAttachmentDeletions,
  listAttachmentDeletions,
  listStoredAttachments,
  recordLinkedAttachmentReceipt,
  unlinkAttachment,
} from '../repositories/attachmentRepository.js';
import {
  attachmentUlid,
  deletePendingUpload,
  getPendingUpload,
  listPendingUploads,
  markPendingConfirming,
  newAttachmentId,
  type PendingUpload,
  PendingUploadSlotUnavailableError,
  putPendingUpload,
} from '../repositories/pendingUploadRepository.js';
import { assertActivityAccess } from './authz.js';

/**
 * Issuing an upload URL, and draining what earlier ones left behind (P3-21).
 *
 * ## The one rule the whole design turns on
 *
 * **Bytes never pass through this process.** The API signs a URL; the client `PUT`s to the
 * store directly. Uploading through the function would burn duration and hit the 6 MB payload
 * limit — and the declared type and size would then be checked by code that could be talked
 * out of it, rather than by a signature the store refuses to accept a variation of.
 *
 * ## And the one it is careful about
 *
 * Nothing here asks where it is running. The endpoint, the path style and the credentials
 * differ between a laptop and a deployment; the code does not, which is why the integration
 * tests exercising this against MinIO are exercising the deployed path
 * (`phase-03-plans-and-lists.md`, the MinIO risk row).
 */

const PENDING_UPLOAD_CLEANUP_MS = PENDING_UPLOAD_CLEANUP_DAYS * 24 * 60 * 60 * 1000;

/**
 * User-facing copy for the cap, in the house form for a limit: it says the number and what to
 * do, and it never names a record type the user has no word for.
 */
const TOO_MANY_PENDING =
  `You have ${MAX_UNRESOLVED_UPLOADS} uploads still finishing. ` +
  'Finish or cancel one and try again.';

/** A stable event code a Log Insights query can filter on (`definition-of-done.md` §8 rule 2). */
const DRAINED = 'pending_upload_drained';

/** The other two outcomes the drain can reach, each worth being able to count. */
const REPAIRED = 'pending_upload_repaired';
const ABANDONED = 'pending_upload_abandoned';
const TMP_DELETE_FAILED = 'attachment_tmp_delete_failed';
const MEDIA_DELETE_REPAIRED = 'attachment_delete_repaired';

/**
 * The one answer for every way an id fails to become an attachment.
 *
 * Deliberately says nothing about **which** way. "There is no such pending upload", "the
 * object was never uploaded", "it arrived with the wrong type" and "the temporary object has
 * expired" are four states a caller cannot act on differently: the recovery for all of them
 * is to upload again. Distinguishing them in copy would also describe the caller's own
 * storage back to them one probe at a time.
 */
const UNCONFIRMABLE = 'That upload is no longer available. Choose the image again.';

const TOO_MANY_ATTACHMENTS =
  `This plan already has ${MAX_ATTACHMENTS_PER_ACTIVITY} images. ` +
  'Remove one and try again.';

const COVER_NOT_LINKED = 'That image is not on this plan.';

const ATTACHMENT_NOT_FOUND = 'Attachment not found.';

function unconfirmable(path: string): AppError {
  return new AppError('validation_failed', UNCONFIRMABLE, [
    { path, message: UNCONFIRMABLE },
  ]);
}

/** Shared create/schedule mapping for a pending-row condition lost at commit time. */
export function unconfirmableAttachments(): AppError {
  return unconfirmable('attachmentIds');
}

function availableQuotaSlot(
  rows: readonly { readonly quotaSlot?: number }[],
  cap: number,
): number | undefined {
  const occupied = new Set(
    rows
      .map((row) => row.quotaSlot)
      .filter((slot): slot is number => slot !== undefined && slot >= 0 && slot < cap),
  );
  let legacyRows = rows.filter((row) => row.quotaSlot === undefined).length;
  for (let slot = 0; slot < cap; slot += 1) {
    if (occupied.has(slot)) continue;
    if (legacyRows > 0) {
      legacyRows -= 1;
      continue;
    }
    return slot;
  }
  return undefined;
}

async function linkPendingAttachment(
  userId: string,
  record: PendingUpload,
  linkedRow: Attachment,
  idempotencyReceipt?: IdempotencyReceipt,
): Promise<Attachment> {
  for (let attempt = 0; attempt <= MAX_ATTACHMENTS_PER_ACTIVITY; attempt += 1) {
    const existing = await getAttachment(linkedRow.activityId, linkedRow.attachmentId);
    if (existing !== undefined) return existing;

    const attachments = await listStoredAttachments(linkedRow.activityId);
    const quotaSlot = availableQuotaSlot(attachments, MAX_ATTACHMENTS_PER_ACTIVITY);
    if (quotaSlot === undefined) {
      throw new AppError('validation_failed', TOO_MANY_ATTACHMENTS, [
        { path: 'attachmentId', message: TOO_MANY_ATTACHMENTS },
      ]);
    }

    try {
      await linkAttachment(userId, linkedRow, {
        pendingUpload: record,
        quotaSlot,
        ...(idempotencyReceipt === undefined ? {} : { idempotencyReceipt }),
      });
      return linkedRow;
    } catch (error) {
      if (error instanceof AttachmentSlotUnavailableError) continue;
      if (error instanceof AttachmentAlreadyLinkedError) {
        const winner = await getAttachment(linkedRow.activityId, linkedRow.attachmentId);
        if (winner !== undefined) return winner;
      }
      throw error;
    }
  }

  throw new AppError(
    'conflict',
    'This changed while the image was being attached. Try again.',
  );
}

/** Finishes durable confirmed-media deletes. S3 deletion is idempotent. */
export async function drainAttachmentDeletions(
  userId: string,
  log?: Logger,
): Promise<void> {
  for (const work of await listAttachmentDeletions(userId)) {
    await deleteObject(work.key);
    await completeAttachmentDeletion(work);
    log?.info(
      { event: MEDIA_DELETE_REPAIRED, userId, attachmentId: work.attachmentId },
      'attachment deletion completed after a crash',
    );
  }
}

/** Completes the durable media work belonging to one Activity before its META is removed. */
export async function drainActivityAttachmentDeletions(
  userId: string,
  activityId: string,
  log?: Logger,
): Promise<void> {
  let work: readonly AttachmentDeletion[];
  do {
    work = await listActivityAttachmentDeletions(userId, activityId);
    for (const deletion of work) {
      await deleteObject(deletion.key);
      await completeAttachmentDeletion(deletion);
      log?.info(
        { event: MEDIA_DELETE_REPAIRED, userId, attachmentId: deletion.attachmentId },
        'activity deletion removed confirmed media',
      );
    }
  } while (work.length > 0);
}

export interface RequestUploadUrlOptions {
  /**
   * Builds the replay receipt from the finished response.
   *
   * A callback rather than a prebuilt receipt, because the response contains three
   * server-decided values — the id, the URL and the key — and a receipt built before they
   * existed would store a body naming an attachment that was never written.
   */
  readonly receiptFor?: (result: RequestUploadUrlResult) => IdempotencyReceipt;
  /**
   * **Tests only.** The default is the contract's five minutes and nothing in production
   * passes anything else; it exists so expiry can be proven without waiting for it.
   */
  readonly expiresInSeconds?: number;
  readonly log?: Logger;
}

/**
 * Completes a `confirming` record, or cleans it up (P3-22).
 *
 * This is the repair half of the cross-store state machine, and it is what makes "a crash
 * after the copy cannot create an undiscoverable permanent orphan" true rather than hopeful.
 * The record names both the permanent key and the Activity the copy was meant for, so a later
 * request can always answer the only question that matters: **is there a home for this
 * object?**
 *
 * - The `ATT#` row already exists — the transaction committed and the crash was after it.
 *   Finish the part that was left: delete the temporary object, then the record.
 * - The Activity still exists and the permanent object landed — complete the link exactly as
 *   confirmation would have.
 * - The Activity is gone, or the copy never landed — there is nowhere for this object to
 *   belong. Delete **both** keys and only then the record, so the record outlives every
 *   object it knows about.
 *
 * Returns whether the record was resolved. An unresolved one stays live and is counted
 * against the cap, which is the safe direction: work still visible beats work deleted by
 * something that could not finish it.
 */
async function resolveConfirming(
  userId: string,
  record: PendingUpload,
  nowMs: number,
  log?: Logger,
): Promise<boolean> {
  const activityId = record.activityId;
  /**
   * A `confirming` row with no Activity recorded cannot exist — {@link markPendingConfirming}
   * writes both fields in one update — so this is a corrupt row rather than a state. Treat it
   * as unresolvable and leave it: deleting objects on the strength of a row that contradicts
   * its own invariant is exactly the wrong instinct.
   */
  if (activityId === undefined) return false;

  const existing = await getAttachment(activityId, record.attachmentId);
  if (existing !== undefined) {
    await deleteObject(record.tmpKey);
    await deletePendingUpload(userId, record.attachmentId, record.quotaSlot);
    log?.info(
      { event: REPAIRED, userId, attachmentId: record.attachmentId },
      'confirmation completed after a crash',
    );
    return true;
  }

  const activity = await getActivityMeta(activityId, { consistentRead: true });
  let copied = await headObject(record.finalKey);

  if (activity !== undefined && activity.ownerId === userId) {
    if (copied === undefined) {
      const uploaded = await headObject(record.tmpKey);
      if (
        uploaded !== undefined &&
        uploaded.contentType === record.contentType &&
        uploaded.byteSize === record.byteSize
      ) {
        try {
          await copyObject(record.tmpKey, record.finalKey);
        } catch (copyError) {
          /**
           * An active confirmation may have linked this same row and removed the temporary
           * source after our HeadObject. Adopt that winner instead of failing the unrelated
           * request which happened to run the repair drain.
           */
          const winner = await getAttachment(activityId, record.attachmentId);
          if (winner !== undefined) {
            await deleteObject(record.tmpKey);
            await deletePendingUpload(userId, record.attachmentId, record.quotaSlot);
            log?.info(
              { event: REPAIRED, userId, attachmentId: record.attachmentId },
              'confirmation completed while repair was copying',
            );
            return true;
          }
          copied = await headObject(record.finalKey);
          if (copied === undefined) throw copyError;
        }
        copied ??= await headObject(record.finalKey);
      }
    }

    if (
      copied !== undefined &&
      copied.contentType === record.contentType &&
      copied.byteSize === record.byteSize
    ) {
      try {
        await linkPendingAttachment(
          userId,
          record,
          toAttachmentRow(record, activity.activityId, new Date(nowMs).toISOString()),
        );
        await deleteObject(record.tmpKey);
        log?.info(
          { event: REPAIRED, userId, attachmentId: record.attachmentId },
          'confirmation completed after a crash',
        );
        return true;
      } catch (error) {
        if (
          !(error instanceof ActivityUnavailableForAttachmentError) &&
          !(error instanceof AppError && error.code === 'validation_failed')
        ) {
          throw error;
        }
      }
    }
  }

  /**
   * Both keys before the record, in that order and for the same reason the expired-upload
   * path uses it: the record is the only thing that knows these two keys exist, so removing
   * it first would strand whichever object the next failure left behind.
   */
  await deleteObject(record.finalKey);
  await deleteObject(record.tmpKey);
  await deletePendingUpload(userId, record.attachmentId, record.quotaSlot);
  log?.info(
    { event: ABANDONED, userId, attachmentId: record.attachmentId },
    'confirmation had no home and both keys were removed',
  );
  return true;
}

/**
 * The `Attachment` a pending record becomes once its copy is verified.
 *
 * `createdAt` is the **link** instant, not the record's: the attachment comes into existence
 * when it is confirmed onto a plan, and a row stamped with the moment its upload URL was
 * issued would claim to predate itself by up to a day. Ordering is unaffected either way —
 * `ATT#` rows sort by a ULID that already encodes upload time.
 */
function toAttachmentRow(
  record: PendingUpload,
  activityId: string,
  createdAt: string,
): Attachment {
  return {
    attachmentId: record.attachmentId,
    activityId,
    key: record.finalKey,
    contentType: record.contentType,
    byteSize: record.byteSize,
    createdAt: instant.parse(createdAt),
    schemaVersion: 1,
  };
}

/**
 * Drains the caller's unresolved records, and answers how many are still live.
 *
 * ## What it collects
 *
 * An **expired `awaiting_upload`** record is an upload that was offered and never completed:
 * its URL lapsed minutes after it was issued and its temporary object, if any, is now
 * unreachable by anything. Its object goes first and then its row, in that order — the row is
 * the only record of the object's existence, so removing it first would strand the object
 * until the bucket's lifecycle rule caught it.
 *
 * An **expired `confirming`** record is a permanent copy that may already have happened, and
 * is finished or cleaned by {@link resolveConfirming}. That path is P3-22's, and it is what
 * turns the crash window between the object store and the database from a leak into a state.
 *
 * An **unexpired `awaiting_upload`** record is work that may still be in flight, so it is left
 * alone and counted live. A `confirming` record is always safe to drive forward immediately:
 * the copy is idempotent and the transactional link converges concurrent attempts on the same
 * attachment to the already-linked winner.
 *
 * ## Why a request pays for this
 *
 * There is no worker and no Stream in this phase, so the caller's own next request is the
 * only thing that reliably runs. It is bounded — at most {@link MAX_UNRESOLVED_UPLOADS} rows
 * — which is precisely what the cap buys.
 *
 * A failure reaching the store propagates rather than being swallowed. The alternative is to
 * delete the row anyway and let the lifecycle rule collect the object, which trades a visible
 * failure for an invisible one.
 */
export async function drainPendingUploads(
  userId: string,
  nowMs: number,
  log?: Logger,
): Promise<number> {
  const records = await listPendingUploads(userId);
  let live = 0;

  for (const record of records) {
    if (record.state === 'confirming') {
      if (!(await resolveConfirming(userId, record, nowMs, log))) live += 1;
      continue;
    }

    if (Date.parse(record.cleanupAfter) > nowMs) {
      live += 1;
      continue;
    }

    await deleteObject(record.tmpKey);
    await deletePendingUpload(userId, record.attachmentId, record.quotaSlot);
    // `attachmentId` is a server-minted opaque id and carries nothing about the person or
    // the picture, so it is safe to log (`security-privacy.md` §3). The key is not logged:
    // it is the secret media is served under (ADR-023).
    log?.info(
      { event: DRAINED, userId, attachmentId: record.attachmentId },
      'expired pending upload removed',
    );
  }

  return live;
}

/**
 * `POST /v1/attachments/upload-url` (`api-contract.md` §2.6).
 *
 * The order is the contract's: **drain, then refuse or record, then answer.** Presigning
 * happens between the record being built and being written, and that is not a reordering —
 * it is pure local cryptography that makes no request, and the URL has to exist before the
 * transaction because the replay receipt stores the response. The record is committed before
 * the caller ever holds the URL.
 *
 * ## The replay this endpoint has, and what it costs
 *
 * Its registry entry is `mutates: true`, so a repeated `Idempotency-Key` replays the stored
 * body rather than minting a second id, a second key and a second record. The consequence
 * worth stating out loud: **a replay returns the URL that was originally issued, and that URL
 * may have expired.** That is the correct trade — the alternative is a retry silently
 * creating a second pending record for an upload the client thinks is one — and it is
 * recoverable, because a client that is told its URL has lapsed asks for a fresh one under a
 * new key (P3-41 step 5). An expired URL is a retry; a duplicate record is a leak.
 */
export async function requestUploadUrl(
  userId: string,
  input: RequestUploadUrlInput,
  now: string,
  options: RequestUploadUrlOptions = {},
): Promise<RequestUploadUrlResult> {
  const nowMs = Date.parse(now);

  await drainAttachmentDeletions(userId, options.log);
  await drainPendingUploads(userId, nowMs, options.log);
  let pending = await listPendingUploads(userId);
  if (pending.length >= MAX_UNRESOLVED_UPLOADS) {
    throw new AppError('validation_failed', TOO_MANY_PENDING, [
      { path: 'attachmentId', message: TOO_MANY_PENDING },
    ]);
  }

  const attachmentId = newAttachmentId();
  const ulid = attachmentUlid(attachmentId);

  const record: Omit<PendingUpload, 'quotaSlot'> = {
    attachmentId,
    userId,
    tmpKey: tmpObjectKey(userId, ulid, input.contentType),
    finalKey: finalObjectKey(userId, ulid, input.contentType),
    contentType: input.contentType,
    byteSize: input.byteSize,
    state: 'awaiting_upload',
    createdAt: now,
    cleanupAfter: new Date(nowMs + PENDING_UPLOAD_CLEANUP_MS).toISOString(),
  };

  const uploadUrl = await presignUpload({
    key: record.tmpKey,
    contentType: record.contentType,
    byteSize: record.byteSize,
    ...(options.expiresInSeconds === undefined
      ? {}
      : { expiresInSeconds: options.expiresInSeconds }),
  });

  const result: RequestUploadUrlResult = { attachmentId, uploadUrl, key: record.tmpKey };

  for (let attempt = 0; attempt <= MAX_UNRESOLVED_UPLOADS; attempt += 1) {
    const quotaSlot = availableQuotaSlot(pending, MAX_UNRESOLVED_UPLOADS);
    if (quotaSlot === undefined) {
      throw new AppError('validation_failed', TOO_MANY_PENDING, [
        { path: 'attachmentId', message: TOO_MANY_PENDING },
      ]);
    }
    try {
      await putPendingUpload({ ...record, quotaSlot }, options.receiptFor?.(result));
      return result;
    } catch (error) {
      if (!(error instanceof PendingUploadSlotUnavailableError)) throw error;
      pending = await listPendingUploads(userId);
    }
  }

  throw new AppError('conflict', 'Uploads changed while reserving space. Try again.');
}

/**
 * `POST /v1/activities/:id/attachments` — confirm an upload and link it
 * (`api-contract.md` §2.6, P3-22).
 *
 * ## The state machine, in the order the contract states it
 *
 * 1. Resolve the caller's pending record. **The key is the tenancy check**: the record lives
 *    in the caller's own partition, so another user's `attachmentId` resolves to `not_found`.
 * 2. `HeadObject` the temporary key against the declared type and length. The presigned
 *    `PUT` already bound both into its signature, so an object that exists there with those
 *    values is one this service authorised — and one that does not exist means the client
 *    never uploaded, or the one-day lifecycle rule collected it.
 * 3. **Record the target Activity and mark the record `confirming` — before any permanent
 *    copy.** This is the step that makes every later crash recoverable, and the reason it is
 *    third rather than first: there is no point recording a target for an object that was
 *    never uploaded.
 * 4. Copy to the permanent key, then `HeadObject` the destination. Verifying the copy rather
 *    than trusting it is what lets a retry tell "already copied" from "not copied yet".
 * 5. One transaction: write the row and consume the pending record.
 * 6. **Only then** delete the temporary object. It is the source of a copy that may still
 *    have to be repeated.
 *
 * ## Idempotent by resumption, not by luck
 *
 * A repeat starts at step 1 and finds whatever the last attempt left. An already-linked id
 * short-circuits at the top and returns the existing row — so a client that lost the
 * response, and a client whose crash was at step 5, both get the same answer. Step 3's
 * condition accepts a record already `confirming` **for this same Activity** and refuses one
 * confirming toward another, which is what stops a second target abandoning the first's copy.
 *
 * Owner-only (`plans-and-lists.md` §2.1 row 8). A stranger's activity id is `404` from
 * `assertActivityAccess` and never `403`.
 */
export interface ConfirmAttachmentOptions {
  /**
   * Builds the replay receipt from the finished row.
   *
   * Called on **both** paths, because it sets the response body and supplies the receipt each
   * successful mutating POST must commit. An already-linked id condition-checks the row it
   * adopted while storing that request's receipt, so a later delete cannot change its replay.
   */
  readonly receiptFor?: (attachment: Attachment) => IdempotencyReceipt;
  readonly log?: Logger;
}

async function finishPendingConfirmation(
  userId: string,
  record: PendingUpload,
  activityId: string,
  now: string,
  options: ConfirmAttachmentOptions,
): Promise<Attachment> {
  const linkedRow = toAttachmentRow(record, activityId, now);
  const prospectiveReceipt = options.receiptFor?.(linkedRow);
  const linked = await linkPendingAttachment(
    userId,
    record,
    linkedRow,
    prospectiveReceipt,
  );

  // A concurrent confirm can win after this request has precomputed its response receipt.
  // The loser adopts that canonical row and records its own response against it; this matters
  // when the two logical requests used distinct idempotency keys.
  if (linked !== linkedRow) {
    const receipt = options.receiptFor?.(linked);
    if (receipt !== undefined) await recordLinkedAttachmentReceipt(linked, receipt);
  }

  /**
   * Last, and its failure is not the caller's problem: the attachment exists and is linked.
   * A temporary object left behind is collected by the bucket's one-day lifecycle rule — the
   * one leak the design accepts, and the harmless one, because nothing references it.
   */
  await deleteObject(record.tmpKey).catch((error: unknown) => {
    options.log?.warn(
      { event: TMP_DELETE_FAILED, userId, attachmentId: record.attachmentId },
      error instanceof Error ? error.message : 'temporary object not removed',
    );
  });

  return linked;
}

export async function confirmAttachment(
  userId: string,
  activityId: string,
  attachmentId: string,
  now: string,
  options: ConfirmAttachmentOptions = {},
): Promise<Attachment> {
  await assertActivityAccess(userId, activityId, 'owner');

  /**
   * The already-linked answer, and it comes **first**.
   *
   * Re-confirming is not an error and must not depend on the pending record, which the
   * successful attempt consumed. Reading the row is also how a create carrying an
   * `attachmentIds` list stays idempotent across its own replay.
   */
  const existing = await getAttachment(activityId, attachmentId);
  if (existing !== undefined) {
    const receipt = options.receiptFor?.(existing);
    if (receipt !== undefined) await recordLinkedAttachmentReceipt(existing, receipt);
    return existing;
  }

  const record = await getPendingUpload(userId, attachmentId);
  if (record === undefined) throw new AppError('not_found', ATTACHMENT_NOT_FOUND);

  if (record.state === 'confirming') {
    if (record.activityId !== activityId) throw unconfirmable('attachmentId');
    const copied = await headObject(record.finalKey);
    if (
      copied !== undefined &&
      copied.contentType === record.contentType &&
      copied.byteSize === record.byteSize
    ) {
      return finishPendingConfirmation(userId, record, activityId, now, options);
    }
  }

  // Fast refusal avoids copying bytes when the bounded collection is already full. The
  // quota-slot Put in linkPendingAttachment remains the atomic authority for races.
  if ((await listStoredAttachments(activityId)).length >= MAX_ATTACHMENTS_PER_ACTIVITY) {
    throw new AppError('validation_failed', TOO_MANY_ATTACHMENTS, [
      { path: 'attachmentId', message: TOO_MANY_ATTACHMENTS },
    ]);
  }

  const uploaded = await headObject(record.tmpKey);
  if (
    uploaded === undefined ||
    uploaded.contentType !== record.contentType ||
    uploaded.byteSize !== record.byteSize
  ) {
    /**
     * The temporary object is **not** deleted here and the record is left alone. The client's
     * recovery is to upload again under a new id; this one expires into the drain, which is
     * the single place that removes an object, and having two removers is how one of them
     * eventually deletes something the other was still using.
     */
    throw unconfirmable('attachmentId');
  }

  await markPendingConfirming(userId, attachmentId, activityId);

  await copyObject(record.tmpKey, record.finalKey);
  const copied = await headObject(record.finalKey);
  if (copied === undefined) {
    /**
     * A copy that reported success and left nothing. The record is `confirming` by now, so
     * the drain owns it: it will complete the link if the object turns up, or delete both
     * keys if it does not. Failing loudly here is right — this is not a client error — but
     * the state is already durable either way.
     */
    throw new AppError('internal', 'An unexpected error occurred.');
  }

  return finishPendingConfirmation(userId, record, activityId, now, options);
}

/**
 * `DELETE /v1/activities/:id/attachments/:attachmentId` (P3-22 rule 4).
 *
 * Removes the row and the object, and **when this attachment is the cover, clears
 * `primaryAttachmentId` in the same write** — so there is no instant at which the hero points
 * at an attachment that is gone.
 *
 * The row goes before the object, which is the opposite order from the drain and right for
 * the opposite reason. Here the row is the *reference*: while it exists the image is
 * reachable and rendered, so removing it first means the worst interruption leaves an
 * unreferenced object for the lifecycle rule rather than a rendered hero whose bytes are
 * missing.
 *
 * Owner-only. A stranger's activity is `404`; so is an id that names no attachment on it.
 */
export async function deleteAttachment(
  userId: string,
  activityId: string,
  attachmentId: string,
  now: string,
): Promise<DeletedAttachment> {
  let access = await assertActivityAccess(userId, activityId, 'owner');
  let stored = await getStoredAttachment(activityId, attachmentId);

  if (stored === undefined) {
    const outstanding = await getAttachmentDeletion(userId, activityId, attachmentId);
    if (outstanding === undefined) throw new AppError('not_found', ATTACHMENT_NOT_FOUND);
    await deleteObject(outstanding.key);
    await completeAttachmentDeletion(outstanding);
    return { attachmentId, coverCleared: outstanding.coverCleared };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const isCover = access.activity.primaryAttachmentId === attachmentId;
    try {
      const work = await unlinkAttachment(userId, stored, isCover, now);
      await deleteObject(work.key);
      await completeAttachmentDeletion(work);
      return { attachmentId, coverCleared: work.coverCleared };
    } catch (error) {
      if (!(error instanceof AttachmentCoverChangedError)) throw error;
      access = await assertActivityAccess(userId, activityId, 'owner');
      const fresh = await getStoredAttachment(activityId, attachmentId);
      if (fresh === undefined) {
        const outstanding = await getAttachmentDeletion(userId, activityId, attachmentId);
        if (outstanding !== undefined) {
          await deleteObject(outstanding.key);
          await completeAttachmentDeletion(outstanding);
          return { attachmentId, coverCleared: outstanding.coverCleared };
        }
        throw new AppError('not_found', ATTACHMENT_NOT_FOUND);
      }
      stored = fresh;
    }
  }

  throw new AppError(
    'conflict',
    'The cover changed while the image was removed. Try again.',
  );
}

/**
 * Confirms and links several ids as part of a create (P3-22 rule 5).
 *
 * Used by `POST /v1/activities` and by the schedule bridge, which both accept
 * `attachmentIds`. Sequential rather than concurrent: each call reads the same bounded
 * collection to check the cap, and running them together would let a batch past a limit each
 * of them individually saw room for.
 *
 * **An unconfirmable id is `validation_failed`.** The Activity is already written by the time
 * this runs — it has to be, because an attachment row is keyed by the activity it belongs to
 * — so "writes nothing" is the caller's to deliver by undoing that write. See the callers.
 */
export async function confirmAttachments(
  userId: string,
  activityId: string,
  attachmentIds: readonly string[],
  now: string,
  options: { readonly log?: Logger } = {},
): Promise<Attachment[]> {
  const linked: Attachment[] = [];
  for (const attachmentId of attachmentIds) {
    linked.push(await confirmAttachment(userId, activityId, attachmentId, now, options));
  }
  return linked;
}

/**
 * Validates `primaryAttachmentId` against the activity's **own** rows (P3-22, the cover rule).
 *
 * `null` clears and needs no check. A value must name an attachment linked to this activity:
 * without that, a client could point the hero at an id it invented, or at a real attachment
 * on somebody else's plan — and the hero renders as a request for that key, which is the
 * whole of the access control on media (ADR-023).
 */
export async function assertCoverIsLinked(
  activityId: string,
  primaryAttachmentId: string | null | undefined,
): Promise<void> {
  if (primaryAttachmentId === undefined || primaryAttachmentId === null) return;

  const existing = await getAttachment(activityId, primaryAttachmentId);
  if (existing === undefined) {
    throw new AppError('validation_failed', COVER_NOT_LINKED, [
      { path: 'primaryAttachmentId', message: COVER_NOT_LINKED },
    ]);
  }
}

/**
 * Refuses a create whose `attachmentIds` cannot all be confirmed — **before** the Activity is
 * written (P3-22 rule 5).
 *
 * ## Why this is a separate precheck rather than a rollback
 *
 * An attachment row is keyed by the activity it belongs to, so linking cannot precede the
 * create; and "a create carrying an unconfirmable id is `validation_failed` and writes
 * nothing" is a promise about *client* errors — an id that was never uploaded, or whose
 * temporary object has expired. Every one of those is knowable without writing anything, so
 * this checks them all first and the create never starts.
 *
 * What is deliberately **not** covered by a rollback is the other failure: the copy or the
 * transaction failing after the Activity exists. That is a `500`, not a rejected request, and
 * it is already durable — the pending records are `confirming`, so the drain completes the
 * links against the Activity that now exists, and the create's own replay receipt answers the
 * client's retry with the response it lost. Compensating by deleting a just-created Activity
 * would turn a self-healing state into a destructive one.
 */
export async function assertAttachmentsConfirmable(
  userId: string,
  attachmentIds: readonly string[],
): Promise<void> {
  if (attachmentIds.length === 0) return;

  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw unconfirmable('attachmentIds');
  }

  for (const attachmentId of attachmentIds) {
    const record = await getPendingUpload(userId, attachmentId);
    if (record === undefined) throw new AppError('not_found', ATTACHMENT_NOT_FOUND);

    const uploaded = await headObject(record.tmpKey);
    if (
      uploaded === undefined ||
      uploaded.contentType !== record.contentType ||
      uploaded.byteSize !== record.byteSize
    ) {
      throw unconfirmable('attachmentIds');
    }
  }
}
