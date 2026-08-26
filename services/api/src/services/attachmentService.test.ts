import {
  MAX_ATTACHMENTS_PER_ACTIVITY,
  MAX_UNRESOLVED_UPLOADS,
} from '@od/shared/constants';
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
const headObject =
  vi.fn<
    (key: string) => Promise<{ contentType?: string; byteSize?: number } | undefined>
  >();
const copyObject = vi.fn<(from: string, to: string) => Promise<void>>();
const listPendingUploads = vi.fn<(userId: string) => Promise<PendingUpload[]>>();
const putPendingUpload =
  vi.fn<(record: PendingUpload, receipt?: unknown) => Promise<void>>();
const deletePendingUpload =
  vi.fn<(userId: string, attachmentId: string) => Promise<void>>();
const getPendingUpload =
  vi.fn<(userId: string, attachmentId: string) => Promise<PendingUpload | undefined>>();
const markPendingConfirming =
  vi.fn<(userId: string, attachmentId: string, activityId: string) => Promise<void>>();
const getAttachment = vi.fn<(a: string, b: string) => Promise<unknown>>();
const listAttachments = vi.fn<(activityId: string) => Promise<unknown[]>>();
const linkAttachment =
  vi.fn<(userId: string, record: unknown, receipt?: unknown) => Promise<void>>();
const unlinkAttachment =
  vi.fn<(a: string, b: string, cover?: { now: string }) => Promise<void>>();
const getActivityMeta = vi.fn<(id: string, opts?: unknown) => Promise<unknown>>();
const assertActivityAccess =
  vi.fn<(u: string, a: string, l: string) => Promise<{ activity: unknown }>>();

vi.mock('../lib/s3.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/s3.js')>('../lib/s3.js');
  return {
    ...actual,
    presignUpload: (request: unknown) => presignUpload(request),
    deleteObject: (key: string) => deleteObject(key),
    headObject: (key: string) => headObject(key),
    copyObject: (from: string, to: string) => copyObject(from, to),
  };
});

vi.mock('../repositories/attachmentRepository.js', () => ({
  getAttachment: (a: string, b: string) => getAttachment(a, b),
  listAttachments: (activityId: string) => listAttachments(activityId),
  linkAttachment: (userId: string, record: unknown, receipt?: unknown) =>
    linkAttachment(userId, record, receipt),
  unlinkAttachment: (a: string, b: string, cover?: { now: string }) =>
    unlinkAttachment(a, b, cover),
}));

vi.mock('../repositories/activityRepository.js', () => ({
  getActivityMeta: (id: string, opts?: unknown) => getActivityMeta(id, opts),
}));

vi.mock('./authz.js', () => ({
  assertActivityAccess: (u: string, a: string, l: string) =>
    assertActivityAccess(u, a, l),
}));

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
    getPendingUpload: (userId: string, attachmentId: string) =>
      getPendingUpload(userId, attachmentId),
    markPendingConfirming: (userId: string, attachmentId: string, activityId: string) =>
      markPendingConfirming(userId, attachmentId, activityId),
  };
});

const {
  assertAttachmentsConfirmable,
  assertCoverIsLinked,
  confirmAttachment,
  deleteAttachment,
  drainPendingUploads,
  requestUploadUrl,
} = await import('./attachmentService.js');
const { AppError } = await import('../lib/errors.js');

/**
 * The `AppError` a call threw, typed.
 *
 * `promise.catch((e) => e as AppError)` widens to a union with the **resolved** type, so
 * every property access on the result fails to typecheck — and it quietly passes when the
 * call does not reject at all. This narrows, and fails loudly when nothing was thrown.
 */
async function rejection(
  promise: Promise<unknown>,
): Promise<InstanceType<typeof AppError>> {
  try {
    await promise;
  } catch (error) {
    return error as InstanceType<typeof AppError>;
  }
  throw new Error('expected the call to reject, and it resolved');
}

