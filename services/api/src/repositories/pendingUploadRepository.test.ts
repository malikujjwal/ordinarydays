import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { MAX_UNRESOLVED_UPLOADS } from '@od/shared/constants';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { IdempotencyRaceError } from '../lib/idempotency.js';
import {
  attachmentUlid,
  deletePendingUpload,
  listPendingUploads,
  newAttachmentId,
  type PendingUpload,
  PendingUploadSlotUnavailableError,
  putPendingUpload,
} from './pendingUploadRepository.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

const USER = 'usr_local_dev';
const ID = 'att_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const NOW = '2026-08-26T12:00:00.000Z';

const sentPut = () =>
  ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems?.[0]?.Put;
const sentQuery = () => ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
const sentDelete = () => ddbMock.commandCalls(DeleteCommand)[0]?.args[0].input;

const record = (overrides: Partial<PendingUpload> = {}): PendingUpload => ({
  attachmentId: ID,
  userId: USER,
  tmpKey: `tmp/u/${USER}/01J8XKQ2M4N5P6R7S8T9V0W1X2.jpg`,
  finalKey: `u/${USER}/01J8XKQ2M4N5P6R7S8T9V0W1X2.jpg`,
  contentType: 'image/jpeg',
  byteSize: 2048,
  state: 'awaiting_upload',
  createdAt: '2026-08-26T12:00:00.000Z',
  cleanupAfter: '2026-08-27T12:00:00.000Z',
  ...overrides,
});

/** A stored row, with the storage attributes a real one carries. */
const row = (overrides: Record<string, unknown> = {}) => ({
  pk: `USER#${USER}`,
  sk: `UPLOAD#${ID}`,
  entity: 'PendingUpload',
  schemaVersion: 1,
  ...record(),
  ...overrides,
});

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(TransactWriteCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
  ddbMock.on(QueryCommand).resolves({ Items: [] });
});

