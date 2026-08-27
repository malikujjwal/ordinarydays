import { randomUUID } from 'node:crypto';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
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
/**
 * The object store, mocked **only where a route reaches it**.
 *
 * `presignUpload` stays real: signing is pure local cryptography, it makes no request, and it
 * is the thing `upload-url`'s tests are about. `deleteObject` is the one call a route makes
 * that needs a network, and a route test is the wrong layer to prove what a store does with
 * it — `test/integration/attachments.int.test.ts` is.
 */
const deleteObject = vi.fn<(key: string) => Promise<void>>();
vi.mock('../lib/s3.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/s3.js')>('../lib/s3.js');
  return { ...actual, deleteObject: (key: string) => deleteObject(key) };
});

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
  deleteObject.mockReset();
  deleteObject.mockResolvedValue();
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

/**
 * The two activity-scoped routes (P3-22).
 *
 * Endpoint-level only: the envelope, the statuses, the required key, and that a refusal
 * writes nothing. The state machine itself is proved beside its service and end-to-end
 * against MinIO — a route test that mocked S3 would be asserting its own mock.
 */
describe('the activity-scoped attachment routes', () => {
  const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1XA';
  const ATT = 'att_01J8XKQ2M4N5P6R7S8T9V0W1XB';
  const CONFIRM = `http://localhost/v1/activities/${ACT}/attachments`;
  const ONE = `${CONFIRM}/${ATT}`;

  const attachmentRow = {
    pk: `ACT#${ACT}`,
    sk: `ATT#${ATT}`,
    entity: 'Attachment',
    attachmentId: ATT,
    activityId: ACT,
    key: `u/${DEV}/01J8XKQ2M4N5P6R7S8T9V0W1XB.jpg`,
    contentType: 'image/jpeg',
    byteSize: 2048,
    createdAt: '2026-08-26T12:00:00.000Z',
    schemaVersion: 1,
  };

  const meta = (overrides: Record<string, unknown> = {}) => ({
    pk: `ACT#${ACT}`,
    sk: 'META',
    entity: 'Activity',
    activityId: ACT,
    ownerId: DEV,
    objectKind: 'plan',
    type: 'event',
    status: 'saved',
    title: 'New York Trip',
    details: { kind: 'event' },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: '2026-08-26T09:00:00.000Z',
    lastActivityAt: '2026-08-26T09:00:00.000Z',
    updatedAt: '2026-08-26T09:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  });

  const attachmentDeletes = () =>
    ddbMock
      .commandCalls(TransactWriteCommand)
      .flatMap((call) => call.args[0].input.TransactItems ?? [])
      .filter((item) => String(item.Delete?.Key?.sk).startsWith('ATT#'));

  beforeEach(() => {
    // The activity exists and the caller owns it; the attachment is already linked, which is
    // the one path that needs no object store at all.
    ddbMock.on(GetCommand).resolves({ Item: meta() });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
  });

  describe('POST /v1/activities/:id/attachments', () => {
    const confirm = async (body: unknown, extra?: Record<string, string>) =>
      createApp().fetch(
        new Request(CONFIRM, {
          method: 'POST',
          headers: headers(extra),
          body: JSON.stringify(body),
        }),
      );

    /**
     * Re-confirming is the one branch reachable without a store, and it is the branch worth
     * pinning at this layer: a client that lost its response gets `201` and the row that is
     * already there, not a different status for its retry.
     */
    it('answers 201 with the existing row when the id is already linked', async () => {
      ddbMock.on(GetCommand).callsFake((input) => ({
        Item: String(input.Key?.sk).startsWith('ATT#') ? attachmentRow : meta(),
      }));

      const response = await confirm({ attachmentId: ATT });
      const body = (await response.json()) as {
        data: Record<string, unknown>;
        meta: { requestId: string };
      };

      expect(response.status).toBe(201);
      expect(body.data.attachmentId).toBe(ATT);
      expect(body.data.key).toBe(`u/${DEV}/01J8XKQ2M4N5P6R7S8T9V0W1XB.jpg`);
      expect(body.meta.requestId).toBeTruthy();
    });

    /** Storage keys never leave the repository layer, and a key is never a URL (ADR-023). */
    it('exposes no pk, sk or entity, and no URL', async () => {
      ddbMock.on(GetCommand).callsFake((input) => ({
        Item: String(input.Key?.sk).startsWith('ATT#') ? attachmentRow : meta(),
      }));

      const { data } = (await (await confirm({ attachmentId: ATT })).json()) as {
        data: Record<string, unknown>;
      };

      expect(Object.keys(data).sort()).toEqual([
        'activityId',
        'attachmentId',
        'byteSize',
        'contentType',
        'createdAt',
        'key',
        'schemaVersion',
      ]);
      expect(JSON.stringify(data)).not.toContain('://');
    });

    it.each([
      ['a missing attachmentId', {}],
      ['a malformed attachmentId', { attachmentId: 'att_nope' }],
      ['a caller-chosen key', { attachmentId: ATT, key: 'u/x.jpg' }],
      ['a caller-chosen contentType', { attachmentId: ATT, contentType: 'image/png' }],
    ])('%s is a 400 in the contract envelope, writing nothing', async (_name, body) => {
      const response = await confirm(body);
      const parsed = (await response.json()) as {
        error: { code: string; requestId: string };
      };

      expect(response.status).toBe(400);
      expect(parsed.error.code).toBe('validation_failed');
      expect(parsed.error.requestId).toBeTruthy();
      expect(attachmentDeletes()).toEqual([]);
    });

    /** A stranger's activity is `404`, never `403` (`definition-of-done.md` §7 rule 5). */
    it('404s an activity the caller does not own', async () => {
      ddbMock.on(GetCommand).resolves({ Item: meta({ ownerId: 'usr_someone_else' }) });

      const response = await confirm({ attachmentId: ATT });

      expect(response.status).toBe(404);
    });

    it('requires an Idempotency-Key', async () => {
      const response = await createApp().fetch(
        new Request(CONFIRM, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attachmentId: ATT }),
        }),
      );

      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /v1/activities/:id/attachments/:attachmentId', () => {
    const remove = async () =>
      createApp().fetch(new Request(ONE, { method: 'DELETE', headers: headers() }));

    beforeEach(() => {
      ddbMock.on(GetCommand).callsFake((input) => ({
        Item: String(input.Key?.sk).startsWith('ATT#') ? attachmentRow : meta(),
      }));
    });

    it('answers 200 with the id and whether the cover was cleared', async () => {
      const response = await remove();
      const body = (await response.json()) as { data: Record<string, unknown> };

      expect(response.status).toBe(200);
      expect(body.data).toEqual({ attachmentId: ATT, coverCleared: false });
      expect(attachmentDeletes()).toHaveLength(1);
    });

    it('reports the cover cleared when the deleted attachment was the hero', async () => {
      ddbMock.on(GetCommand).callsFake((input) => ({
        Item: String(input.Key?.sk).startsWith('ATT#')
          ? attachmentRow
          : meta({ primaryAttachmentId: ATT }),
      }));

      const { data } = (await (await remove()).json()) as {
        data: Record<string, unknown>;
      };

      expect(data).toEqual({ attachmentId: ATT, coverCleared: true });
    });

    /** A repeat is `404`, which for the caller means "already gone". */
    it('404s an id that names no attachment on this activity', async () => {
      ddbMock.on(GetCommand).callsFake((input) => ({
        Item:
          String(input.Key?.sk).startsWith('ATT#') ||
          String(input.Key?.sk).startsWith('MEDIA_DELETE#')
            ? undefined
            : meta(),
      }));

      const response = await remove();

      expect(response.status).toBe(404);
      expect(attachmentDeletes()).toEqual([]);
    });

    /** No `Idempotency-Key`: `DELETE` is idempotent by its own shape. */
    it('takes no Idempotency-Key', async () => {
      const response = await createApp().fetch(
        new Request(ONE, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      expect(response.status).toBe(200);
    });
  });
});
