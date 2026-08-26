import { MAX_UNRESOLVED_UPLOADS } from '@od/shared/constants';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingUpload } from '../repositories/pendingUploadRepository.js';

/**
 * The upload-url service, with the repository and the object store mocked
 * (`testing.md` §4.2). What is asserted here is the **order and the arithmetic**: drain
 * before cap, cap before mint, object before row, record before response. Whether a store
 * actually refuses a mismatched upload is `test/integration/attachments.int.test.ts`'s.
 */

const deleteObject = vi.fn<(key: string) => Promise<void>>();
const presignUpload = vi.fn<(request: unknown) => Promise<string>>();
const listPendingUploads = vi.fn<(userId: string) => Promise<PendingUpload[]>>();
const putPendingUpload =
  vi.fn<(record: PendingUpload, receipt?: unknown) => Promise<void>>();
const deletePendingUpload =
  vi.fn<(userId: string, attachmentId: string) => Promise<void>>();

vi.mock('../lib/s3.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/s3.js')>('../lib/s3.js');
  return {
    ...actual,
    presignUpload: (request: unknown) => presignUpload(request),
    deleteObject: (key: string) => deleteObject(key),
  };
});

vi.mock('../repositories/pendingUploadRepository.js', async () => {
  const actual = await vi.importActual<
    typeof import('../repositories/pendingUploadRepository.js')
  >('../repositories/pendingUploadRepository.js');
  return {
    ...actual,
    listPendingUploads: (userId: string) => listPendingUploads(userId),
    putPendingUpload: (record: PendingUpload, receipt?: unknown) =>
      putPendingUpload(record, receipt),
    deletePendingUpload: (userId: string, attachmentId: string) =>
      deletePendingUpload(userId, attachmentId),
  };
});

const { drainPendingUploads, requestUploadUrl } = await import('./attachmentService.js');

const USER = 'usr_local_dev';
const NOW = '2026-08-26T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);

function record(overrides: Partial<PendingUpload> = {}): PendingUpload {
  return {
    attachmentId: 'att_01J8XKQ2M4N5P6R7S8T9V0W1X2',
    userId: USER,
    tmpKey: 'tmp/u/usr_local_dev/01J8XKQ2M4N5P6R7S8T9V0W1X2.jpg',
    finalKey: 'u/usr_local_dev/01J8XKQ2M4N5P6R7S8T9V0W1X2.jpg',
    contentType: 'image/jpeg',
    byteSize: 2048,
    state: 'awaiting_upload',
    createdAt: '2026-08-25T12:00:00.000Z',
    // An hour in the future: still live.
    cleanupAfter: '2026-08-26T13:00:00.000Z',
    ...overrides,
  };
}

const expired = (index: number) =>
  record({
    attachmentId: `att_expired_${index}`,
    tmpKey: `tmp/u/${USER}/expired_${index}.jpg`,
    cleanupAfter: '2026-08-26T11:59:59.999Z',
  });

const live = (index: number) => record({ attachmentId: `att_live_${index}` });

beforeEach(() => {
  vi.clearAllMocks();
  listPendingUploads.mockResolvedValue([]);
  putPendingUpload.mockResolvedValue();
  deletePendingUpload.mockResolvedValue();
  deleteObject.mockResolvedValue();
  presignUpload.mockResolvedValue('https://store.example/tmp?X-Amz-Signature=abc');
});

