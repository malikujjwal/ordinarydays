import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';

/**
 * Creates `od-media-local` in MinIO, the local S3-compatible media bucket
 * (`infrastructure.md` §6.1).
 *
 * The sibling of `create-local-table.ts` and deliberately much shorter, because a bucket has
 * no schema to drift: there is no key design, no index and no projection to compare, so
 * "already there" is the whole of the idempotency check and there is never a reason to delete
 * and recreate. A bucket that exists is a bucket that is correct.
 *
 * What MinIO does **not** model is as important as what it does. Block Public Access, the
 * CloudFront origin access control and the lifecycle rule that expires `tmp/` after a day are
 * all properties of the deployed bucket, asserted by the CDK tests (P0-26) and exercised
 * against the real media domain in Phase 5. Nothing here should grow a policy that pretends
 * otherwise — a local approximation of a security control is worse than none, because it
 * reads like the control is tested.
 */

/**
 * Reads the environment directly rather than through `src/lib/config.ts`, for the reason
 * `create-local-table.ts` records: that module validates the **runtime's** whole environment,
 * and a bucket script that refused to run because `AUTH_MODE` was unset would be enforcing a
 * rule with nothing to do with creating a bucket.
 */
function requireEndpoint(): { endpoint: string; region: string; bucket: string } {
  const endpoint = process.env.S3_ENDPOINT;
  if (endpoint === undefined || endpoint === '') {
    throw new Error(
      'S3_ENDPOINT is not set. This script only ever talks to the local object store — ' +
        'refusing to run without an explicit local endpoint, so that it can never reach a ' +
        'deployed bucket.',
    );
  }
  return {
    endpoint,
    region: process.env.AWS_REGION ?? 'us-east-1',
    bucket: process.env.MEDIA_BUCKET ?? 'od-media-local',
  };
}

/**
 * The two "it is already there" answers S3 gives.
 *
 * `BucketAlreadyOwnedByYou` is what a repeat `CreateBucket` returns; `BucketAlreadyExists`
 * is the global-namespace collision, which cannot happen on a single-tenant MinIO but is
 * returned by real S3 and costs nothing to treat the same way here.
 */
const ALREADY_THERE = new Set(['BucketAlreadyOwnedByYou', 'BucketAlreadyExists']);

export async function createLocalBucket(
  client: S3Client,
  bucket: string,
): Promise<'created' | 'unchanged'> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return 'unchanged';
  } catch (error) {
    // Anything other than "no such bucket" is a real failure — a wrong endpoint, a refused
    // connection, bad credentials — and must not be swallowed into a create attempt that
    // then fails with a less informative message.
    if (
      !(error instanceof S3ServiceException) ||
      error.$metadata.httpStatusCode !== 404
    ) {
      throw error;
    }
  }

  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    return 'created';
  } catch (error) {
    // Two processes racing — `pnpm test:int` and a developer running the script — both
    // wanted the same outcome, and both got it.
    if (error instanceof S3ServiceException && ALREADY_THERE.has(error.name)) {
      return 'unchanged';
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const { endpoint, region, bucket } = requireEndpoint();
  const client = new S3Client({
    region,
    endpoint,
    // MinIO serves no virtual-hosted bucket subdomains, so the bucket is a path segment.
    // The same pair of settings `lib/s3.ts` derives from `S3_ENDPOINT` at runtime.
    forcePathStyle: true,
  });

  const result = await createLocalBucket(client, bucket);

  console.log(
    result === 'created'
      ? `Created ${bucket} at ${endpoint}.`
      : `${bucket} already exists at ${endpoint}. Nothing to do.`,
  );
}

// Run only when invoked as a script. The exported function above is what the integration
// harness uses, and importing this file must not talk to an object store.
if (process.argv[1]?.endsWith('create-local-bucket.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
