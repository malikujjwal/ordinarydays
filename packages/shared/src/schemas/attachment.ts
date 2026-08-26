import { z } from 'zod';
import { MAX_UPLOAD_BYTES } from '../constants.js';
import { ulidId } from './common.js';

/**
 * The upload half of attachments (`api-contract.md` §2.6, P3-21).
 *
 * **`PendingUpload` is deliberately absent.** That record is internal cross-store
 * confirmation state (`data-model.md` §4.3c), the client never sees a `tmpKey`, a
 * `finalKey` or a `state`, and a shared schema for it would publish an implementation
 * detail as a contract the next change to the state machine breaks. `Attachment` — what a
 * caller does see — is here, transcribed from that same section.
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

/**
 * The linked attachment (`data-model.md` §4.3c), written by confirmation and read by plan
 * detail.
 *
 * **Transcribed, not designed.** §4.3c already defines this shape; `phase-03`'s P3-22 still
 * says the entity "has no §4 shape; add it", which was true when that task was written and
 * is not now. The stale line is noted in the pull request rather than acted on — adding a
 * second definition beside the existing one is exactly the drift the one-shape rule exists
 * to prevent.
 *
 * **`key`, never a URL, and the distinction is the security model.** Media is served by
 * unguessable key through CloudFront with the bucket private (ADR-023); a URL in a stored
 * row or a response would be a second place the host lives, would outlive a distribution
 * change, and would turn a field the API hands out into something that resolves on its own.
 * The API returns a key only for an image the caller may already see.
 */
export const attachment = z
  .object({
    attachmentId,
    activityId: ulidId('act'),
    /** The **permanent** key, `u/<userId>/<ulid>.<ext>`. Never the `tmp/` one. */
    key: z.string().min(1),
    contentType: uploadContentType,
    byteSize: z.number().int().positive(),
    createdAt: z.string().min(1),
    schemaVersion: z.literal(1),
  })
  .meta({ id: 'Attachment' });

/**
 * `POST /v1/activities/:id/attachments` — confirm an upload and link it.
 *
 * One field, and **strict**, because everything else about the attachment is already fixed:
 * the type, the size and both keys were decided when the URL was issued and are recorded on
 * the caller's pending record. A body offering `key`, `contentType` or `byteSize` would be
 * offering to contradict the declaration the store already enforced, so it is a named `400`
 * rather than a field quietly ignored.
 */
export const confirmAttachmentInput = z
  .strictObject({ attachmentId })
  .meta({ id: 'ConfirmAttachmentInput' });

/**
 * What a `DELETE` acknowledges: the id that is now gone, and — when it was the cover — that
 * the hero was cleared by the same write.
 *
 * A body rather than a `204`, for the reason `deletedDevice` records: every response carries
 * the `{ data, meta }` envelope and a `204` has none to carry it in. `coverCleared` is here
 * so a client can drop its hero without a refetch, and so the guarantee that the hero can
 * never point at nothing is observable in the response rather than only in the table.
 */
export const deletedAttachment = z
  .object({ attachmentId, coverCleared: z.boolean() })
  .meta({ id: 'DeletedAttachment' });

export type Attachment = z.infer<typeof attachment>;
export type ConfirmAttachmentInput = z.infer<typeof confirmAttachmentInput>;
export type DeletedAttachment = z.infer<typeof deletedAttachment>;
