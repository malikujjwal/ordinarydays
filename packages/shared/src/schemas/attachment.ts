import { z } from 'zod';
import { MAX_UPLOAD_BYTES } from '../constants.js';
import { ulidId } from './common.js';

/**
 * The upload half of attachments (`api-contract.md` §2.6, P3-21).
 *
 * **`Attachment` itself is not here.** The stored row and its response shape belong to
 * P3-22, which is what writes one. Nor is `PendingUpload`: that record is internal
 * cross-store confirmation state (`data-model.md` §4.3c), the client never sees it, and a
 * shared schema for it would publish an implementation detail as a contract.
 */

export const attachmentId = ulidId('att');

/**
 * The four image types an attachment may be.
 *
 * A closed enum rather than a `image/*` pattern, because every one of these has to be
 * something the viewer, the thumbnailer and CloudFront can all handle, and because the value
 * is bound into a signature — the store enforces exactly what was declared here, so an
 * unbounded set would be an unbounded set of things that can be permanently stored.
 *
 * `image/heic` is on the list because the iOS camera produces it and the client does not
 * transcode (P3-40). Leaving it off would mean every photo taken in the app failed.
 */
export const uploadContentType = z.enum([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
]);

/**
 * `POST /v1/attachments/upload-url`. **Strict**, so a field this endpoint does not accept is
 * a `400` naming it rather than a silent no-op.
 *
 * Both fields are **declarations**, and the point of the endpoint is that declaring is
 * binding: they are signed into the URL, so a client that says `image/png` and 2 MB cannot
 * then upload something else. That is why `byteSize` is required rather than inferred — there
 * is nothing to infer from, the bytes never reach this service, and a cap the API could only
 * check after the fact would not be a cap.
 *
 * The most useful field to reject loudly is `attachmentId`: a client that sent one would be
 * asking to choose its own object key, and the key is the whole of the secret under which
 * media is served (ADR-023).
 */
export const requestUploadUrlInput = z
  .strictObject({
    contentType: uploadContentType,
    /**
     * Exact bytes. Positive, so a zero-length declaration cannot reserve a record and a key
     * for an object that could never be a picture.
     */
    byteSize: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  })
  .meta({ id: 'RequestUploadUrlInput' });

/**
 * What the caller gets back: the id to confirm under, the URL to `PUT` to, and the key that
 * URL writes to.
 *
 * `key` is the **temporary** one — `tmp/u/<userId>/<ulid>.<ext>` — because that is what this
 * URL addresses. Confirmation copies it to the permanent key and the `Attachment` row it
 * writes carries that (P3-22). Neither is ever a URL: media is served by unguessable key
 * (ADR-023) and nothing this service stores or returns names a host.
 */
export const requestUploadUrlResult = z
  .object({
    attachmentId,
    uploadUrl: z.string().url(),
    key: z.string().min(1),
  })
  .meta({ id: 'RequestUploadUrlResult' });

export type UploadContentType = z.infer<typeof uploadContentType>;
export type RequestUploadUrlInput = z.infer<typeof requestUploadUrlInput>;
export type RequestUploadUrlResult = z.infer<typeof requestUploadUrlResult>;
