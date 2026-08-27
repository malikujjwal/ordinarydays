import type { z } from 'zod';
import {
  attachment,
  type ConfirmAttachmentInput,
  deletedAttachment,
  type RequestUploadUrlInput,
  requestUploadUrlResult,
} from '../../schemas/attachment.js';
import { envelope } from '../../schemas/envelope.js';
import type { HttpClient } from '../http.js';

/**
 * Attachments (`api-contract.md` §2.6, P3-21, P3-22).
 *
 * ## Three calls to the API, and one that is not to the API at all
 *
 * `requestUploadUrl` → **`putToUploadUrl`** → `confirmAttachment` is the upload chain. The
 * middle step is the odd one and is deliberately kept odd: it addresses S3, not this service.
 *
 * `putToUploadUrl` therefore does **not** take an {@link HttpClient}. It takes its own injected
 * transport, for two independent reasons:
 *
 * 1. **`HttpClient` would attach the bearer token.** Forwarding an API credential to a storage
 *    host is a leak — the URL already carries its own authorisation in the signature, and the
 *    token would travel to a host that has no business seeing it, land in its access logs, and
 *    do so on every image the user ever uploads.
 * 2. **`FetchLike`'s body is a `string`.** The transport this client is built on cannot carry
 *    bytes at all, so the raw `PUT` could not go through it even if the header problem did not
 *    exist. Widening `FetchLike` to accept binary would push the storage transport into the
 *    seam every API call shares, which is the wrong place to solve one endpoint's problem.
 *
 * There is also no envelope to parse: S3 answers an empty body on success and XML on failure,
 * and neither is `{ data, meta }`.
 */

export const requestUploadUrlResponse = envelope(requestUploadUrlResult);
export const attachmentResponse = envelope(attachment);
export const deletedAttachmentResponse = envelope(deletedAttachment);

export type RequestUploadUrlResult = z.infer<typeof requestUploadUrlResult>;
export type Attachment = z.infer<typeof attachment>;
export type DeletedAttachment = z.infer<typeof deletedAttachment>;

/**
 * The binary transport `putToUploadUrl` runs on, injected by the app layer.
 *
 * Separate from `FetchLike` rather than an extension of it: the body is bytes, the response is
 * never JSON, and nothing about the API's headers, retries or error envelope applies. On web
 * and React Native this is backed by `XMLHttpRequest` when progress is wanted, because `fetch`
 * has no portable upload-progress event — which is why `onProgress` is part of the transport's
 * contract rather than something this function could implement on top of a plain `fetch`.
 */
export type UploadFetchLike = (
  input: string,
  init: {
    method: 'PUT';
    headers: Record<string, string>;
    body: Uint8Array;
    signal?: AbortSignal;
    /** Called with a 0–1 fraction as bytes leave the device, when the transport can. */
    onProgress?: (fraction: number) => void;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * The presigned `PUT` failed. Not an `ApiError`: S3 has no `ErrorCode` and no `requestId`, and
 * dressing its XML up as this API's envelope would invent fields the caller could not trust.
 */
export class UploadFailedError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
  ) {
    super(`The upload was rejected with status ${status}.`);
    this.name = 'UploadFailedError';
  }
}

/**
 * `POST /v1/attachments/upload-url`.
 *
 * Creates the caller's durable pending-upload record and returns the presigned `PUT`, its
 * `attachmentId`, and the **temporary** `tmp/` key that URL writes to. Confirmation copies it
 * to the permanent key; neither is ever a URL, because media is served by unguessable key and
 * nothing this service stores names a host (ADR-023).
 *
 * `byteSize` is required rather than inferred: the bytes never reach this service, and both
 * `contentType` and `byteSize` are bound into the signature. That binding is what makes the
 * 10 MB cap a cap rather than an after-the-fact check — and it is why the array handed to
 * {@link putToUploadUrl} must be exactly this many bytes.
 */
export function requestUploadUrl(
  client: HttpClient,
  input: RequestUploadUrlInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<RequestUploadUrlResult> {
  return client
    .request({
      method: 'POST',
      path: '/v1/attachments/upload-url',
      schema: requestUploadUrlResponse,
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      replayProtected: true,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/**
 * The raw presigned `PUT`. **No `Authorization` header, ever.**
 *
 * The only headers sent are `Content-Type` and whatever the transport adds for the body's
 * length. `contentType` must equal the value declared to {@link requestUploadUrl} and
 * `bytes.byteLength` must equal its `byteSize`: both are signed into the URL, so a mismatch is
 * a `403` from S3 rather than a silent substitution. That is the point of the binding, and this
 * function does not re-check it — the signature already does, authoritatively.
 *
 * A non-2xx becomes {@link UploadFailedError} carrying the status and S3's body text. There is
 * no retry here: the URL expires in five minutes, and a failed upload is recovered by
 * requesting a new one rather than by hammering a signature that may already be stale.
 */
export function putToUploadUrl(
  uploadFetch: UploadFetchLike,
  url: string,
  bytes: Uint8Array,
  contentType: string,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return uploadFetch(url, {
    method: 'PUT',
    // Exactly one header. Anything else here is a header S3 did not sign for.
    headers: { 'Content-Type': contentType },
    body: bytes,
    ...(onProgress === undefined ? {} : { onProgress }),
    ...(signal === undefined ? {} : { signal }),
  }).then(async (response) => {
    if (response.ok) return;
    throw new UploadFailedError(response.status, await response.text());
  });
}

/**
 * `POST /v1/activities/:id/attachments` — confirm the upload and link it.
 *
 * One field, because everything else was fixed when the URL was issued and is recorded on the
 * caller's pending record. Confirmation is a cross-store state machine and is resumable at
 * every crash point, so this is safe to replay under the same `Idempotency-Key` — which is
 * exactly what a retry after a lost response does.
 */
export function confirmAttachment(
  client: HttpClient,
  activityId: string,
  input: ConfirmAttachmentInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<Attachment> {
  return client
    .request({
      method: 'POST',
      path: `/v1/activities/${activityId}/attachments`,
      schema: attachmentResponse,
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      replayProtected: true,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

/**
 * `DELETE /v1/activities/:id/attachments/:attachmentId`.
 *
 * `coverCleared` says whether the same write dropped the activity's hero, so a caller can
 * update it without a refetch — and so the guarantee that the hero never points at nothing is
 * observable in the response rather than only in the table.
 */
export function deleteAttachment(
  client: HttpClient,
  activityId: string,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<DeletedAttachment> {
  return client
    .request({
      method: 'DELETE',
      path: `/v1/activities/${activityId}/attachments/${attachmentId}`,
      schema: deletedAttachmentResponse,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

export type { ConfirmAttachmentInput, RequestUploadUrlInput };