describe('drainPendingUploads', () => {
  /**
   * The order is the point. The row is the only record that the object exists, so deleting it
   * first would strand the object until the bucket's lifecycle rule caught it — the exact
   * undiscoverable-orphan case the record is there to prevent.
   */
  it('deletes an expired record’s object before its row', async () => {
    const order: string[] = [];
    deleteObject.mockImplementation(async () => {
      order.push('object');
    });
    deletePendingUpload.mockImplementation(async () => {
      order.push('row');
    });
    listPendingUploads.mockResolvedValue([expired(1)]);

    await expect(drainPendingUploads(USER, NOW_MS)).resolves.toBe(0);

    expect(order).toEqual(['object', 'row']);
    expect(deleteObject).toHaveBeenCalledWith(`tmp/u/${USER}/expired_1.jpg`);
    expect(deletePendingUpload).toHaveBeenCalledWith(USER, 'att_expired_1');
  });

  it('leaves an unexpired awaiting_upload alone and counts it live', async () => {
    listPendingUploads.mockResolvedValue([live(1), live(2)]);

    await expect(drainPendingUploads(USER, NOW_MS)).resolves.toBe(2);

    expect(deleteObject).not.toHaveBeenCalled();
    expect(deletePendingUpload).not.toHaveBeenCalled();
  });

  /**
   * A `confirming` row may already have a permanent copy behind it. Completing or cleaning
   * one is P3-22's confirm path; until that lands the safe direction is to leave the row —
   * an untouched row is still discoverable work, while a row deleted by a function that
   * cannot finish that work is a permanent orphan.
   */
  it('never touches a confirming record, even an expired one', async () => {
    listPendingUploads.mockResolvedValue([
      record({ ...expired(1), state: 'confirming', activityId: 'act_1' }),
    ]);

    await expect(drainPendingUploads(USER, NOW_MS)).resolves.toBe(1);

    expect(deleteObject).not.toHaveBeenCalled();
    expect(deletePendingUpload).not.toHaveBeenCalled();
  });

  /** Exactly at `cleanupAfter` is expired; a millisecond later is not. */
  it('treats the cleanup instant itself as expired', async () => {
    listPendingUploads.mockResolvedValue([record({ cleanupAfter: NOW })]);
    await expect(drainPendingUploads(USER, NOW_MS)).resolves.toBe(0);

    vi.clearAllMocks();
    listPendingUploads.mockResolvedValue([
      record({ cleanupAfter: new Date(NOW_MS + 1).toISOString() }),
    ]);
    await expect(drainPendingUploads(USER, NOW_MS)).resolves.toBe(1);
  });

  /**
   * A store that cannot be reached is a visible failure, not a row deleted anyway and an
   * object left for the lifecycle rule. An endpoint whose whole output is a URL to that same
   * store has nothing useful to answer when it is unreachable.
   */
  it('propagates a store failure rather than deleting the row regardless', async () => {
    listPendingUploads.mockResolvedValue([expired(1)]);
    deleteObject.mockRejectedValue(new Error('store unreachable'));

    await expect(drainPendingUploads(USER, NOW_MS)).rejects.toThrow('store unreachable');
    expect(deletePendingUpload).not.toHaveBeenCalled();
  });

  it('logs each collected record by its opaque id, and never its key', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    listPendingUploads.mockResolvedValue([expired(1)]);

    await drainPendingUploads(USER, NOW_MS, log as never);

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]?.[0]).toEqual({
      event: 'pending_upload_drained',
      userId: USER,
      attachmentId: 'att_expired_1',
    });
    expect(JSON.stringify(log.info.mock.calls[0])).not.toContain('tmp/');
  });
});

