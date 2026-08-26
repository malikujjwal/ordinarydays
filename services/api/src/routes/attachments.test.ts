import { randomUUID } from 'node:crypto';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { MAX_UPLOAD_BYTES } from '@od/shared/constants';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';

import type { createApp as CreateApp } from '../app.js';

/**
 * `POST /v1/attachments/upload-url` (P3-21).
 *
 * Endpoint-level: validation, the envelope, the required `Idempotency-Key`, and the promise
 * that a rejected declaration writes **nothing**. The signature's behaviour against a real
 * store is `test/integration/attachments.int.test.ts`'s, because a presigner asserting its
 * own output proves nothing about whether a store honours it.
 */
const ddbMock = mockClient(DynamoDBDocumentClient);

let createApp: typeof CreateApp;

const DEV = 'usr_local_dev';
const PATH = 'http://localhost/v1/attachments/upload-url';

/**
 * The pending-upload write, picked out of the domain + receipt transaction.
 *
 * The route is authenticated **and** creating, so two middlewares write before the handler
 * does: `rateLimit` bumps a counter and `idempotency` reserves a record. Asserting on the
 * first `Put` would inspect one of those — the mistake `me.test.ts` documents having made.
 */
const uploadPuts = () =>
  ddbMock
    .commandCalls(TransactWriteCommand)
    .flatMap((call) => call.args[0].input.TransactItems ?? [])
    .flatMap((item) => (item.Put === undefined ? [] : [item.Put]))
    .filter((put) => String(put.Item?.entity) === 'PendingUpload');

/**
 * A fresh key per request. It must be a **UUID**: the middleware validates the shape, so a
 * readable counter like `key-1` is a `400` before the handler runs — which reads as the
 * endpoint rejecting the body and is why the header is built here rather than at each call.
 */
const headers = (overrides: Record<string, string> = {}) => ({
  'Content-Type': 'application/json',
  'Idempotency-Key': randomUUID(),
  ...overrides,
});

const post = async (body: unknown, extraHeaders?: Record<string, string>) =>
  createApp().fetch(
    new Request(PATH, {
      method: 'POST',
      headers: headers(extraHeaders),
      body: JSON.stringify(body),
    }),
  );

beforeEach(async () => {
  ddbMock.reset();
  ddbMock.on(TransactWriteCommand).resolves({});
  // The drain runs first on every request and reads the caller's unresolved set.
  ddbMock.resolves({ Items: [] });
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

describe('POST /v1/attachments/upload-url', () => {
  it('answers 201 with the id, a presigned URL and the temporary key', async () => {
    const response = await post({ contentType: 'image/jpeg', byteSize: 2048 });
    const body = (await response.json()) as {
      data: { attachmentId: string; uploadUrl: string; key: string };
      meta: { requestId: string };
    };

    expect(response.status).toBe(201);
    expect(body.data.attachmentId).toMatch(/^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(body.data.key).toBe(
      `tmp/u/${DEV}/${body.data.attachmentId.slice('att_'.length)}.jpg`,
    );
    expect(body.meta.requestId).toBeTruthy();
  });

  /**
   * The signature is checked in full against MinIO; what matters here is that the URL the
   * **endpoint** returns is a signed one at all, and that the two halves of the promise are
   * both in it.
   */
  it('returns a signature that covers the declared type and length', async () => {
    const response = await post({ contentType: 'image/png', byteSize: 4096 });
    const { data } = (await response.json()) as { data: { uploadUrl: string } };
    const params = new URL(data.uploadUrl).searchParams;

    expect(params.get('X-Amz-Signature')).toBeTruthy();
    expect(params.get('X-Amz-Expires')).toBe('300');
    expect(params.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
      expect.arrayContaining(['content-length', 'content-type']),
    );
  });

  /** The record is committed before the caller ever holds the URL. */
  it('writes the pending record for the id it returns', async () => {
    const response = await post({ contentType: 'image/webp', byteSize: 1234 });
    const { data } = (await response.json()) as { data: { attachmentId: string } };

    const puts = uploadPuts();
    expect(puts).toHaveLength(1);
    expect(puts[0]?.Item).toMatchObject({
      attachmentId: data.attachmentId,
      userId: DEV,
      contentType: 'image/webp',
      byteSize: 1234,
      state: 'awaiting_upload',
    });
    expect(puts[0]?.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  /** Storage keys never leave the repository layer (`agent-playbook.md` §6.11). */
  it('exposes no pk, sk, entity or final key', async () => {
    const response = await post({ contentType: 'image/jpeg', byteSize: 2048 });
    const body = (await response.json()) as { data: Record<string, unknown> };

    expect(Object.keys(body.data).sort()).toEqual(['attachmentId', 'key', 'uploadUrl']);
    expect(JSON.stringify(body.data)).not.toContain('USER#');
  });

  describe('refuses a declaration it cannot honour, and writes nothing', () => {
    it.each([
      [
        'an eleven-megabyte image',
        { contentType: 'image/jpeg', byteSize: 11 * 1024 * 1024 },
      ],
      ['a PDF', { contentType: 'application/pdf', byteSize: 2048 }],
      ['a zero-byte declaration', { contentType: 'image/jpeg', byteSize: 0 }],
      ['a missing byteSize', { contentType: 'image/jpeg' }],
      ['a caller-chosen key', { contentType: 'image/jpeg', byteSize: 1, key: 'tmp/x' }],
      [
        'a caller-chosen id',
        {
          contentType: 'image/jpeg',
          byteSize: 1,
          attachmentId: 'att_01J8XKQ2M4N5P6R7S8T9V0W1X2',
        },
      ],
    ])('%s is a 400 in the contract envelope', async (_name, body) => {
      const response = await post(body);
      const parsed = (await response.json()) as {
        error: { code: string; requestId: string };
      };

      expect(response.status).toBe(400);
      expect(parsed.error.code).toBe('validation_failed');
      expect(parsed.error.requestId).toBeTruthy();
      expect(uploadPuts()).toEqual([]);
    });

    /** Exactly the cap is accepted; the rejection above is one byte over. */
    it('accepts exactly ten megabytes', async () => {
      const response = await post({
        contentType: 'image/jpeg',
        byteSize: MAX_UPLOAD_BYTES,
      });
      expect(response.status).toBe(201);
    });
  });

  /**
   * `mutates: true` in the registry, so the middleware requires the header. Without it a
   * retried request would mint a second id, a second object key and a second pending record
   * for one upload the client believes is one.
   */
  it('requires an Idempotency-Key', async () => {
    const response = await createApp().fetch(
      new Request(PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: 'image/jpeg', byteSize: 2048 }),
      }),
    );

    expect(response.status).toBe(400);
    expect(uploadPuts()).toEqual([]);
  });

  /** The write and its replay receipt commit together, or neither does. */
  it('stores the receipt in the same transaction as the record', async () => {
    await post({ contentType: 'image/jpeg', byteSize: 2048 });

    const withRecord = ddbMock
      .commandCalls(TransactWriteCommand)
      .map((call) => call.args[0].input.TransactItems ?? [])
      .find((items) =>
        items.some((item) => String(item.Put?.Item?.entity) === 'PendingUpload'),
      );

    expect(withRecord).toBeDefined();
    expect(
      withRecord?.some((item) => String(item.Put?.Item?.pk).startsWith('IDEM#')),
    ).toBe(true);
  });
});
