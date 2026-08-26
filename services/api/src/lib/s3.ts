import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config.js';

/**
 * The single S3 client and everything the attachment path does with object storage
 * (`infrastructure.md` §6.2, P3-21).
 *
 * Built once at module scope and reused across warm invocations, exactly as `lib/ddb.ts`
 * builds the DynamoDB one. `endpoint` and `forcePathStyle` come from `S3_ENDPOINT` when it is
 * set, which is **configuration and not a code branch**: there is no `if (local)` here or
 * anywhere downstream, the deployed path is the only path, and the local tests are what
 * exercise it. A stage check in a route, service or repository is a review rejection
 * (`phase-03-plans-and-lists.md`, the MinIO risk row).
 *
 * **Bytes never pass through this process.** The API signs a URL and the client `PUT`s to it
 * directly; uploading through the function burns duration and hits the 6 MB payload limit.
 * Nothing here takes a body, and nothing should be added that does.
 *
 * Unlike `lib/ddb.ts` this module is reachable from `services/`, and that is deliberate
 * rather than an erosion of the repository rule. What `repositories/` protects is key
 * construction against the multi-tenant **table**; an object key is not a `pk`, carries no
 * partition, and is built here for the same reason — one file, one place to audit that every
 * key is scoped to the caller.
 */

const client = new S3Client({
  region: config.AWS_REGION,
  ...(config.S3_ENDPOINT !== undefined && {
    endpoint: config.S3_ENDPOINT,
    // MinIO serves no virtual-hosted bucket subdomains, so the bucket must be a path
    // segment. Travels with the endpoint because it is meaningless without it.
    forcePathStyle: true,
  }),
  /**
   * **Off, and the presigned `PUT` does not work with it on.**
   *
   * The SDK's default (`WHEN_SUPPORTED`) adds a CRC32 checksum to `PutObject`. Presigning
   * runs the same middleware stack with no body, so the checksum is computed over an *empty*
   * payload and hoisted into the query string as `x-amz-checksum-crc32=AAAAAA==` — a
   * signed-in-advance claim that the object is zero bytes. MinIO ignores the parameter and
   * the upload succeeds; real S3 does not, so this would have shipped as a Phase 4 discovery
   * on the first deployed upload with nothing local able to reproduce it.
   */
  requestChecksumCalculation: 'WHEN_REQUIRED',
});

export const MEDIA_BUCKET = config.MEDIA_BUCKET;

/**
 * How long a presigned upload URL is valid (`api-contract.md` §2.6).
 *
 * Long enough for a photo over a mobile connection, short enough that a URL leaked from a log
 * or a crash report is worthless by the time anyone reads it. Injectable at the call site so a
 * test can prove expiry without waiting five minutes; the default is the contract's value and
 * nothing in production passes anything else.
 */
export const UPLOAD_URL_EXPIRY_SECONDS = 300;

/**
 * The four image types an attachment may be, and the file extension each one takes.
 *
 * The extension is cosmetic to S3 — the key is an opaque string — but it is what makes an
 * object recognisable when someone is looking at a bucket listing during an incident, and it
 * is what a browser and CloudFront use to guess a type when the stored `Content-Type` is
 * unavailable. Deriving it from the declared type rather than from a client-supplied filename
 * is deliberate: a filename is user input and an extension taken from one is a path segment
 * an attacker chooses.
 */
const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/webp': 'webp',
} as const satisfies Record<string, string>;

export type UploadContentType = keyof typeof EXTENSIONS;

/**
 * The temporary key an upload lands on: `tmp/u/<userId>/<ulid>.<ext>`.
 *
 * Two properties, both load-bearing. The `tmp/` prefix is what the deployed bucket's one-day
 * lifecycle rule expires, so an upload nobody ever confirms costs storage for a day and then
 * stops existing. And the caller's id is a **path segment**, so an object's own key records
 * whose it is: confirmation can check that the key it is about to copy belongs to the person
 * asking, without consulting anything else.
 */
export function tmpObjectKey(
  userId: string,
  ulid: string,
  contentType: UploadContentType,
): string {
  return `tmp/u/${userId}/${ulid}.${EXTENSIONS[contentType]}`;
}

/**
 * The permanent key confirmation copies to: `u/<userId>/<ulid>.<ext>`.
 *
 * The same key minus `tmp/`, which is what keeps "has this been confirmed" a question about
 * one path segment rather than a second stored value that could disagree with the object.
 *
 * Media is served by **unguessable key** rather than by signed URL in v1 (ADR-023), so the
 * ULID is the whole of the secret and the API returns a key only for an image the caller may
 * see. It is never a URL: nothing stored or returned by this service names a host.
 */
