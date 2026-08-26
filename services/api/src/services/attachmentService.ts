import {
  MAX_UNRESOLVED_UPLOADS,
  PENDING_UPLOAD_CLEANUP_DAYS,
} from '@od/shared/constants';
import type { RequestUploadUrlInput, RequestUploadUrlResult } from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import type { IdempotencyReceipt } from '../lib/idempotency.js';
import type { Logger } from '../lib/logger.js';
import { deleteObject, finalObjectKey, presignUpload, tmpObjectKey } from '../lib/s3.js';
import {
  attachmentUlid,
  deletePendingUpload,
  listPendingUploads,
  newAttachmentId,
  type PendingUpload,
  putPendingUpload,
} from '../repositories/pendingUploadRepository.js';

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
 * Drains the caller's unresolved records, and answers how many are still live.
 *
 * ## What it collects, and what it deliberately leaves
 *
 * An **expired `awaiting_upload`** record is an upload that was offered and never completed:
 * its URL lapsed minutes after it was issued and its temporary object, if any, is now
 * unreachable by anything. Its object goes first and then its row, in that order — the row is
 * the only record of the object's existence, so removing it first would strand the object
 * until the bucket's lifecycle rule caught it.
 *
 * A **`confirming`** record is a permanent copy that may already have happened. Completing or
 * cleaning one requires reading the target Activity and finishing a transaction, which is
 * P3-22's confirm path; until that lands this function leaves the row alone and counts it as
 * live. That is the safe direction: an untouched row is work still discoverable, whereas a
 * row deleted by a function that could not finish its work would leave exactly the
 * undiscoverable permanent orphan the record exists to prevent.
 *
 * An **unexpired `awaiting_upload`** record is a URL the client may still be uploading to.
 *
 * ## Why a request pays for this
 *
 * There is no worker and no Stream in this phase, so the caller's own next request is the
 * only thing that reliably runs. It is bounded — at most {@link MAX_UNRESOLVED_UPLOADS} rows
 * — which is precisely what the cap buys.
 *
 * A failure reaching the store propagates rather than being swallowed. The alternative is to
 * delete the row anyway and let the lifecycle rule collect the object, which trades a visible
 * failure for an invisible one; and an endpoint whose entire output is a URL to that same
 * store has nothing useful to answer when it cannot be reached.
 */
export async function drainPendingUploads(
  userId: string,
  nowMs: number,
  log?: Logger,
): Promise<number> {
  const records = await listPendingUploads(userId);
  let live = 0;

  for (const record of records) {
    if (record.state !== 'awaiting_upload' || Date.parse(record.cleanupAfter) > nowMs) {
      live += 1;
      continue;
    }

    await deleteObject(record.tmpKey);
    await deletePendingUpload(userId, record.attachmentId);
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
 * new key (P3-40 step 5). An expired URL is a retry; a duplicate record is a leak.
 */
export async function requestUploadUrl(
  userId: string,
  input: RequestUploadUrlInput,
  now: string,
  options: RequestUploadUrlOptions = {},
): Promise<RequestUploadUrlResult> {
  const nowMs = Date.parse(now);

  const live = await drainPendingUploads(userId, nowMs, options.log);
  if (live >= MAX_UNRESOLVED_UPLOADS) {
    throw new AppError('validation_failed', TOO_MANY_PENDING, [
      { path: 'attachmentId', message: TOO_MANY_PENDING },
    ]);
  }

  const attachmentId = newAttachmentId();
  const ulid = attachmentUlid(attachmentId);

  const record: PendingUpload = {
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

  await putPendingUpload(record, options.receiptFor?.(result));

  return result;
}
