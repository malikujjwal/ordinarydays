import { randomUUID } from 'node:crypto';
import { MAX_UNRESOLVED_UPLOADS, MAX_UPLOAD_BYTES } from '@od/shared/constants';
import { beforeEach, describe, expect, it } from 'vitest';
import { authedHeaders, withUser } from '../helpers/auth.js';
import { documents, TEST_TABLE, useTestTable } from './harness.js';
import {
  getObjectBytes,
  headObject,
  listKeys,
  putObjectDirectly,
  useTestBucket,
} from './s3Harness.js';

/**
 * `POST /v1/attachments/upload-url` against DynamoDB Local **and** MinIO (P3-21, acceptance
 * criteria 23 and 24's first clause).
 *
 * ## Why a real object store
 *
 * Everything this endpoint promises is enforced by a signature, and a mock that accepts every
 * presigned URL tests nothing. The four assertions that matter — the declared type is
 * binding, the declared length is binding, the URL stops working, and the bytes never touch
 * the API — are all assertions about what a **store** does with a URL this service produced.
 * MinIO speaks SigV4, so they are answerable on a laptop and in CI with no AWS credentials.
 *
 * ## What it deliberately does not cover
 *
 * Block Public Access, the CloudFront origin access control and the `tmp/` lifecycle rule.
 * MinIO models none of them; they are properties of the deployed bucket, asserted by the CDK
 * tests and exercised against the real media domain in Phase 5. A local approximation would
 * read like those controls were tested.
 */

useTestTable();
useTestBucket();

const USER = 'usr_upload_test';
const PATH = 'http://localhost/v1/attachments/upload-url';

interface Grant {
  attachmentId: string;
  uploadUrl: string;
  key: string;
}

async function requestUrl(
  body: unknown = { contentType: 'image/jpeg', byteSize: 4 },
  options: { idempotencyKey?: string; user?: string } = {},
): Promise<{ status: number; grant?: Grant; error?: { code: string; message: string } }> {
  const response = await withUser(options.user ?? USER).fetch(
    new Request(PATH, {
      method: 'POST',
      headers: authedHeaders({ idempotencyKey: options.idempotencyKey ?? randomUUID() }),
      body: JSON.stringify(body),
    }),
  );
  const parsed = (await response.json()) as {
    data?: Grant;
    error?: { code: string; message: string };
  };
  return {
    status: response.status,
    ...(parsed.data === undefined ? {} : { grant: parsed.data }),
    ...(parsed.error === undefined ? {} : { error: parsed.error }),
  };
}

/** The four bytes every upload in this file sends. */
const BYTES = new Uint8Array([137, 80, 78, 71]);

/**
 * `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`: the bare form widens to
 * `ArrayBufferLike`, which TypeScript does not accept as a `BodyInit` — and every literal
 * passed here already has the narrower type.
 */
const put = (url: string, contentType: string, body: Uint8Array<ArrayBuffer> = BYTES) =>
  fetch(url, { method: 'PUT', headers: { 'content-type': contentType }, body });

/** The caller's pending-upload rows, read straight from the table. */
async function pendingRows(userId = USER): Promise<Record<string, unknown>[]> {
  const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
  const result = await documents.send(
    new QueryCommand({
      TableName: TEST_TABLE,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :sk)',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'UPLOAD#' },
      ConsistentRead: true,
    }),
  );
  return (result.Items ?? []) as Record<string, unknown>[];
}

/** Writes a pending row directly, so a test can seed a state the endpoint takes minutes to reach. */
async function seedPending(input: {
  attachmentId: string;
  tmpKey: string;
  state: 'awaiting_upload' | 'confirming';
  cleanupAfter: string;
  userId?: string;
}): Promise<void> {
  const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
  const userId = input.userId ?? USER;
  await documents.send(
    new PutCommand({
      TableName: TEST_TABLE,
      Item: {
        pk: `USER#${userId}`,
        sk: `UPLOAD#${input.attachmentId}`,
        entity: 'PendingUpload',
        attachmentId: input.attachmentId,
        userId,
        tmpKey: input.tmpKey,
        finalKey: input.tmpKey.slice('tmp/'.length),
        contentType: 'image/jpeg',
        byteSize: 4,
        state: input.state,
        createdAt: '2026-01-01T00:00:00.000Z',
        cleanupAfter: input.cleanupAfter,
        schemaVersion: 1,
      },
    }),
  );
}

