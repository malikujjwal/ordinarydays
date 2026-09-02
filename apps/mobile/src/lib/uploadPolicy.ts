import { MAX_UPLOAD_BYTES } from '@od/shared';
import { UploadFailedError } from '@od/shared/client';
import { uploadContentType } from '@od/shared/schemas';
import type { UploadContentType } from '@od/shared/types';

/**
 * The pure decisions behind an attachment upload (P3-41). No I/O, no React: the pre-checks
 * that must refuse **before any network call**, and the one classification a failed `PUT`
 * needs — expired signature or not.
 */

/** What the picker knows about a chosen image before a byte has moved. */
export interface PickedImage {
  readonly uri: string;
  readonly mimeType: string | undefined;
  readonly fileName: string | undefined;
  readonly byteSize: number;
  /** The decoded bytes, when the picker delivered them alongside the URI. */
  readonly bytes?: Uint8Array;
}

export type PreCheck =
  | {
      readonly ok: true;
      readonly contentType: UploadContentType;
      readonly byteSize: number;
    }
  | { readonly ok: false; readonly message: string };

/** The four allowed types, spelled the way §5.3's row for uploads spells them. */
export const UNSUPPORTED_TYPE_MESSAGE = 'Photos must be JPEG, PNG, HEIC or WebP.';
export const TOO_LARGE_MESSAGE = `Photos must be under ${Math.round(
  MAX_UPLOAD_BYTES / (1024 * 1024),
)} MB.`;

const EXTENSION_TYPES: Record<string, UploadContentType> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  webp: 'image/webp',
};

/**
 * The declared type: the picker's `mimeType` when it gives one, else the file extension.
 * `image/jpg` is what some Android pickers say for a JPEG; it is normalised, not refused.
 */
export function contentTypeOf(image: {
  readonly mimeType: string | undefined;
  readonly fileName: string | undefined;
  readonly uri: string;
}): string | undefined {
  const declared = image.mimeType?.toLowerCase();
  if (declared === 'image/jpg') return 'image/jpeg';
  if (
    declared !== undefined &&
    declared !== '' &&
    declared !== 'application/octet-stream'
  ) {
    return declared;
  }
  const name = image.fileName ?? image.uri.split('?')[0] ?? '';
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return EXTENSION_TYPES[extension];
}

/**
 * Client-side pre-checks (§P3-41 step 2): MIME is one of the four, size within the cap.
 * Failing early is a validation message, not a round trip — the caller asserts no fetch ran.
 */
export function preCheck(image: PickedImage): PreCheck {
  const type = contentTypeOf(image);
  const parsed = uploadContentType.safeParse(type);
  if (!parsed.success) return { ok: false, message: UNSUPPORTED_TYPE_MESSAGE };
  if (!Number.isInteger(image.byteSize) || image.byteSize <= 0) {
    return { ok: false, message: UNSUPPORTED_TYPE_MESSAGE };
  }
  if (image.byteSize > MAX_UPLOAD_BYTES) return { ok: false, message: TOO_LARGE_MESSAGE };
  return { ok: true, contentType: parsed.data, byteSize: image.byteSize };
}

/**
 * Whether a rejected `PUT` is the presigned URL having lapsed (five minutes, P3-21), which
 * the flow answers by silently requesting a fresh URL **once** (§P3-41 step 5). S3 says so
 * in the body — `AccessDenied` with `Request has expired` — and MinIO says the same; any other
 * 403 is a real store rejection (a `Content-Type` that does not match the declaration) and
 * is surfaced as a retryable failure instead.
 */
export function isExpiredUploadUrl(error: unknown): boolean {
  if (!(error instanceof UploadFailedError)) return false;
  if (error.status !== 403) return false;
  return /expired/i.test(error.bodyText);
}

/** What the row says while the upload cannot run because the device is offline (§5.4). */
export const QUEUED_LABEL = 'Pending';