export function finalObjectKey(
  userId: string,
  ulid: string,
  contentType: UploadContentType,
): string {
  return `u/${userId}/${ulid}.${EXTENSIONS[contentType]}`;
}

export interface PresignedPut {
  readonly key: string;
  readonly contentType: UploadContentType;
  readonly byteSize: number;
  readonly expiresInSeconds?: number;
}

/**
 * A presigned `PUT` whose signature covers the declared type **and** the declared length.
 *
 * ## Why `signableHeaders` is not optional here
 *
 * `getSignedUrl` adds `content-type` to its unsignable set unconditionally
 * (`S3RequestPresigner.prepareRequest`), so a `PutObjectCommand` carrying `ContentType`
 * produces a URL that accepts **any** type — the header is sent, ignored by the signature,
 * and stored on the object. Naming it here puts it back: `signableHeaders` overrides
 * `unsignableHeaders` in `getCanonicalHeaders`. Without this line acceptance criterion 23's
 * first clause silently fails, and it fails in the direction where the API looks correct: a
 * client that declares `image/png` and uploads something else is stored as what it claimed.
 *
 * `content-length` needs no such help — it is signed from `ContentLength` already — but it is
 * asserted alongside the type by the integration tests, because both halves of the promise
 * are one signature and a change to either is invisible in a diff.
 *
 * The store, not this service, is what enforces both: a mismatched header produces
 * `SignatureDoesNotMatch` at S3 with no request reaching the API. That is the point of the
 * design — validation the API cannot be talked out of.
 */
export async function presignUpload(request: PresignedPut): Promise<string> {
  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: MEDIA_BUCKET,
      Key: request.key,
      ContentType: request.contentType,
      ContentLength: request.byteSize,
    }),
    {
      expiresIn: request.expiresInSeconds ?? UPLOAD_URL_EXPIRY_SECONDS,
      signableHeaders: new Set(['content-type']),
    },
  );
}

/**
 * Deletes one object, by key.
 *
 * S3 answers the same way whether or not the object was there, which is what the pending
 * drain needs: a temporary object may already have been collected by the lifecycle rule, and
 * a delete that distinguished the two cases would make the drain need a `HeadObject` first to
 * learn something it does not act on.
 */
export async function deleteObject(key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }));
}

/** What a stored object actually is, as opposed to what somebody declared it would be. */
export interface StoredObject {
  readonly contentType?: string;
  readonly byteSize?: number;
}

/**
 * The object's type and length, or `undefined` when there is no such object (P3-22).
 *
 * The confirmation state machine calls this twice and for different reasons. On the
 * temporary key it is the **proof that the upload happened and matched its declaration** —
 * the signature bound the type and length, so an object that exists at that key with those
 * two values is one this service authorised; an absent object means the client never
 * uploaded, or the one-day lifecycle rule has already collected it. On the permanent key it
 * is the proof the copy landed, which is what lets a retry after a crash tell "already
 * copied" from "not copied yet" without trusting its own memory.
 *
 * A missing object is `undefined` rather than a throw, because both callers treat absence as
 * a state to act on rather than as a failure. Anything else — a refused connection, a denied
 * request — propagates, because those are not evidence of anything.
 */
export async function headObject(key: string): Promise<StoredObject | undefined> {
  try {
    const result = await client.send(
      new HeadObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }),
    );
    return {
      ...(result.ContentType === undefined ? {} : { contentType: result.ContentType }),
      ...(result.ContentLength === undefined ? {} : { byteSize: result.ContentLength }),
    };
  } catch (error) {
    if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Server-side copy from the temporary key to the permanent one.
 *
 * **Server-side, so the bytes never move through this process** — the same rule the presigned
 * `PUT` exists for. A copy that downloaded and re-uploaded would burn the duration and the
 * memory that the whole design avoids, on the one code path where the image is largest.
 *
 * Idempotent by nature: copying the same source to the same destination twice leaves one
 * object, which is what makes a retried confirmation safe without a preceding existence check.
 *
 * `CopySource` is `bucket/key` and must be URI-encoded — an unencoded key containing a
 * character S3 treats specially resolves to a different source or to none. The keys this
 * service mints are ULIDs and user ids, so nothing here needs it today; it is encoded anyway,
 * because the day a key format changes is not the day to discover this.
 */
export async function copyObject(fromKey: string, toKey: string): Promise<void> {
  await client.send(
    new CopyObjectCommand({
      Bucket: MEDIA_BUCKET,
      CopySource: encodeURI(`${MEDIA_BUCKET}/${fromKey}`),
      Key: toKey,
    }),
  );
}