describe('requestUploadUrl', () => {
  const input = { contentType: 'image/jpeg', byteSize: 2048 } as const;

  it('drains first, then records, then answers', async () => {
    const order: string[] = [];
    listPendingUploads.mockImplementation(async () => {
      order.push('drain');
      return [];
    });
    presignUpload.mockImplementation(async () => {
      order.push('presign');
      return 'https://store.example/tmp?X-Amz-Signature=abc';
    });
    putPendingUpload.mockImplementation(async () => {
      order.push('put');
    });

    const result = await requestUploadUrl(USER, input, NOW);

    expect(order).toEqual(['drain', 'presign', 'put']);
    expect(result.uploadUrl).toBe('https://store.example/tmp?X-Amz-Signature=abc');
  });

  /**
   * The id, the keys and the object key's filename are one value in three places. A pair of
   * stored values could drift, and one confirmation reading the wrong half would copy
   * somebody's picture over somebody else's key.
   */
  it('derives both keys and the returned key from the minted id', async () => {
    const result = await requestUploadUrl(USER, input, NOW);
    const written = putPendingUpload.mock.calls[0]?.[0] as PendingUpload;
    const ulid = result.attachmentId.slice('att_'.length);

    expect(result.attachmentId).toMatch(/^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(written.tmpKey).toBe(`tmp/u/${USER}/${ulid}.jpg`);
    expect(written.finalKey).toBe(`u/${USER}/${ulid}.jpg`);
    expect(result.key).toBe(written.tmpKey);
  });

  it('records the declaration, awaiting_upload, and a one-day cleanup', async () => {
    await requestUploadUrl(USER, { contentType: 'image/heic', byteSize: 4096 }, NOW);
    const written = putPendingUpload.mock.calls[0]?.[0] as PendingUpload;

    expect(written).toMatchObject({
      userId: USER,
      contentType: 'image/heic',
      byteSize: 4096,
      state: 'awaiting_upload',
      createdAt: NOW,
      cleanupAfter: '2026-08-27T12:00:00.000Z',
    });
    // Absent until confirmation names a target — the reason the row is keyed by the uploader.
    expect(written).not.toHaveProperty('activityId');
  });

  it('signs exactly what was declared, at the temporary key', async () => {
    await requestUploadUrl(USER, { contentType: 'image/png', byteSize: 999 }, NOW);
    const written = putPendingUpload.mock.calls[0]?.[0] as PendingUpload;

    expect(presignUpload).toHaveBeenCalledWith({
      key: written.tmpKey,
      contentType: 'image/png',
      byteSize: 999,
    });
  });

  /** Tests only; the default is the contract's five minutes and is passed by omission. */
  it('passes an injected expiry through, and nothing when there is none', async () => {
    await requestUploadUrl(USER, input, NOW, { expiresInSeconds: 1 });
    expect(presignUpload.mock.calls[0]?.[0]).toMatchObject({ expiresInSeconds: 1 });

    vi.clearAllMocks();
    listPendingUploads.mockResolvedValue([]);
    presignUpload.mockResolvedValue('https://store.example/tmp');
    await requestUploadUrl(USER, input, NOW);
    expect(presignUpload.mock.calls[0]?.[0]).not.toHaveProperty('expiresInSeconds');
  });

  /**
   * The response carries three server-decided values, so the receipt is built **from** it.
   * A receipt assembled before the id existed would store a body naming an attachment that
   * was never written.
   */
  it('builds the replay receipt from the finished response', async () => {
    const receipt = { userId: USER, key: 'k' };
    const receiptFor = vi.fn(() => receipt as never);

    const result = await requestUploadUrl(USER, input, NOW, { receiptFor });

    expect(receiptFor).toHaveBeenCalledWith(result);
    expect(putPendingUpload).toHaveBeenCalledWith(expect.anything(), receipt);
  });

  it('writes no receipt item when none is asked for', async () => {
    await requestUploadUrl(USER, input, NOW);
    expect(putPendingUpload).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  describe('the twenty-record cap', () => {
    it('refuses the twenty-first and writes nothing', async () => {
      listPendingUploads.mockResolvedValue(
        Array.from({ length: MAX_UNRESOLVED_UPLOADS }, (_, i) => live(i)),
      );

      await expect(requestUploadUrl(USER, input, NOW)).rejects.toMatchObject({
        code: 'validation_failed',
        message: expect.stringContaining(String(MAX_UNRESOLVED_UPLOADS)),
      });
      expect(putPendingUpload).not.toHaveBeenCalled();
      expect(presignUpload).not.toHaveBeenCalled();
    });

    /**
     * The cap counts what is **left after** the drain, not what was read. Nineteen live rows
     * beside an expired one is capacity, not a refusal — otherwise abandoning uploads would
     * lock a user out for a day with nothing able to release them.
     */
    it('counts what survives the drain, not what was read', async () => {
      listPendingUploads.mockResolvedValue([
        ...Array.from({ length: MAX_UNRESOLVED_UPLOADS - 1 }, (_, i) => live(i)),
        expired(1),
      ]);

      await expect(requestUploadUrl(USER, input, NOW)).resolves.toMatchObject({
        key: expect.stringContaining('tmp/'),
      });
      expect(deletePendingUpload).toHaveBeenCalledWith(USER, 'att_expired_1');
    });

    it('allows the twentieth', async () => {
      listPendingUploads.mockResolvedValue(
        Array.from({ length: MAX_UNRESOLVED_UPLOADS - 1 }, (_, i) => live(i)),
      );
      await expect(requestUploadUrl(USER, input, NOW)).resolves.toHaveProperty(
        'attachmentId',
      );
    });
  });
});
