import { zValidator } from '@hono/zod-validator';
import { requestUploadUrlInput } from '@od/shared/schemas';
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import {
  requestUploadUrlHandler,
  UPLOAD_URL_PATH,
} from '../handlers/requestUploadUrl.js';

/**
 * Attachments, mounted at `/v1/attachments` (`api-contract.md` §2.6, P3-21).
 *
 * One route today. The other two in §2.6 are activity-scoped — an attachment is confirmed
 * and deleted through the plan that owns it — so they mount under `/v1/activities` in P3-22
 * and this router keeps only the step that has no Activity yet.
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

export const attachments = new Hono<AppEnv>().post(
  UPLOAD_URL_PATH,
  validateRequestUploadUrl,
  (c) => requestUploadUrlHandler(c, c.req.valid('json'), new Date().toISOString()),
);
