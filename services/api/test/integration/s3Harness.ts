import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { beforeAll } from 'vitest';
import { createLocalBucket } from '../../scripts/create-local-bucket.js';

/**
 * MinIO, for the integration files that need a real object store (P3-21).
 *
 * ## Why this is separate from `harness.ts`
 *
 * Every integration file imports the table harness; only the attachment ones need a bucket.
 * Folding MinIO into `harness.ts` would make twenty-odd unrelated files fail when the object
 * store is down, which is the same mistake as a unit suite that needs Docker.
 *
 * ## Why there is one bucket rather than one per file
 *
 * `harness.ts` gives each file its own **table** because tests assert on whole-partition
 * contents and a shared table made a count a fact about the container rather than the run.
 * Objects have no such problem: every key contains a fresh ULID, so two files cannot collide
 * and no assertion here is a count of everything. One bucket also keeps the local store
 * identical to the one `pnpm dev` and the deployed stack use — a per-file bucket would be a
 * test-only shape, and the point of MinIO is that there is no test-only shape.
 *
 * ## Credentials
 *
 * MinIO's root user and password, fixed by the compose block, supplied by
 * `vitest.int.config.ts` so the suite is a function of itself rather than of whatever AWS
 * profile the developer happens to have exported. No real credential is involved, on a
 * laptop or in CI.
 */

const ENDPOINT = process.env.S3_ENDPOINT;
if (ENDPOINT === undefined || ENDPOINT === '') {
  throw new Error(
    'vitest.int.config.ts must provide S3_ENDPOINT for the integration suite.',
  );
}

export const MEDIA_BUCKET = process.env.MEDIA_BUCKET ?? 'od-media-local';

export const UPLOAD_ENDPOINT = ENDPOINT;

/**
 * The administrative client: bucket lifecycle and object assertions, never the code under
 * test. Separate from `lib/s3.ts`'s for the reason `harness.ts` gives — a test that shared
 * the client under test could not tell a broken service from a broken fixture.
 */
export const objects = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: 'local', secretAccessKey: 'localsecret' },
});

/**
 * Waits for the container to accept connections, then creates the bucket.
 *
 * `docker compose up --wait` returns when a service is **running**, and the `minio` service
 * carries no health check — infrastructure.md §6.1 prints it without one, and this harness is
 * not the place to diverge from the block the docs publish. MinIO binds its listener a moment
 * after the container starts, so the readiness wait lives here instead, where it costs one
 * retry loop rather than a compose file that no longer matches its documentation.
 */
async function ensureBucket(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await createLocalBucket(objects, MEDIA_BUCKET);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(
    `${MEDIA_BUCKET} could not be created at ${ENDPOINT} after 15s. Is MinIO up? ` +
      `\`docker compose up -d minio\`. Last error: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
  );
}

/**
 * Registers the bucket for the calling file. Call it once, at module scope, beside
 * `useTestTable()`.
 *
 * Nothing is truncated between tests and nothing is dropped at the end. Every key contains a
 * fresh ULID, so leftovers cannot affect a later run — and a `.minio-data` volume that
 * accumulates a few kilobytes of test images is the same disposable local state
 * `.dynamodb-data` already is.
 */
export function useTestBucket(): void {
  beforeAll(async () => {
    await ensureBucket();
  });
}

/** The stored object's type and length, or `undefined` when there is no such object. */
export async function headObject(
  key: string,
): Promise<{ contentType?: string; byteSize?: number } | undefined> {
  try {
    const result = await objects.send(
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

/** The stored bytes, for asserting that what arrived is what was sent. */
export async function getObjectBytes(key: string): Promise<Uint8Array> {
  const result = await objects.send(
    new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }),
  );
  return result.Body === undefined
    ? new Uint8Array()
    : new Uint8Array(await result.Body.transformToByteArray());
}

/** Seeds an object the code under test is expected to find — or to delete. */
export async function putObjectDirectly(
  key: string,
  contentType: string,
  bytes: Uint8Array,
): Promise<void> {
  // Imported lazily so the command is not part of this module's surface for tests that
  // only read: seeding is a fixture concern, and the presigned PUT is the real write path.
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  await objects.send(
    new PutObjectCommand({
      Bucket: MEDIA_BUCKET,
      Key: key,
      ContentType: contentType,
      Body: bytes,
    }),
  );
}

/** Removes one object, so a fixture can clean up after itself when it wants to. */
export async function deleteObjectDirectly(key: string): Promise<void> {
  await objects.send(new DeleteObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }));
}

/** Every key under a prefix — used to prove a drain removed what it said it removed. */
export async function listKeys(prefix: string): Promise<string[]> {
  const result = await objects.send(
    new ListObjectsV2Command({ Bucket: MEDIA_BUCKET, Prefix: prefix }),
  );
  return (result.Contents ?? []).flatMap((o) => (o.Key === undefined ? [] : [o.Key]));
}
