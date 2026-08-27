import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { MAX_UPLOAD_BYTES } from '../constants.js';
import type {
  RequestUploadUrlInput,
  RequestUploadUrlResult,
} from '../types/attachment.js';
import {
  attachment,
  requestUploadUrlInput,
  requestUploadUrlResult,
} from './attachment.js';

/**
 * The schema and the type describe one shape. Nothing forces them to agree, so this does —
 * in both directions, because a one-way assertion passes happily when one side gains a field
 * the other lacks. Same shape as `device.test.ts`.
 */
describe('the schema and the type are the same shape', () => {
  it('RequestUploadUrlInput is assignable both ways', () => {
    expectTypeOf<
      z.infer<typeof requestUploadUrlInput>
    >().toEqualTypeOf<RequestUploadUrlInput>();
  });

  it('RequestUploadUrlResult is assignable both ways', () => {
    expectTypeOf<
      z.infer<typeof requestUploadUrlResult>
    >().toEqualTypeOf<RequestUploadUrlResult>();
  });
});

describe('the upload-url request', () => {
  const valid: RequestUploadUrlInput = { contentType: 'image/jpeg', byteSize: 2048 };

  it.each(['image/jpeg', 'image/png', 'image/heic', 'image/webp'] as const)(
    'accepts %s',
    (contentType) => {
      expect(requestUploadUrlInput.safeParse({ ...valid, contentType }).success).toBe(
        true,
      );
    },
  );

  /**
   * The four are the whole list. `image/heic` is on it because the iOS camera produces it and
   * the client does not transcode; `image/gif`, `image/svg+xml` and `application/pdf` are
   * off it, and the last of those is acceptance criterion 23's case.
   */
  it.each(['application/pdf', 'image/gif', 'image/svg+xml', 'text/plain', 'image/*'])(
    'refuses %s',
    (contentType) => {
      expect(requestUploadUrlInput.safeParse({ ...valid, contentType }).success).toBe(
        false,
      );
    },
  );

  it('accepts exactly the cap', () => {
    expect(
      requestUploadUrlInput.safeParse({ ...valid, byteSize: MAX_UPLOAD_BYTES }).success,
    ).toBe(true);
  });

  it('refuses one byte over the cap', () => {
    expect(
      requestUploadUrlInput.safeParse({ ...valid, byteSize: MAX_UPLOAD_BYTES + 1 })
        .success,
    ).toBe(false);
  });

  /**
   * Zero would reserve a record and an object key for something that could never be a
   * picture; a negative or fractional size would be signed into a `Content-Length` no client
   * could satisfy.
   */
  it.each([0, -1, 1.5])('refuses a byteSize of %s', (byteSize) => {
    expect(requestUploadUrlInput.safeParse({ ...valid, byteSize }).success).toBe(false);
  });

  it.each(['contentType', 'byteSize'])('requires %s', (field) => {
    const body: Record<string, unknown> = { ...valid };
    delete body[field];
    expect(requestUploadUrlInput.safeParse(body).success).toBe(false);
  });

  /**
   * **Strict.** A caller-supplied `attachmentId` or `key` would be a caller choosing the
   * object key media is served under (ADR-023), so it is a named `400` rather than a field
   * silently dropped.
   */
  it.each([
    { attachmentId: 'att_01J8XKQ2M4N5P6R7S8T9V0W1X2' },
    { key: 'tmp/u/usr_a/01.jpg' },
    { uploadUrl: 'https://example.com' },
    { activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2' },
  ])('refuses the extra field %o', (extra) => {
    expect(requestUploadUrlInput.safeParse({ ...valid, ...extra }).success).toBe(false);
  });
});

describe('the upload-url result', () => {
  const valid: RequestUploadUrlResult = {
    attachmentId: 'att_01J8XKQ2M4N5P6R7S8T9V0W1X2',
    uploadUrl: 'https://od-media-local.s3.us-east-1.amazonaws.com/tmp/u/usr_a/01.jpg?x=1',
    key: 'tmp/u/usr_a/01.jpg',
  };

  it('accepts the issued grant', () => {
    expect(requestUploadUrlResult.safeParse(valid).success).toBe(true);
  });

  it('requires a prefixed ULID for the attachment id', () => {
    expect(
      requestUploadUrlResult.safeParse({ ...valid, attachmentId: 'att_nope' }).success,
    ).toBe(false);
    expect(
      requestUploadUrlResult.safeParse({
        ...valid,
        attachmentId: '01J8XKQ2M4N5P6R7S8T9V0W1X2',
      }).success,
    ).toBe(false);
  });

  /** A key is a key. Anything that parses as a URL here would mean the API had named a host. */
  it('takes a bare object key, not a URL', () => {
    expect(requestUploadUrlResult.safeParse({ ...valid, key: '' }).success).toBe(false);
    expect(valid.key.startsWith('tmp/')).toBe(true);
  });
});

describe('the linked attachment', () => {
  const linked = {
    attachmentId: 'att_01J8XKQ2M4N5P6R7S8T9V0W1X2',
    activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
    key: 'u/usr_a/01.jpg',
    contentType: 'image/jpeg',
    byteSize: 2048,
    createdAt: '2026-08-26T12:00:00.000Z',
    schemaVersion: 1,
  } as const;

  it('accepts an ISO instant and rejects arbitrary visible timestamp text', () => {
    expect(attachment.safeParse(linked).success).toBe(true);
    expect(attachment.safeParse({ ...linked, createdAt: 'yesterday' }).success).toBe(
      false,
    );
  });
});
