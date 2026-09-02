import { MAX_UPLOAD_BYTES } from '@od/shared';
import { UploadFailedError } from '@od/shared/client';
import { describe, expect, it } from 'vitest';
import {
  contentTypeOf,
  isExpiredUploadUrl,
  preCheck,
  TOO_LARGE_MESSAGE,
  UNSUPPORTED_TYPE_MESSAGE,
} from './uploadPolicy';

/** The pre-network decisions of an upload (P3-41 step 2 and step 5). */

const image = (patch: Partial<Parameters<typeof preCheck>[0]> = {}) => ({
  uri: 'file:///tmp/photo.jpg',
  mimeType: 'image/jpeg',
  fileName: 'photo.jpg',
  byteSize: 1024,
  ...patch,
});

describe('preCheck', () => {
  it.each(['image/jpeg', 'image/png', 'image/heic', 'image/webp'] as const)(
    'accepts %s within the cap',
    (mimeType) => {
      expect(preCheck(image({ mimeType }))).toEqual({
        ok: true,
        contentType: mimeType,
        byteSize: 1024,
      });
    },
  );

  /** HEIC from the iOS camera uploads as-is — no client transcode (§P3-41 edge case). */
  it('lets HEIC through untouched', () => {
    expect(
      preCheck(image({ mimeType: 'image/heic', fileName: 'IMG_0001.HEIC' })).ok,
    ).toBe(true);
  });

  it('refuses a PDF with the type message', () => {
    expect(
      preCheck(image({ mimeType: 'application/pdf', fileName: 'menu.pdf' })),
    ).toEqual({
      ok: false,
      message: UNSUPPORTED_TYPE_MESSAGE,
    });
  });

  it('refuses an 11 MB image with the size message', () => {
    expect(preCheck(image({ byteSize: 11 * 1024 * 1024 }))).toEqual({
      ok: false,
      message: TOO_LARGE_MESSAGE,
    });
  });

  it('accepts exactly the cap and refuses one byte over it', () => {
    expect(preCheck(image({ byteSize: MAX_UPLOAD_BYTES })).ok).toBe(true);
    expect(preCheck(image({ byteSize: MAX_UPLOAD_BYTES + 1 })).ok).toBe(false);
  });

  it('refuses an empty file', () => {
    expect(preCheck(image({ byteSize: 0 })).ok).toBe(false);
  });
});

describe('contentTypeOf', () => {
  it('prefers the declared type and normalises image/jpg', () => {
    expect(contentTypeOf(image({ mimeType: 'image/jpg' }))).toBe('image/jpeg');
    expect(contentTypeOf(image({ mimeType: 'image/webp', fileName: 'x.png' }))).toBe(
      'image/webp',
    );
  });

  it('falls back to the extension when the picker gives no type', () => {
    expect(contentTypeOf(image({ mimeType: undefined, fileName: 'IMG.HEIC' }))).toBe(
      'image/heic',
    );
    expect(
      contentTypeOf(
        image({ mimeType: undefined, fileName: undefined, uri: 'blob:x/y.png?1' }),
      ),
    ).toBe('image/png');
    expect(
      contentTypeOf(image({ mimeType: 'application/octet-stream', fileName: 'a.jpg' })),
    ).toBe('image/jpeg');
  });

  it('answers undefined for an unknown extension, which the pre-check then refuses', () => {
    expect(
      contentTypeOf(image({ mimeType: undefined, fileName: 'notes.txt' })),
    ).toBeUndefined();
  });
});

describe('isExpiredUploadUrl', () => {
  it('recognises the store saying the signature lapsed', () => {
    expect(
      isExpiredUploadUrl(
        new UploadFailedError(
          403,
          '<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>',
        ),
      ),
    ).toBe(true);
  });

  /** A content-type mismatch is also a 403 — and is a real rejection, not a lapse. */
  it('does not mistake any other 403 for an expiry', () => {
    expect(isExpiredUploadUrl(new UploadFailedError(403, 'SignatureDoesNotMatch'))).toBe(
      false,
    );
    expect(isExpiredUploadUrl(new UploadFailedError(500, 'Request has expired'))).toBe(
      false,
    );
    expect(isExpiredUploadUrl(new Error('Request has expired'))).toBe(false);
  });
});
