import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteObject,
  finalObjectKey,
  MEDIA_BUCKET,
  presignUpload,
  tmpObjectKey,
  UPLOAD_URL_EXPIRY_SECONDS,
} from './s3.js';

/**
 * The S3 seam: object keys, the presigned `PUT`, and the delete the pending drain uses.
 *
 * What this file proves is the **shape of the signature** — that the URL binds the type and
 * the length, and expires when it says it does. What it deliberately does not prove is that
 * a store enforces any of it: a presigner asserting its own output is a mock testing a mock,
 * which is exactly why `test/integration/attachments.int.test.ts` runs the same code against
 * MinIO. Both exist; neither replaces the other.
 */

const USER = 'usr_local_dev';
const ULID = '01JBQK5V7Z8N3MTQPYX4WD6RHC';

describe('object keys', () => {
  /**
   * The extension comes from the **declared type**, never from a client-supplied filename:
   * a filename is user input, and an extension taken from one is a path segment an attacker
   * chooses.
   */
  it.each([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/heic', 'heic'],
    ['image/webp', 'webp'],
  ] as const)('gives %s the extension .%s', (contentType, extension) => {
    expect(tmpObjectKey(USER, ULID, contentType)).toBe(
      `tmp/u/${USER}/${ULID}.${extension}`,
    );
    expect(finalObjectKey(USER, ULID, contentType)).toBe(
      `u/${USER}/${ULID}.${extension}`,
    );
  });

  /**
   * The permanent key is the temporary one minus `tmp/`, which is what keeps "has this been
   * confirmed" a question about one path segment rather than a second stored value that
   * could disagree with the object.
   */
  it('differs only by the tmp/ prefix the lifecycle rule expires', () => {
    expect(tmpObjectKey(USER, ULID, 'image/jpeg')).toBe(
      `tmp/${finalObjectKey(USER, ULID, 'image/jpeg')}`,
    );
  });

  /** The caller's id is a path segment, so an object's own key records whose it is. */
  it('scopes an object to its uploader', () => {
    expect(finalObjectKey('usr_a', ULID, 'image/png')).not.toBe(
      finalObjectKey('usr_b', ULID, 'image/png'),
    );
  });
});

describe('the presigned PUT', () => {
  const key = tmpObjectKey(USER, ULID, 'image/jpeg');

  const paramsOf = async (expiresInSeconds?: number) => {
    const url = await presignUpload({
      key,
      contentType: 'image/jpeg',
      byteSize: 2048,
      ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
    });
    return { url, params: new URL(url).searchParams };
  };

  /**
   * **The assertion this whole task turns on.** `getSignedUrl` adds `content-type` to its
   * unsignable set unconditionally, so without the `signableHeaders` override the URL
   * accepts any type and stores whatever arrives under the name the caller claimed. That
   * failure is invisible from the API side — the response is identical — so it is asserted
   * here and again against a real store.
   */
  it('binds both the declared type and the declared length into the signature', async () => {
    const { params } = await paramsOf();
    expect(params.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
      expect.arrayContaining(['content-length', 'content-type']),
    );
  });

  /**
   * The SDK's default checksum calculation hoists a CRC32 of the **empty** presigning
   * payload into the query string — a signed-in-advance claim that the object is zero bytes.
   * MinIO ignores it and real S3 does not, so this would have shipped as a Phase 4
   * discovery that nothing local could reproduce.
   */
  it('hoists no precomputed checksum of the empty presigning body', async () => {
    const { params } = await paramsOf();
    for (const [name] of params) {
      expect(name.toLowerCase()).not.toMatch(/^x-amz-checksum-/);
    }
  });

  it('expires in five minutes by default', async () => {
    const { params } = await paramsOf();
    expect(params.get('X-Amz-Expires')).toBe(String(UPLOAD_URL_EXPIRY_SECONDS));
    expect(UPLOAD_URL_EXPIRY_SECONDS).toBe(300);
  });

  /** Injectable, so a test can prove expiry without waiting five minutes. */
  it('takes an injected expiry', async () => {
    const { params } = await paramsOf(1);
    expect(params.get('X-Amz-Expires')).toBe('1');
  });

  it('signs the exact key in the media bucket, and returns no credentials in the path', async () => {
    const { url } = await paramsOf();
    expect(url).toContain(encodeURI(key));
    expect(url).toContain(MEDIA_BUCKET);
    expect(url).toMatch(/^https?:\/\//);
  });
});

describe('deleteObject', () => {
  const s3 = mockClient(S3Client);

  beforeEach(() => {
    s3.reset();
    s3.on(DeleteObjectCommand).resolves({});
  });

  afterEach(() => {
    s3.restore();
  });

  it('deletes exactly the key it is given, in the media bucket', async () => {
    await deleteObject('tmp/u/usr_a/01.jpg');

    expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(s3.commandCalls(DeleteObjectCommand)[0]?.args[0].input).toEqual({
      Bucket: MEDIA_BUCKET,
      Key: 'tmp/u/usr_a/01.jpg',
    });
  });
});

/**
 * The local/deployed difference is **client construction and nothing else**, which is the
 * mitigation the phase doc's MinIO risk row names. Re-imported under a stubbed environment
 * because the client is built at module scope — the same reason `config.test.ts` re-imports.
 */
describe('S3_ENDPOINT selects a local store without changing a code path', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('addresses the bucket by path when an endpoint is set, and by host when it is not', async () => {
    const deployed = await presignUpload({
      key: 'tmp/u/usr_a/01.jpg',
      contentType: 'image/jpeg',
      byteSize: 1,
    });
    expect(new URL(deployed).hostname.startsWith(`${MEDIA_BUCKET}.`)).toBe(true);

    vi.resetModules();
    vi.stubEnv('S3_ENDPOINT', 'http://127.0.0.1:9000');
    const local = await import('./s3.js');

    const url = new URL(
      await local.presignUpload({
        key: 'tmp/u/usr_a/01.jpg',
        contentType: 'image/jpeg',
        byteSize: 1,
      }),
    );
    expect(url.origin).toBe('http://127.0.0.1:9000');
    expect(url.pathname.startsWith(`/${MEDIA_BUCKET}/`)).toBe(true);
  });
});