describe('newAttachmentId', () => {
  it('is att_ plus a 26-character ULID', () => {
    expect(newAttachmentId()).toMatch(/^att_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('passes the shared attachmentId schema', async () => {
    const { attachmentId } = await import('@od/shared/schemas');
    expect(attachmentId.safeParse(newAttachmentId()).success).toBe(true);
  });

  /**
   * The ULID is also the object key's filename, so a collision would not merely reorder two
   * rows — it would put two people's uploads on one key. `monotonicFactory` is what keeps ids
   * minted in the same millisecond distinct and ordered.
   */
  it('is unique and ordered even within one millisecond', () => {
    const ids = Array.from({ length: 50 }, newAttachmentId);
    expect(new Set(ids).size).toBe(50);
    expect([...ids].sort()).toEqual(ids);
  });

  it('round-trips through attachmentUlid', () => {
    const id = newAttachmentId();
    expect(attachmentUlid(id)).toBe(id.slice('att_'.length));
    expect(attachmentUlid(id)).toHaveLength(26);
  });
});

describe('putPendingUpload', () => {
  it('writes the row under the caller’s partition, field by field', async () => {
    await putPendingUpload(record());

    expect(sentPut()?.Item).toEqual({
      pk: `USER#${USER}`,
      sk: `UPLOAD#${ID}`,
      entity: 'PendingUpload',
      attachmentId: ID,
      userId: USER,
      tmpKey: `tmp/u/${USER}/01J8XKQ2M4N5P6R7S8T9V0W1X2.jpg`,
      finalKey: `u/${USER}/01J8XKQ2M4N5P6R7S8T9V0W1X2.jpg`,
      contentType: 'image/jpeg',
      byteSize: 2048,
      state: 'awaiting_upload',
      createdAt: '2026-08-26T12:00:00.000Z',
      cleanupAfter: '2026-08-27T12:00:00.000Z',
      schemaVersion: 1,
    });
  });

  /** A fresh ULID cannot collide, so the condition asserts that rather than trusting it. */
  it('refuses to overwrite an existing row', async () => {
    await putPendingUpload(record());
    expect(sentPut()?.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  /** Absent until confirmation names a target — never written as `undefined`. */
  it('omits activityId entirely when there is none, and writes it when there is', async () => {
    await putPendingUpload(record());
    expect(sentPut()?.Item).not.toHaveProperty('activityId');

    ddbMock.reset();
    ddbMock.on(TransactWriteCommand).resolves({});
    await putPendingUpload(record({ activityId: 'act_1' }));
    expect(sentPut()?.Item?.activityId).toBe('act_1');
  });

  it('writes one item when there is no receipt', async () => {
    await putPendingUpload(record());
    expect(
      ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems,
    ).toHaveLength(1);
  });

  it('claims a fixed quota slot atomically with a new pending row', async () => {
    await putPendingUpload(record({ quotaSlot: 3 }));
    const writes =
      ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
    expect(writes).toHaveLength(2);
    expect(writes[1]?.Put?.Item).toMatchObject({
      pk: `USER#${USER}`,
      sk: 'UPLOAD_SLOT#03',
      attachmentId: ID,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(writes[1]?.Put?.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  it('maps a lost quota-slot race so the service can select another slot', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        $metadata: {},
        message: 'cancelled',
        CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
      }),
    );
    await expect(putPendingUpload(record({ quotaSlot: 3 }))).rejects.toBeInstanceOf(
      PendingUploadSlotUnavailableError,
    );
  });

  /**
   * The record and its replay receipt commit together or not at all: a receipt stored without
   * the record would answer a retry with a URL for something that was never written.
   */
  it('puts the receipt in the same transaction as the record', async () => {
    await putPendingUpload(record(), {
      userId: USER,
      key: 'idem-key',
      route: 'POST /v1/attachments/upload-url',
      status: 201,
      body: '{}',
      ttl: 1,
      createdAt: '2026-08-26T12:00:00.000Z',
    });

    const items =
      ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(2);
    expect(String(items[1]?.Put?.Item?.pk)).toBe(`IDEM#${USER}#idem-key`);
  });

  /**
   * A condition failure on the **receipt** slot is a concurrent replay, not a bad request, so
   * it is mapped rather than surfacing as the raw DynamoDB fault the error handler would
   * classify as a conflict on the domain write.
   */
  it('maps a receipt-slot condition failure to an idempotency race', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        $metadata: {},
        message: 'cancelled',
        CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
      }),
    );

    await expect(
      putPendingUpload(record(), {
        userId: USER,
        key: 'idem-key',
        route: 'POST /v1/attachments/upload-url',
        status: 201,
        body: '{}',
        ttl: 1,
        createdAt: '2026-08-26T12:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(IdempotencyRaceError);
  });
});

describe('listPendingUploads', () => {
  it('queries the caller’s partition under the upload prefix, capped and strongly consistent', async () => {
    await listPendingUploads(USER);

    const input = sentQuery();
    expect(input?.ExpressionAttributeValues?.[':pk']).toBe(`USER#${USER}`);
    expect(input?.ExpressionAttributeValues?.[':skPrefix']).toBe('UPLOAD#');
    expect(input?.Limit).toBe(MAX_UNRESOLVED_UPLOADS);
    expect(input?.ConsistentRead).toBe(true);
  });

  /** Storage attributes stay in this layer (`agent-playbook.md` §6.11). */
  it('returns the domain shape with no pk, sk, entity or schemaVersion', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [row()] });

    const [parsed] = await listPendingUploads(USER);

    expect(parsed).toEqual(record());
    expect(parsed).not.toHaveProperty('pk');
    expect(parsed).not.toHaveProperty('entity');
    expect(parsed).not.toHaveProperty('schemaVersion');
  });

  it('keeps activityId absent rather than present-and-undefined', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [row()] });
    expect(await listPendingUploads(USER)).toEqual([
      expect.not.objectContaining({ activityId: undefined }),
    ]);

    ddbMock.on(QueryCommand).resolves({ Items: [row({ activityId: 'act_1' })] });
    expect((await listPendingUploads(USER))[0]?.activityId).toBe('act_1');
  });

  it('reads a confirming row', async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [row({ state: 'confirming', activityId: 'act_1' })] });
    expect((await listPendingUploads(USER))[0]?.state).toBe('confirming');
  });

  /**
   * A stored row is `unknown` at this boundary. `state` in particular drives what the drain
   * does to an **object**, so an unreadable row must fail loudly rather than be cast into
   * `awaiting_upload` and have its temporary object deleted underneath a live confirmation.
   */
  it('throws rather than guessing at a row it cannot read', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [row({ state: 'something_else' })] });
    await expect(listPendingUploads(USER)).rejects.toThrow();

    ddbMock.on(QueryCommand).resolves({ Items: [row({ tmpKey: '' })] });
    await expect(listPendingUploads(USER)).rejects.toThrow();
  });

  it('answers with an empty list when the caller has none', async () => {
    expect(await listPendingUploads(USER)).toEqual([]);
  });
});

describe('deletePendingUpload', () => {
  it('deletes exactly the caller’s row', async () => {
    await deletePendingUpload(USER, ID);
    expect(sentDelete()?.Key).toEqual({ pk: `USER#${USER}`, sk: `UPLOAD#${ID}` });
  });

  /**
   * Unconditional, deliberately. The drain removes the object first and then the row; two
   * requests draining concurrently both wanted the same outcome, and a conditional delete
   * would turn that race into an error on a request that had nothing to do with it.
   */
  it('does not fail when the row is already gone', async () => {
    await deletePendingUpload(USER, ID);
    expect(sentDelete()?.ConditionExpression).toBeUndefined();
  });

  it('releases a fixed quota slot in the same transaction', async () => {
    await deletePendingUpload(USER, ID, 3);
    const writes =
      ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
    expect(writes.map((item) => item.Delete?.Key)).toEqual([
      { pk: `USER#${USER}`, sk: `UPLOAD#${ID}` },
      { pk: `USER#${USER}`, sk: 'UPLOAD_SLOT#03' },
    ]);
  });
});