const USER = 'usr_local_dev';
const NOW = '2026-08-26T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1XA';
const ATT = 'att_01J8XKQ2M4N5P6R7S8T9V0W1X2';

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
    // Both keys, and they must agree: the permanent one is the temporary one minus `tmp/`,
    // and a fixture that let them drift would assert an order the real pair never produces.
    tmpKey: `tmp/u/${USER}/expired_${index}.jpg`,
    finalKey: `u/${USER}/expired_${index}.jpg`,
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
  headObject.mockResolvedValue({ contentType: 'image/jpeg', byteSize: 2048 });
  copyObject.mockResolvedValue();
  getPendingUpload.mockResolvedValue(record());
  markPendingConfirming.mockResolvedValue();
  getAttachment.mockResolvedValue(undefined);
  listAttachments.mockResolvedValue([]);
  linkAttachment.mockResolvedValue();
  unlinkAttachment.mockResolvedValue();
  getActivityMeta.mockResolvedValue({ activityId: ACT, ownerId: USER });
  assertActivityAccess.mockResolvedValue({
    activity: { activityId: ACT, ownerId: USER },
  });
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
   * An **unexpired** record of either kind is work that may still be in flight — a URL the
   * client is uploading to, or a confirmation running in another request. Repairing one
   * would race it.
   */
  it('leaves an unexpired confirming record alone', async () => {
    listPendingUploads.mockResolvedValue([
      record({ state: 'confirming', activityId: ACT }),
    ]);

    await expect(drainPendingUploads(USER, NOW_MS)).resolves.toBe(1);

    expect(getAttachment).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  describe('an expired confirming record (P3-22)', () => {
    const confirming = () =>
      record({ ...expired(1), state: 'confirming', activityId: ACT });

    /** The transaction committed and the crash was after it: finish what was left. */
    it('finishes the cleanup when the row is already there', async () => {
      listPendingUploads.mockResolvedValue([confirming()]);
      getAttachment.mockResolvedValue({ attachmentId: 'att_expired_1' });

      await expect(drainPendingUploads(USER, NOW_MS)).resolves.toBe(0);

      expect(linkAttachment).not.toHaveBeenCalled();
      expect(deleteObject).toHaveBeenCalledWith(`tmp/u/${USER}/expired_1.jpg`);
      expect(deletePendingUpload).toHaveBeenCalledWith(USER, 'att_expired_1');
    });

    /** The copy landed and the Activity is still there: complete the link. */
    it('completes a verified link', async () => {
      listPendingUploads.mockResolvedValue([confirming()]);

      await expect(drainPendingUploads(USER, NOW_MS)).resolves.toBe(0);

      expect(linkAttachment).toHaveBeenCalledTimes(1);
      expect(linkAttachment.mock.calls[0]?.[1]).toMatchObject({
        attachmentId: 'att_expired_1',
        activityId: ACT,
      });
      expect(deleteObject).toHaveBeenCalledWith(`tmp/u/${USER}/expired_1.jpg`);
    });

    /**
     * **Both keys, and the record last.** The record is the only thing that knows these two
     * keys exist, so removing it first would strand whichever object the next failure left.
     */
    it.each([
      ['the activity is gone', () => getActivityMeta.mockResolvedValue(undefined)],
      ['the copy never landed', () => headObject.mockResolvedValue(undefined)],
      [
        'the activity is somebody else’s',
        () =>
          getActivityMeta.mockResolvedValue({ activityId: ACT, ownerId: 'usr_other' }),
      ],
    ])('deletes both keys before the record when %s', async (_name, arrange) => {
      const order: string[] = [];
      listPendingUploads.mockResolvedValue([confirming()]);
      arrange();
      deleteObject.mockImplementation(async (key) => {
        order.push(key);
      });
      deletePendingUpload.mockImplementation(async () => {
        order.push('row');
      });

      await expect(drainPendingUploads(USER, NOW_MS)).resolves.toBe(0);

      expect(order).toEqual([
        `u/${USER}/expired_1.jpg`,
        `tmp/u/${USER}/expired_1.jpg`,
        'row',
      ]);
      expect(linkAttachment).not.toHaveBeenCalled();
    });

    /**
     * A row that contradicts its own invariant — `markPendingConfirming` writes both fields
     * together — is left alone. Deleting objects on the strength of a corrupt row is exactly
     * the wrong instinct.
     */
    it('leaves a confirming record with no recorded activity, and counts it live', async () => {
      listPendingUploads.mockResolvedValue([
        record({ ...expired(1), state: 'confirming' }),
      ]);

      await expect(drainPendingUploads(USER, NOW_MS)).resolves.toBe(1);

      expect(deleteObject).not.toHaveBeenCalled();
      expect(deletePendingUpload).not.toHaveBeenCalled();
    });
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

describe('confirmAttachment', () => {
  /**
   * The order the contract states, and every step of it matters. The one worth pinning hardest
   * is `markPendingConfirming` **before** `copyObject`: reverse those two and a crash between
   * them leaves a permanent object that no row has ever referred to — the undiscoverable
   * orphan the whole state machine exists to prevent.
   */
  it('marks the record confirming before it copies anything', async () => {
    const order: string[] = [];
    markPendingConfirming.mockImplementation(async () => {
      order.push('mark');
    });
    copyObject.mockImplementation(async () => {
      order.push('copy');
    });
    linkAttachment.mockImplementation(async () => {
      order.push('link');
    });
    deleteObject.mockImplementation(async () => {
      order.push('delete-tmp');
    });

    await confirmAttachment(USER, ACT, ATT, NOW);

    expect(order).toEqual(['mark', 'copy', 'link', 'delete-tmp']);
    expect(markPendingConfirming).toHaveBeenCalledWith(USER, ATT, ACT);
  });

  it('writes the row from the record, at the permanent key', async () => {
    const attachment = await confirmAttachment(USER, ACT, ATT, NOW);

    expect(attachment).toEqual({
      attachmentId: ATT,
      activityId: ACT,
      key: `u/${USER}/01J8XKQ2M4N5P6R7S8T9V0W1X2.jpg`,
      contentType: 'image/jpeg',
      byteSize: 2048,
      createdAt: NOW,
      schemaVersion: 1,
    });
    expect(linkAttachment.mock.calls[0]?.[1]).toEqual(attachment);
  });

  /** ADR-023: a key, never a URL. Nothing this service returns names a host. */
  it('returns a key and never a URL', async () => {
    const attachment = await confirmAttachment(USER, ACT, ATT, NOW);
    expect(attachment.key).not.toMatch(/^https?:/);
    expect(JSON.stringify(attachment)).not.toContain('://');
  });

  it('copies from the temporary key to the permanent one and verifies both', async () => {
    await confirmAttachment(USER, ACT, ATT, NOW);

    expect(copyObject).toHaveBeenCalledWith(
      `tmp/u/${USER}/01J8XKQ2M4N5P6R7S8T9V0W1X2.jpg`,
      `u/${USER}/01J8XKQ2M4N5P6R7S8T9V0W1X2.jpg`,
    );
    expect(headObject.mock.calls.map((call) => call[0])).toEqual([
      `tmp/u/${USER}/01J8XKQ2M4N5P6R7S8T9V0W1X2.jpg`,
      `u/${USER}/01J8XKQ2M4N5P6R7S8T9V0W1X2.jpg`,
    ]);
  });

  /** Owner-only (`plans-and-lists.md` §2.1 row 8), and before anything is read or written. */
  it('asks for owner access first', async () => {
    assertActivityAccess.mockRejectedValueOnce(new AppError('not_found', 'nope'));

    await expect(confirmAttachment(USER, ACT, ATT, NOW)).rejects.toThrow('nope');

    expect(assertActivityAccess).toHaveBeenCalledWith(USER, ACT, 'owner');
    expect(getPendingUpload).not.toHaveBeenCalled();
    expect(copyObject).not.toHaveBeenCalled();
  });

  describe('idempotent by resumption', () => {
    /** A client that lost its response, and one whose crash was at the transaction. */
    it('returns the existing row without touching the store', async () => {
      const already = { attachmentId: ATT, activityId: ACT, key: 'u/x.jpg' };
      getAttachment.mockResolvedValue(already);

      await expect(confirmAttachment(USER, ACT, ATT, NOW)).resolves.toBe(already);

      expect(getPendingUpload).not.toHaveBeenCalled();
      expect(copyObject).not.toHaveBeenCalled();
      expect(linkAttachment).not.toHaveBeenCalled();
    });

    /**
     * The receipt is still built on that path — it is what sets the response body — but no
     * receipt row is stored, because nothing was written. Same shape as the bridge's adopt
     * path.
     */
    it('builds the response body but stores no receipt when already linked', async () => {
      getAttachment.mockResolvedValue({ attachmentId: ATT, activityId: ACT });
      const receiptFor = vi.fn(() => ({ key: 'k' }) as never);

      await confirmAttachment(USER, ACT, ATT, NOW, { receiptFor });

      expect(receiptFor).toHaveBeenCalledTimes(1);
      expect(linkAttachment).not.toHaveBeenCalled();
    });

    /** On the write path the receipt commits with the row, or neither does. */
    it('passes the receipt into the link transaction', async () => {
      const receipt = { key: 'k' } as never;
      const receiptFor = vi.fn(() => receipt);

      const attachment = await confirmAttachment(USER, ACT, ATT, NOW, { receiptFor });

      expect(receiptFor).toHaveBeenCalledWith(attachment);
      expect(linkAttachment).toHaveBeenCalledWith(USER, attachment, receipt);
    });
  });

  describe('what it refuses, and what it leaves behind', () => {
    /**
     * Four states with one answer, because the recovery for all of them is the same: upload
     * again. Distinguishing them would also describe the caller's own storage back to them
     * one probe at a time.
     */
    it.each([
      ['no pending record', () => getPendingUpload.mockResolvedValue(undefined)],
      ['nothing uploaded', () => headObject.mockResolvedValue(undefined)],
      [
        'a different type than declared',
        () => headObject.mockResolvedValue({ contentType: 'image/png', byteSize: 2048 }),
      ],
      [
        'a different length than declared',
        () => headObject.mockResolvedValue({ contentType: 'image/jpeg', byteSize: 9 }),
      ],
    ])('refuses %s with validation_failed and writes nothing', async (_name, arrange) => {
      arrange();

      const error = await rejection(confirmAttachment(USER, ACT, ATT, NOW));

      expect(error.code).toBe('validation_failed');
      expect(markPendingConfirming).not.toHaveBeenCalled();
      expect(copyObject).not.toHaveBeenCalled();
      expect(linkAttachment).not.toHaveBeenCalled();
    });

    /**
     * The temporary object survives a refused confirm on purpose. The drain is the single
     * place that removes one, and two removers is how one of them eventually deletes
     * something the other was still using.
     */
    it('deletes no object when it refuses', async () => {
      headObject.mockResolvedValue(undefined);

      await expect(confirmAttachment(USER, ACT, ATT, NOW)).rejects.toThrow();

      expect(deleteObject).not.toHaveBeenCalled();
    });

    it('refuses the 21st and writes nothing', async () => {
      listAttachments.mockResolvedValue(
        Array.from({ length: MAX_ATTACHMENTS_PER_ACTIVITY }, () => ({})),
      );

      const error = await rejection(confirmAttachment(USER, ACT, ATT, NOW));

      expect(error.code).toBe('validation_failed');
      expect(error.message).toContain(String(MAX_ATTACHMENTS_PER_ACTIVITY));
      expect(copyObject).not.toHaveBeenCalled();
    });

    /** Re-confirming the twentieth answers with it, rather than refusing it as a 21st. */
    it('lets an already-linked id through at the cap', async () => {
      listAttachments.mockResolvedValue(
        Array.from({ length: MAX_ATTACHMENTS_PER_ACTIVITY }, () => ({})),
      );
      const already = { attachmentId: ATT, activityId: ACT };
      getAttachment.mockResolvedValue(already);

      await expect(confirmAttachment(USER, ACT, ATT, NOW)).resolves.toBe(already);
    });

    /**
     * A copy that reported success and left nothing is a `500`, not a rejected request — and
     * the record is already `confirming`, so the drain owns the outcome either way.
     */
    it('fails loudly when the copy verifies as absent, leaving the record confirming', async () => {
      headObject
        .mockResolvedValueOnce({ contentType: 'image/jpeg', byteSize: 2048 })
        .mockResolvedValueOnce(undefined);

      const error = await rejection(confirmAttachment(USER, ACT, ATT, NOW));

      expect(error.code).toBe('internal');
      expect(markPendingConfirming).toHaveBeenCalled();
      expect(linkAttachment).not.toHaveBeenCalled();
    });

    /**
     * The temporary delete is the last step and its failure is not the caller's problem: the
     * attachment exists and is linked. The lifecycle rule collects what is left.
     */
    it('still succeeds when the temporary object cannot be removed', async () => {
      deleteObject.mockRejectedValue(new Error('store unreachable'));
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      await expect(
        confirmAttachment(USER, ACT, ATT, NOW, { log: log as never }),
      ).resolves.toMatchObject({ attachmentId: ATT });

      expect(log.warn).toHaveBeenCalledTimes(1);
    });
  });
});

describe('deleteAttachment', () => {
  beforeEach(() => {
    getAttachment.mockResolvedValue({
      attachmentId: ATT,
      activityId: ACT,
      key: `u/${USER}/01.jpg`,
    });
  });

  it('removes the row before the object', async () => {
    const order: string[] = [];
    unlinkAttachment.mockImplementation(async () => {
      order.push('row');
    });
    deleteObject.mockImplementation(async () => {
      order.push('object');
    });

    await expect(deleteAttachment(USER, ACT, ATT, NOW)).resolves.toEqual({
      attachmentId: ATT,
      coverCleared: false,
    });

    expect(order).toEqual(['row', 'object']);
    expect(deleteObject).toHaveBeenCalledWith(`u/${USER}/01.jpg`);
  });

  /** Rule 4: the hero can never point at nothing, so the clear is in the same write. */
  it('clears the cover in the same write when this attachment is it', async () => {
    assertActivityAccess.mockResolvedValue({
      activity: { activityId: ACT, ownerId: USER, primaryAttachmentId: ATT },
    });

    await expect(deleteAttachment(USER, ACT, ATT, NOW)).resolves.toEqual({
      attachmentId: ATT,
      coverCleared: true,
    });

    expect(unlinkAttachment).toHaveBeenCalledWith(ACT, ATT, { now: NOW });
  });

  it('leaves the cover alone when a different attachment is it', async () => {
    assertActivityAccess.mockResolvedValue({
      activity: { activityId: ACT, ownerId: USER, primaryAttachmentId: 'att_other' },
    });

    await deleteAttachment(USER, ACT, ATT, NOW);

    expect(unlinkAttachment).toHaveBeenCalledWith(ACT, ATT, undefined);
  });

  it('is owner-only', async () => {
    assertActivityAccess.mockRejectedValueOnce(new AppError('not_found', 'nope'));

    await expect(deleteAttachment(USER, ACT, ATT, NOW)).rejects.toThrow('nope');

    expect(assertActivityAccess).toHaveBeenCalledWith(USER, ACT, 'owner');
    expect(unlinkAttachment).not.toHaveBeenCalled();
  });

  /** A repeat is `404`, which for the caller means "already gone" — the outcome it wanted. */
  it('404s an id that names no attachment on this activity, and deletes nothing', async () => {
    getAttachment.mockResolvedValue(undefined);

    const error = await rejection(deleteAttachment(USER, ACT, ATT, NOW));

    expect(error.code).toBe('not_found');
    expect(unlinkAttachment).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });
});

describe('assertCoverIsLinked', () => {
  it('accepts an id linked to this activity', async () => {
    getAttachment.mockResolvedValue({ attachmentId: ATT, activityId: ACT });
    await expect(assertCoverIsLinked(ACT, ATT)).resolves.toBeUndefined();
  });

  it.each([undefined, null])('accepts %s without a read', async (value) => {
    await expect(assertCoverIsLinked(ACT, value)).resolves.toBeUndefined();
    expect(getAttachment).not.toHaveBeenCalled();
  });

  /**
   * The check the schema cannot make. Without it a client could point the hero at a real
   * attachment on somebody else's plan, and the hero renders as a request for exactly that
   * key — which is the whole of the access control on media (ADR-023).
   */
  it('refuses an id that is not on this activity', async () => {
    getAttachment.mockResolvedValue(undefined);

    const error = await rejection(assertCoverIsLinked(ACT, ATT));

    expect(error.code).toBe('validation_failed');
    expect(error.details?.[0]?.path).toBe('primaryAttachmentId');
  });
});

describe('assertAttachmentsConfirmable', () => {
  it('accepts an empty list without reading anything', async () => {
    await expect(assertAttachmentsConfirmable(USER, [])).resolves.toBeUndefined();
    expect(getPendingUpload).not.toHaveBeenCalled();
  });

  it('accepts ids whose objects are uploaded and match their declaration', async () => {
    await expect(assertAttachmentsConfirmable(USER, [ATT])).resolves.toBeUndefined();
  });

  it.each([
    ['no pending record', () => getPendingUpload.mockResolvedValue(undefined)],
    ['nothing uploaded', () => headObject.mockResolvedValue(undefined)],
    [
      'a mismatched declaration',
      () => headObject.mockResolvedValue({ contentType: 'image/png', byteSize: 1 }),
    ],
  ])('refuses %s, naming the array', async (_name, arrange) => {
    arrange();

    const error = await rejection(assertAttachmentsConfirmable(USER, [ATT]));

    expect(error.code).toBe('validation_failed');
    expect(error.details?.[0]?.path).toBe('attachmentIds');
  });

  /** One id twice would confirm once and silently drop the duplicate. */
  it('refuses a repeated id', async () => {
    await expect(assertAttachmentsConfirmable(USER, [ATT, ATT])).rejects.toThrow();
    expect(getPendingUpload).not.toHaveBeenCalled();
  });
});
