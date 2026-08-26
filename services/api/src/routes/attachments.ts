import { zValidator } from '@hono/zod-validator';
import { confirmAttachmentInput, requestUploadUrlInput } from '@od/shared/schemas';
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import {
  ACTIVITY_ATTACHMENT_PATH,
  ACTIVITY_ATTACHMENTS_PATH,
  confirmAttachmentHandler,
  deleteAttachmentHandler,
} from '../handlers/activityAttachments.js';
import {
  requestUploadUrlHandler,
  UPLOAD_URL_PATH,
} from '../handlers/requestUploadUrl.js';

/**
 * Attachments, mounted at `/v1/attachments` (`api-contract.md` §2.6, P3-21).
 *
 * Two mount points, one file. `upload-url` is the step that has **no Activity yet**, so it
 * lives under `/v1/attachments`; confirming and deleting are authorised by the plan that owns
 * the image, so they mount under `/v1/activities` (P3-22). Keeping both here rather than
 * splitting the second pair into `activities.ts` keeps §2.6 readable as one thing — the same
 * reason `updates.ts` owns the feed's three routes while mounting on the activity prefix.
 *
 * Every entry is registered in `ROUTE_REGISTRY`; app construction throws otherwise.
 */

/**
 * The **strict** body, with the explicit failure hook `me.ts` records: `zValidator`'s default
 * answers with its own shape, which is not the contract envelope and never reaches
 * `errorHandler`, so a client would get a `400` with no `error.code` and no `requestId`.
 *
 * Strictness matters more here than on most bodies. Both fields are declarations that get
 * **signed into a URL**, so anything the schema lets through unchecked becomes something the
 * store will then enforce on the client's behalf — and the field most worth rejecting loudly
 * is one that is not here at all: a caller-supplied `attachmentId` or `key` would be a caller
 * choosing the object key that media is served under.
 */
const validateRequestUploadUrl = zValidator('json', requestUploadUrlInput, (result) => {
  if (!result.success) throw result.error;
});

/**
 * The confirm body: one id, **strict**, because everything else about the attachment was
 * decided when the URL was issued and is recorded on the caller's pending record. A body
 * offering `key`, `contentType` or `byteSize` would be offering to contradict the declaration
 * the store already enforced.
 */
const validateConfirm = zValidator('json', confirmAttachmentInput, (result) => {
  if (!result.success) throw result.error;
});

export const attachments = new Hono<AppEnv>().post(
  UPLOAD_URL_PATH,
  validateRequestUploadUrl,
  (c) => requestUploadUrlHandler(c, c.req.valid('json'), new Date().toISOString()),
);

/**
 * Confirming and deleting, mounted on the activity prefix.
 *
 * The ids are not validated against their ULID schemas, for the reason `activities.ts`
 * records: a malformed id resolves to no row and already answers `404`, and checking first
 * would split one user-visible fact — "there is no such attachment on this plan for you" —
 * into two statuses.
 */
export const activityAttachments = new Hono<AppEnv>()
  .post(ACTIVITY_ATTACHMENTS_PATH, validateConfirm, (c) =>
    confirmAttachmentHandler(c, c.req.valid('json'), new Date().toISOString()),
  )
  .delete(ACTIVITY_ATTACHMENT_PATH, (c) =>
    deleteAttachmentHandler(c, new Date().toISOString()),
  );