const LONG_AGO = '2026-01-02T00:00:00.000Z';
const FAR_AHEAD = '2099-01-01T00:00:00.000Z';

describe('the presigned PUT, against a real store', () => {
  let grant: Grant;

  beforeEach(async () => {
    const issued = await requestUrl({ contentType: 'image/png', byteSize: BYTES.length });
    expect(issued.status).toBe(201);
    grant = issued.grant as Grant;
  });

  /** Acceptance criterion 24, first clause: the upload itself works. */
  it('accepts the declared content type and stores exactly the declared bytes', async () => {
    const response = await put(grant.uploadUrl, 'image/png');

    expect(response.status).toBe(200);
    expect(await headObject(grant.key)).toEqual({
      contentType: 'image/png',
      byteSize: BYTES.length,
    });
    expect(await getObjectBytes(grant.key)).toEqual(BYTES);
  });

  /**
   * **Acceptance criterion 23, and the reason the store is MinIO rather than a mock.**
   *
   * The rejection is a `403 SignatureDoesNotMatch` from S3 — no request reaches the API at
   * all. That is the design: an API that checked the type could be talked out of it by a
   * client that simply sent different bytes; a signature cannot.
   */
  it('is refused BY THE STORE when the content type differs from the declaration', async () => {
    const response = await put(grant.uploadUrl, 'image/jpeg');

    expect(response.status).toBe(403);
    expect(await response.text()).toContain('SignatureDoesNotMatch');
    expect(await headObject(grant.key)).toBeUndefined();
  });

  /** The other half of criterion 23: a body longer than the declaration. */
  it('is refused by the store when the body is longer than the declaration', async () => {
    const response = await put(grant.uploadUrl, 'image/png', new Uint8Array(64));

    expect(response.status).toBe(403);
    expect(await response.text()).toContain('SignatureDoesNotMatch');
    expect(await headObject(grant.key)).toBeUndefined();
  });

  /** Omitting the header entirely is a signature the store cannot reconstruct either. */
  it('is refused by the store when the content type is missing', async () => {
    const response = await fetch(grant.uploadUrl, { method: 'PUT', body: BYTES });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await headObject(grant.key)).toBeUndefined();
  });

  /** The whole point of the presign: no image byte ever reaches this service. */
  it('writes an object the API never saw', async () => {
    await put(grant.uploadUrl, 'image/png');

    expect(new URL(grant.uploadUrl).pathname).toContain(grant.key);
    expect(grant.uploadUrl).not.toContain('/v1/');
  });
});

/**
 * The expiry, at both ends: the default is the contract's five minutes, and an injected one
 * genuinely stops working when it lapses.
 *
 * The tiny expiry is injected through the **service**, because it must never be a request
 * field — a client that could choose its own expiry could choose one that never ends.
 */
describe('expiry', () => {
  it('signs for five minutes through the endpoint', async () => {
    const { grant } = await requestUrl();
    expect(new URL((grant as Grant).uploadUrl).searchParams.get('X-Amz-Expires')).toBe(
      '300',
    );
  });

  it('stops working once an injected expiry has lapsed', async () => {
    const { requestUploadUrl } = await import('../../src/services/attachmentService.js');
    const issued = await requestUploadUrl(
      USER,
      { contentType: 'image/png', byteSize: BYTES.length },
      new Date().toISOString(),
      { expiresInSeconds: 1 },
    );

    // Usable now.
    expect((await put(issued.uploadUrl, 'image/png')).status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 2100));

    const late = await put(issued.uploadUrl, 'image/png');
    expect(late.status).toBe(403);
    // `Request has expired`, and matched case-insensitively on the one word that carries the
    // meaning: the store's wording is not this repository's to pin, but the reason for the
    // refusal is — a `403` for the wrong reason would pass a bare status check.
    expect(await late.text()).toMatch(/expired/i);
  });
});

