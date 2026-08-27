import { describe, expect, it } from 'vitest';
import type { FetchLike, HttpClientConfig } from '../http.js';
import { createHttpClient } from '../http.js';
import {
  confirmAttachment,
  deleteAttachment,
  putToUploadUrl,
  requestUploadUrl,
  UploadFailedError,
  type UploadFetchLike,
} from './attachments.js';

/**
 * Attachments (P3-24), and one assertion that matters more than the rest.
 *
 * `putToUploadUrl` addresses S3, not this API. If it ever carried the bearer token, every image
 * a user uploads would send an API credential to a storage host that has no business seeing it
 * — and it would land in that host's access logs. The header spy below is the guard, and it
 * asserts the **whole** header set rather than just the absence of `Authorization`, because the
 * next leak would be a different header nobody thought to name.
 */

const REQUEST_ID = 'req_test';
const ACTIVITY_ID = 'act_01J0000000000000000000000A';
const ATTACHMENT_ID = 'att_01J0000000000000000000000B';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function makeClient(
  outcomes: Array<{ status: number; body?: unknown }>,
  overrides: Partial<HttpClientConfig> = {},
) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, headers: init?.headers ?? {}, body: init?.body });
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    if (outcome === undefined) throw new Error('no outcome');
    return Promise.resolve({
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      headers: { get: () => null },
      json: () => Promise.resolve(outcome.body),
      text: () =>
        Promise.resolve(outcome.body === undefined ? '' : JSON.stringify(outcome.body)),
    });
  };

  const client = createHttpClient({
    baseUrl: 'https://api.test',
    fetch,
    // A provider that really does hand out a token, so "no Authorization on the PUT" is a
    // fact about `putToUploadUrl` rather than an artefact of a signed-out fixture.
    tokenProvider: {
      getToken: () => Promise.resolve('secret-bearer-token'),
      getIdentity: () => Promise.resolve('usr_1'),
    },
    timezone: 'Europe/London',
    clientVersion: 'ios/0.1.0',
    strictResponses: true,
    sleep: () => Promise.resolve(),
    newRequestId: () => REQUEST_ID,
    onWarning: () => {},
    ...overrides,
  });
  return { client, calls };
}

const ok = (data: unknown) => ({
  status: 200,
  body: { data, meta: { requestId: REQUEST_ID } },
});

describe('requestUploadUrl', () => {
  it('declares the content type and exact byte size', async () => {
    const { client, calls } = makeClient([
      ok({
        attachmentId: ATTACHMENT_ID,
        uploadUrl: 'https://media.test/tmp/u/usr_1/abc.jpg?sig=1',
        key: 'tmp/u/usr_1/abc.jpg',
      }),
    ]);

    const result = await requestUploadUrl(
      client,
      { contentType: 'image/jpeg', byteSize: 2048 },
      'key-1',
    );

    expect(calls[0]?.url).toBe('https://api.test/v1/attachments/upload-url');
    expect(calls[0]?.headers['Idempotency-Key']).toBe('key-1');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      contentType: 'image/jpeg',
      byteSize: 2048,
    });
    // The temporary key. Confirmation copies it to the permanent one; neither is a URL.
    expect(result.key).toBe('tmp/u/usr_1/abc.jpg');
  });
});

describe('putToUploadUrl', () => {
  function makeUploader(outcome: { ok: boolean; status: number; body?: string }) {
    const calls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body: Uint8Array;
    }> = [];

    const uploadFetch: UploadFetchLike = (url, init) => {
      calls.push({
        url,
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      init.onProgress?.(1);
      return Promise.resolve({
        ok: outcome.ok,
        status: outcome.status,
        text: () => Promise.resolve(outcome.body ?? ''),
      });
    };

    return { uploadFetch, calls };
  }

  it('sends no Authorization header — only the signed Content-Type', async () => {
    const { uploadFetch, calls } = makeUploader({ ok: true, status: 200 });
    const bytes = new Uint8Array([1, 2, 3]);

    await putToUploadUrl(
      uploadFetch,
      'https://media.test/put?sig=1',
      bytes,
      'image/jpeg',
    );

    const headerNames = Object.keys(calls[0]?.headers ?? {}).map((name) =>
      name.toLowerCase(),
    );
    expect(headerNames).not.toContain('authorization');
    // Exactly one header. Anything else is a header S3 did not sign for — and the token this
    // client holds is deliberately not among them.
    expect(calls[0]?.headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.body).toBe(bytes);
    expect(JSON.stringify(calls[0]?.headers)).not.toContain('secret-bearer-token');
  });

  it('reports progress through the injected transport', async () => {
    const { uploadFetch } = makeUploader({ ok: true, status: 200 });
    const seen: number[] = [];

    await putToUploadUrl(
      uploadFetch,
      'https://media.test/put',
      new Uint8Array([1]),
      'image/png',
      (fraction) => seen.push(fraction),
    );

    expect(seen).toEqual([1]);
  });

  it('throws UploadFailedError rather than an ApiError, because S3 has no envelope', async () => {
    const { uploadFetch } = makeUploader({
      ok: false,
      status: 403,
      body: '<Error><Code>SignatureDoesNotMatch</Code></Error>',
    });

    const error = await putToUploadUrl(
      uploadFetch,
      'https://media.test/put',
      new Uint8Array([1]),
      'image/png',
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UploadFailedError);
    expect(error).toMatchObject({ status: 403 });
    expect((error as UploadFailedError).bodyText).toContain('SignatureDoesNotMatch');
  });

  it('does not retry — the signature expires in five minutes', async () => {
    const { uploadFetch, calls } = makeUploader({ ok: false, status: 500 });

    await putToUploadUrl(
      uploadFetch,
      'https://media.test/put',
      new Uint8Array([1]),
      'image/png',
    ).catch(() => undefined);

    // A 500 is retryable on the API transport. Here it is not: recovery is a new URL.
    expect(calls).toHaveLength(1);
  });
});

describe('confirmAttachment and deleteAttachment', () => {
  it('confirms with the id alone', async () => {
    const { client, calls } = makeClient([
      ok({
        attachmentId: ATTACHMENT_ID,
        activityId: ACTIVITY_ID,
        key: 'u/usr_1/abc.jpg',
        contentType: 'image/jpeg',
        byteSize: 2048,
        createdAt: '2026-08-26T10:00:00.000Z',
        schemaVersion: 1,
      }),
    ]);

    const attachment = await confirmAttachment(
      client,
      ACTIVITY_ID,
      { attachmentId: ATTACHMENT_ID },
      'key-2',
    );

    expect(calls[0]?.url).toBe(
      `https://api.test/v1/activities/${ACTIVITY_ID}/attachments`,
    );
    // Everything else was fixed when the URL was issued and is on the pending record.
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ attachmentId: ATTACHMENT_ID });
    // The permanent key, never the tmp/ one.
    expect(attachment.key).toBe('u/usr_1/abc.jpg');
  });

  it('reports whether the delete also cleared the cover', async () => {
    const { client, calls } = makeClient([
      ok({ attachmentId: ATTACHMENT_ID, coverCleared: true }),
    ]);

    const result = await deleteAttachment(client, ACTIVITY_ID, ATTACHMENT_ID);

    expect(calls[0]?.url).toBe(
      `https://api.test/v1/activities/${ACTIVITY_ID}/attachments/${ATTACHMENT_ID}`,
    );
    // So a caller drops its hero without a refetch, and the never-points-at-nothing
    // guarantee is observable in the response.
    expect(result.coverCleared).toBe(true);
  });
});