describe('what the API refuses before it ever signs anything', () => {
  it.each([
    [
      'an eleven-megabyte declaration',
      { contentType: 'image/jpeg', byteSize: 11 * 1024 * 1024 },
    ],
    ['an application/pdf declaration', { contentType: 'application/pdf', byteSize: 4 }],
  ])('%s is a 400 that writes no record', async (_name, body) => {
    const result = await requestUrl(body);

    expect(result.status).toBe(400);
    expect(result.error?.code).toBe('validation_failed');
    expect(await pendingRows()).toEqual([]);
  });

  it('accepts exactly the cap', async () => {
    // Declared, not uploaded: the point is that the API signs it, and a ten-megabyte body
    // over a loopback socket would buy nothing the four-byte cases have not already proven.
    const result = await requestUrl({
      contentType: 'image/jpeg',
      byteSize: MAX_UPLOAD_BYTES,
    });
    expect(result.status).toBe(201);
  });
});

describe('the pending record', () => {
  /**
   * The record is the durable authority for retrying or cleaning a confirmation, so it must
   * exist by the time anybody can act on the URL. Reading the row **before** the upload is
   * how that is observable from outside.
   */
  it('exists, with its declaration, before the URL is used', async () => {
    const { grant } = await requestUrl({ contentType: 'image/webp', byteSize: 4 });

    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pk: `USER#${USER}`,
      sk: `UPLOAD#${(grant as Grant).attachmentId}`,
      entity: 'PendingUpload',
      state: 'awaiting_upload',
      contentType: 'image/webp',
      byteSize: 4,
      tmpKey: (grant as Grant).key,
    });
    expect(await headObject((grant as Grant).key)).toBeUndefined();
  });

  /** One day, matching the `tmp/` lifecycle rule the deployed bucket applies. */
  it('records a cleanup instant one day out', async () => {
    const before = Date.now();
    await requestUrl();
    const row = (await pendingRows())[0] as { createdAt: string; cleanupAfter: string };

    expect(Date.parse(row.cleanupAfter) - Date.parse(row.createdAt)).toBe(86_400_000);
    expect(Date.parse(row.createdAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  /** Rows live in the caller's own partition, so one user's cap is nobody else's. */
  it('is scoped to the caller', async () => {
    await requestUrl();
    await requestUrl(undefined, { user: 'usr_someone_else' });

    expect(await pendingRows()).toHaveLength(1);
    expect(await pendingRows('usr_someone_else')).toHaveLength(1);
  });
});

describe('the bounded drain', () => {
  /**
   * The object goes first and the row second, so a crash between them leaves a row that the
   * next drain retries rather than an object nothing knows about.
   */
  it('removes an expired record and its temporary object', async () => {
    const staleKey = `tmp/u/${USER}/${randomUUID()}.jpg`;
    await putObjectDirectly(staleKey, 'image/jpeg', BYTES);
    await seedPending({
      attachmentId: `att_stale_${randomUUID()}`,
      tmpKey: staleKey,
      state: 'awaiting_upload',
      cleanupAfter: LONG_AGO,
    });
    expect(await headObject(staleKey)).toBeDefined();

    const result = await requestUrl();

    expect(result.status).toBe(201);
    expect(await headObject(staleKey)).toBeUndefined();
    expect(await listKeys(staleKey)).toEqual([]);
    // Only the new record survives.
    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attachmentId).toBe((result.grant as Grant).attachmentId);
  });

  it('leaves an unexpired record alone', async () => {
    await seedPending({
      attachmentId: 'att_fresh_0000000000000000000000',
      tmpKey: `tmp/u/${USER}/fresh.jpg`,
      state: 'awaiting_upload',
      cleanupAfter: FAR_AHEAD,
    });

    await requestUrl();

    expect(await pendingRows()).toHaveLength(2);
  });

  /**
   * **Deferred to P3-22 on purpose.** A `confirming` row may already have a permanent copy
   * behind it; completing or cleaning one needs the confirm path's Activity read and
   * transaction. Until that lands the row is left in place and counted live, which is the
   * safe direction — an untouched row is discoverable work, a prematurely deleted one is the
   * permanent orphan the record exists to prevent.
   */
  it('never touches a confirming record, even an expired one', async () => {
    const key = `tmp/u/${USER}/${randomUUID()}.jpg`;
    await putObjectDirectly(key, 'image/jpeg', BYTES);
    await seedPending({
      attachmentId: 'att_confirming_00000000000000000',
      tmpKey: key,
      state: 'confirming',
      cleanupAfter: LONG_AGO,
    });

    await requestUrl();

    expect(await headObject(key)).toBeDefined();
    expect((await pendingRows()).some((r) => r.state === 'confirming')).toBe(true);
  });
});

describe('the twenty-record cap', () => {
  const seedLive = (count: number, cleanupAfter = FAR_AHEAD) =>
    Promise.all(
      Array.from({ length: count }, (_, i) =>
        seedPending({
          attachmentId: `att_seed_${String(i).padStart(21, '0')}`,
          tmpKey: `tmp/u/${USER}/seed_${i}.jpg`,
          state: 'awaiting_upload',
          cleanupAfter,
        }),
      ),
    );

  it('refuses the twenty-first and writes no record for it', async () => {
    await seedLive(MAX_UNRESOLVED_UPLOADS);

    const result = await requestUrl();

    expect(result.status).toBe(400);
    expect(result.error?.code).toBe('validation_failed');
    expect(result.error?.message).toContain(String(MAX_UNRESOLVED_UPLOADS));
    expect(await pendingRows()).toHaveLength(MAX_UNRESOLVED_UPLOADS);
  });

  it('allows the twentieth', async () => {
    await seedLive(MAX_UNRESOLVED_UPLOADS - 1);

    expect((await requestUrl()).status).toBe(201);
    expect(await pendingRows()).toHaveLength(MAX_UNRESOLVED_UPLOADS);
  });

  /**
   * The cap counts what survives the drain, not what was read — otherwise a user who
   * abandoned twenty uploads would be locked out for a day with nothing able to release them.
   */
  it('makes room by draining before it refuses', async () => {
    await seedLive(MAX_UNRESOLVED_UPLOADS, LONG_AGO);

    const result = await requestUrl();

    expect(result.status).toBe(201);
    expect(await pendingRows()).toHaveLength(1);
  });
});

/**
 * The replay, and the consequence it carries.
 *
 * A repeated key answers with the **stored body**, so the id, the key and the URL are the
 * ones originally issued — and that URL may by then have expired. That is the right trade: an
 * expired URL is a retry the client recovers from by asking for a fresh one, while a second
 * record would be a leak nothing collects for a day.
 */
describe('replay', () => {
  it('returns the originally issued URL and writes exactly one record', async () => {
    const key = randomUUID();
    const first = await requestUrl(undefined, { idempotencyKey: key });
    const second = await requestUrl(undefined, { idempotencyKey: key });

    expect(second.status).toBe(201);
    expect(second.grant).toEqual(first.grant);
    expect(await pendingRows()).toHaveLength(1);
  });

  it('mints a second record under a different key', async () => {
    const first = await requestUrl();
    const second = await requestUrl();

    expect(second.grant?.attachmentId).not.toBe(first.grant?.attachmentId);
    expect(second.grant?.key).not.toBe(first.grant?.key);
    expect(await pendingRows()).toHaveLength(2);
  });
});
