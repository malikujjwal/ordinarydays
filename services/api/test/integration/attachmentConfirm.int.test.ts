import { randomUUID } from 'node:crypto';
import { MAX_ATTACHMENTS_PER_ACTIVITY } from '@od/shared/constants';
import { beforeEach, describe, expect, it } from 'vitest';
import { authedHeaders, withUser } from '../helpers/auth.js';
import { documents, TEST_TABLE, useTestTable } from './harness.js';
import { headObject, listKeys, useTestBucket } from './s3Harness.js';

/**
 * Confirming, linking, deleting and the cover — against DynamoDB Local **and** MinIO
 * (P3-22, acceptance criteria 24 and 25).
 *
 * ## Why a real object store, again
 *
 * The whole of this task is a state machine spanning two stores that cannot commit together.
 * Every guarantee it makes is about what survives an interruption *between* them, and a mock
 * that answered `HeadObject` from a dictionary would let every one of those assertions pass
 * without proving anything. The crash case below is the reason the file exists: it stops the
 * process where a real one would stop, and then asks the next request to clean up.
 *
 * ## What it does not cover
 *
 * Block Public Access, CloudFront, OAC and the `tmp/` lifecycle rule. MinIO models none of
 * them; they are properties of the deployed bucket and stay the CDK tests' to assert.
 */

useTestTable();
useTestBucket();

const USER = 'usr_confirm_test';
const OTHER = 'usr_someone_else';
const BYTES = new Uint8Array([137, 80, 78, 71]);

interface Grant {
  attachmentId: string;
  uploadUrl: string;
  key: string;
}

interface Attachment {
  attachmentId: string;
  activityId: string;
  key: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
  schemaVersion: number;
}

const app = (user = USER) => withUser(user);

async function post(
  path: string,
  body: unknown,
  options: { user?: string; idempotencyKey?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app(options.user).fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: authedHeaders({ idempotencyKey: options.idempotencyKey ?? randomUUID() }),
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as never };
}

async function patch(
  path: string,
  body: unknown,
  ifMatch: string,
  user = USER,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app(user).fetch(
    new Request(`http://localhost${path}`, {
      method: 'PATCH',
      headers: { ...authedHeaders(), 'If-Match': ifMatch },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as never };
}

async function del(
  path: string,
  user = USER,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app(user).fetch(
    new Request(`http://localhost${path}`, {
      method: 'DELETE',
      headers: authedHeaders(),
    }),
  );
  return { status: response.status, body: (await response.json()) as never };
}

async function get(
  path: string,
  user = USER,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app(user).fetch(
    new Request(`http://localhost${path}`, { headers: authedHeaders() }),
  );
  return { status: response.status, body: (await response.json()) as never };
}

/** Issues a URL and uploads four bytes to it — the state a confirm expects to find. */
async function uploadedAttachment(user = USER): Promise<Grant> {
  const issued = await post(
    '/v1/attachments/upload-url',
    { contentType: 'image/png', byteSize: BYTES.length },
    { user },
  );
  expect(issued.status).toBe(201);
  const grant = issued.body.data as Grant;

  const put = await fetch(grant.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: BYTES,
  });
  expect(put.status).toBe(200);

  return grant;
}

/** A plan to hang attachments on. */
async function createPlan(
  user = USER,
  extra: Record<string, unknown> = {},
): Promise<{ activityId: string; updatedAt: string }> {
  const created = await post(
    '/v1/activities',
    {
      objectKind: 'plan',
      type: 'event',
      title: 'New York Trip',
      ...extra,
    },
    { user },
  );
  expect(created.status).toBe(201);
  // `POST /v1/activities` answers with the Activity itself, not a named collection.
  return created.body.data as { activityId: string; updatedAt: string };
}

/** The activity's attachment rows, read straight from the table. */
async function attachmentRows(activityId: string): Promise<Record<string, unknown>[]> {
  const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
  const result = await documents.send(
    new QueryCommand({
      TableName: TEST_TABLE,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :sk)',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': `ACT#${activityId}`, ':sk': 'ATT#' },
      ConsistentRead: true,
    }),
  );
  return (result.Items ?? []) as Record<string, unknown>[];
}

async function metaRow(activityId: string): Promise<Record<string, unknown>> {
  const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
  const result = await documents.send(
    new GetCommand({
      TableName: TEST_TABLE,
      Key: { pk: `ACT#${activityId}`, sk: 'META' },
      ConsistentRead: true,
    }),
  );
  return (result.Item ?? {}) as Record<string, unknown>;
}

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

describe('confirming an upload onto a plan', () => {
  let activityId: string;

  beforeEach(async () => {
    ({ activityId } = await createPlan());
  });

  /** **Acceptance criterion 24.** The key moves out of `tmp/` and one row appears. */
  it('moves the key out of tmp/ and writes exactly one attachment row', async () => {
    const grant = await uploadedAttachment();

    const confirmed = await post(`/v1/activities/${activityId}/attachments`, {
      attachmentId: grant.attachmentId,
    });

    expect(confirmed.status).toBe(201);
    const attachment = confirmed.body.data as Attachment;
    expect(attachment.key).toBe(grant.key.slice('tmp/'.length));
    expect(attachment.key.startsWith('tmp/')).toBe(false);

    // The permanent object is there with the declared type and length; the temporary one is
    // gone, and so is the pending record it was tracked by.
    expect(await headObject(attachment.key)).toEqual({
      contentType: 'image/png',
      byteSize: BYTES.length,
    });
    expect(await headObject(grant.key)).toBeUndefined();
    expect(await pendingRows()).toEqual([]);

    const rows = await attachmentRows(activityId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pk: `ACT#${activityId}`,
      sk: `ATT#${grant.attachmentId}`,
      entity: 'Attachment',
      key: attachment.key,
      contentType: 'image/png',
      byteSize: BYTES.length,
    });
  });

  /** ADR-023: the response names a key, never a host. */
  it('returns a key and never a URL', async () => {
    const grant = await uploadedAttachment();

    const confirmed = await post(`/v1/activities/${activityId}/attachments`, {
      attachmentId: grant.attachmentId,
    });

    expect(JSON.stringify(confirmed.body.data)).not.toContain('://');
  });

  it('is idempotent: re-confirming returns the row that is already there', async () => {
    const grant = await uploadedAttachment();
    const first = await post(`/v1/activities/${activityId}/attachments`, {
      attachmentId: grant.attachmentId,
    });

    const second = await post(`/v1/activities/${activityId}/attachments`, {
      attachmentId: grant.attachmentId,
    });

    expect(second.status).toBe(201);
    expect(second.body.data).toEqual(first.body.data);
    expect(await attachmentRows(activityId)).toHaveLength(1);
  });

  it('embeds the attachment in the plan detail read', async () => {
    const grant = await uploadedAttachment();
    await post(`/v1/activities/${activityId}/attachments`, {
      attachmentId: grant.attachmentId,
    });

    const detail = await get(`/v1/activities/${activityId}`);

    expect(detail.status).toBe(200);
    const attachments = (detail.body.data as { attachments: Attachment[] }).attachments;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.attachmentId).toBe(grant.attachmentId);
    expect(attachments[0]?.key.startsWith('tmp/')).toBe(false);
  });

  describe('what it refuses, writing nothing', () => {
    it('400s an id whose object was never uploaded', async () => {
      const issued = await post('/v1/attachments/upload-url', {
        contentType: 'image/png',
        byteSize: BYTES.length,
      });
      const grant = issued.body.data as Grant;

      const confirmed = await post(`/v1/activities/${activityId}/attachments`, {
        attachmentId: grant.attachmentId,
      });

      expect(confirmed.status).toBe(400);
      expect((confirmed.body.error as { code: string }).code).toBe('validation_failed');
      expect(await attachmentRows(activityId)).toEqual([]);
      // The record survives, still awaiting its upload: the drain is the only remover.
      expect(await pendingRows()).toHaveLength(1);
      expect((await pendingRows())[0]?.state).toBe('awaiting_upload');
    });

    /**
     * The object key is derived from the **caller's** id, so another user's `attachmentId`
     * resolves to a record in a partition this caller cannot read — and the activity is not
     * theirs either. Both facts point the same way.
     */
    it('does not let one user confirm another user’s upload', async () => {
      const grant = await uploadedAttachment(OTHER);

      const confirmed = await post(`/v1/activities/${activityId}/attachments`, {
        attachmentId: grant.attachmentId,
      });

      expect(confirmed.status).toBe(400);
      expect(await attachmentRows(activityId)).toEqual([]);
      // The other user's temporary object is untouched.
      expect(await headObject(grant.key)).toBeDefined();
    });

    /** A stranger's activity is `404`, never `403`. */
    it('404s an activity the caller does not own', async () => {
      const grant = await uploadedAttachment();

      const confirmed = await post(
        `/v1/activities/${activityId}/attachments`,
        { attachmentId: grant.attachmentId },
        { user: OTHER },
      );

      expect(confirmed.status).toBe(404);
      expect(await attachmentRows(activityId)).toEqual([]);
    });

    it('400s the 21st', async () => {
      // Seed the cap directly: twenty presign-upload-confirm cycles would be twenty round
      // trips to prove a number the service reads in one.
      const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
      for (let i = 0; i < MAX_ATTACHMENTS_PER_ACTIVITY; i += 1) {
        // A real prefixed ULID: the row is read back through the shared schema, which
        // rejects anything else — a seed the code could never have written proves nothing.
        const seeded = `att_01J8XKQ2M4N5P6R7S8T9V0${String(i).padStart(4, '0')}`;
        await documents.send(
          new PutCommand({
            TableName: TEST_TABLE,
            Item: {
              pk: `ACT#${activityId}`,
              sk: `ATT#${seeded}`,
              entity: 'Attachment',
              attachmentId: seeded,
              activityId,
              key: `u/${USER}/seed_${i}.jpg`,
              contentType: 'image/jpeg',
              byteSize: 4,
              createdAt: '2026-08-26T09:00:00.000Z',
              schemaVersion: 1,
            },
          }),
        );
      }
      const grant = await uploadedAttachment();

      const confirmed = await post(`/v1/activities/${activityId}/attachments`, {
        attachmentId: grant.attachmentId,
      });

      expect(confirmed.status).toBe(400);
      expect((confirmed.body.error as { message: string }).message).toContain(
        String(MAX_ATTACHMENTS_PER_ACTIVITY),
      );
      expect(await attachmentRows(activityId)).toHaveLength(MAX_ATTACHMENTS_PER_ACTIVITY);
      // The permanent copy never happened.
      expect(await headObject(grant.key.slice('tmp/'.length))).toBeUndefined();
    });
  });

  /**
   * **The crash the whole state machine exists for**, and the only way to produce it is to
   * stop between the two stores.
   *
   * The service is driven directly rather than through HTTP so the interruption lands exactly
   * where a real one would: after `markPendingConfirming` and after the permanent copy, before
   * the transaction. What is left behind is a `confirming` record naming both the object and
   * its intended Activity — and the next request is asked to make sense of it.
   */
  describe('a crash after the permanent copy and before the transaction', () => {
    async function crashAfterCopy(): Promise<Grant> {
      const grant = await uploadedAttachment();
      const { markPendingConfirming } = await import(
        '../../src/repositories/pendingUploadRepository.js'
      );
      const { copyObject } = await import('../../src/lib/s3.js');

      await markPendingConfirming(USER, grant.attachmentId, activityId);
      await copyObject(grant.key, grant.key.slice('tmp/'.length));

      return grant;
    }

    /** Both objects exist and nothing links them: exactly the state that must not persist. */
    it('leaves a confirming record naming both keys and the activity', async () => {
      const grant = await crashAfterCopy();

      const [pending] = await pendingRows();
      expect(pending).toMatchObject({
        state: 'confirming',
        activityId,
        tmpKey: grant.key,
        finalKey: grant.key.slice('tmp/'.length),
      });
      expect(await headObject(grant.key)).toBeDefined();
      expect(await headObject(grant.key.slice('tmp/'.length))).toBeDefined();
      expect(await attachmentRows(activityId)).toEqual([]);
    });

    /** **Retry completes it** into exactly one linked row. */
    it('retrying the confirm produces exactly one linked row and no orphan', async () => {
      const grant = await crashAfterCopy();

      const confirmed = await post(`/v1/activities/${activityId}/attachments`, {
        attachmentId: grant.attachmentId,
      });

      expect(confirmed.status).toBe(201);
      expect(await attachmentRows(activityId)).toHaveLength(1);
      expect(await pendingRows()).toEqual([]);
      expect(await headObject(grant.key)).toBeUndefined();
      expect(await headObject(grant.key.slice('tmp/'.length))).toBeDefined();
    });

    /**
     * **Repair completes it too**, without anybody retrying: the drain that runs before the
     * next upload URL finds the record, verifies the copy and finishes the link.
     */
    it('the drain completes a verified link once the record expires', async () => {
      const grant = await crashAfterCopy();
      await expirePendingRecord(grant.attachmentId);

      // Any later request that drains — here, asking for another upload URL.
      await post('/v1/attachments/upload-url', {
        contentType: 'image/png',
        byteSize: BYTES.length,
      });

      const rows = await attachmentRows(activityId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.attachmentId).toBe(grant.attachmentId);
      expect(await headObject(grant.key)).toBeUndefined();
      expect(await headObject(grant.key.slice('tmp/'.length))).toBeDefined();
    });

    /**
     * **Or deletes both keys** when there is nowhere for the object to belong. Never an
     * orphan: the record outlives every object it knows about.
     */
    it('the drain deletes both objects when the activity is gone', async () => {
      const grant = await crashAfterCopy();
      await del(`/v1/activities/${activityId}`);
      await expirePendingRecord(grant.attachmentId);

      await post('/v1/attachments/upload-url', {
        contentType: 'image/png',
        byteSize: BYTES.length,
      });

      expect(await headObject(grant.key)).toBeUndefined();
      expect(await headObject(grant.key.slice('tmp/'.length))).toBeUndefined();
      expect(
        (await pendingRows()).filter((row) => row.attachmentId === grant.attachmentId),
      ).toEqual([]);
      expect(await listKeys(grant.key.slice('tmp/'.length))).toEqual([]);
    });
  });
});

/** Ages a pending record past its cleanup instant, so the next drain owns it. */
async function expirePendingRecord(attachmentId: string, userId = USER): Promise<void> {
  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  await documents.send(
    new UpdateCommand({
      TableName: TEST_TABLE,
      Key: { pk: `USER#${userId}`, sk: `UPLOAD#${attachmentId}` },
      UpdateExpression: 'SET #cleanupAfter = :past',
      ExpressionAttributeNames: { '#cleanupAfter': 'cleanupAfter' },
      ExpressionAttributeValues: { ':past': '2020-01-01T00:00:00.000Z' },
    }),
  );
}

describe('deleting an attachment', () => {
  it('removes the row and the object', async () => {
    const { activityId } = await createPlan();
    const grant = await uploadedAttachment();
    const confirmed = await post(`/v1/activities/${activityId}/attachments`, {
      attachmentId: grant.attachmentId,
    });
    const { key } = confirmed.body.data as Attachment;

    const removed = await del(
      `/v1/activities/${activityId}/attachments/${grant.attachmentId}`,
    );

    expect(removed.status).toBe(200);
    expect(removed.body.data).toEqual({
      attachmentId: grant.attachmentId,
      coverCleared: false,
    });
    expect(await attachmentRows(activityId)).toEqual([]);
    expect(await headObject(key)).toBeUndefined();
  });

  /** **Acceptance criterion 25's other half**: the hero can never point at nothing. */
  it('clears the cover in the same write when the deleted attachment is it', async () => {
    const { activityId, updatedAt } = await createPlan();
    const grant = await uploadedAttachment();
    await post(`/v1/activities/${activityId}/attachments`, {
      attachmentId: grant.attachmentId,
    });

    const covered = await patch(
      `/v1/activities/${activityId}`,
      { primaryAttachmentId: grant.attachmentId },
      updatedAt,
    );
    expect(covered.status).toBe(200);
    expect(await metaRow(activityId)).toMatchObject({
      primaryAttachmentId: grant.attachmentId,
    });

    const removed = await del(
      `/v1/activities/${activityId}/attachments/${grant.attachmentId}`,
    );

    expect(removed.body.data).toEqual({
      attachmentId: grant.attachmentId,
      coverCleared: true,
    });
    const meta = await metaRow(activityId);
    expect(meta).not.toHaveProperty('primaryAttachmentId');
    expect(await attachmentRows(activityId)).toEqual([]);
  });

  it('404s a second delete of the same attachment', async () => {
    const { activityId } = await createPlan();
    const grant = await uploadedAttachment();
    await post(`/v1/activities/${activityId}/attachments`, {
      attachmentId: grant.attachmentId,
    });
    await del(`/v1/activities/${activityId}/attachments/${grant.attachmentId}`);

    const again = await del(
      `/v1/activities/${activityId}/attachments/${grant.attachmentId}`,
    );

    expect(again.status).toBe(404);
  });
});

describe('the cover', () => {
  it('accepts an attachment linked to this activity', async () => {
    const { activityId, updatedAt } = await createPlan();
    const grant = await uploadedAttachment();
    await post(`/v1/activities/${activityId}/attachments`, {
      attachmentId: grant.attachmentId,
    });

    const covered = await patch(
      `/v1/activities/${activityId}`,
      { primaryAttachmentId: grant.attachmentId },
      updatedAt,
    );

    expect(covered.status).toBe(200);
    expect(
      (covered.body.data as { primaryAttachmentId: string }).primaryAttachmentId,
    ).toBe(grant.attachmentId);
  });

  it('400s an id not linked to this activity', async () => {
    const { activityId, updatedAt } = await createPlan();
    const other = await createPlan();
    const grant = await uploadedAttachment();
    await post(`/v1/activities/${other.activityId}/attachments`, {
      attachmentId: grant.attachmentId,
    });

    const covered = await patch(
      `/v1/activities/${activityId}`,
      { primaryAttachmentId: grant.attachmentId },
      updatedAt,
    );

    expect(covered.status).toBe(400);
    expect((covered.body.error as { code: string }).code).toBe('validation_failed');
    expect(await metaRow(activityId)).not.toHaveProperty('primaryAttachmentId');
  });

  it('clears with null', async () => {
    const { activityId, updatedAt } = await createPlan();
    const grant = await uploadedAttachment();
    await post(`/v1/activities/${activityId}/attachments`, {
      attachmentId: grant.attachmentId,
    });
    const covered = await patch(
      `/v1/activities/${activityId}`,
      { primaryAttachmentId: grant.attachmentId },
      updatedAt,
    );

    const cleared = await patch(
      `/v1/activities/${activityId}`,
      { primaryAttachmentId: null },
      (covered.body.data as { updatedAt: string }).updatedAt,
    );

    expect(cleared.status).toBe(200);
    expect(await metaRow(activityId)).not.toHaveProperty('primaryAttachmentId');
  });
});

/**
 * `icsSequence` is the calendar-invite version. Attachments are not part of an invite, so
 * nothing in this task may move it (P3-22 edge cases, `data-model.md` §4.1) — a bump would
 * make every subscribed calendar re-notify because somebody added a photo.
 */
describe('icsSequence never moves', () => {
  it('survives confirm, cover, delete and cover-clear untouched', async () => {
    const { activityId, updatedAt } = await createPlan();
    const before = (await metaRow(activityId)).icsSequence;
    expect(before).toBe(0);

    const first = await uploadedAttachment();
    const second = await uploadedAttachment();

    await post(`/v1/activities/${activityId}/attachments`, {
      attachmentId: first.attachmentId,
    });
    expect((await metaRow(activityId)).icsSequence).toBe(before);

    await post(`/v1/activities/${activityId}/attachments`, {
      attachmentId: second.attachmentId,
    });
    expect((await metaRow(activityId)).icsSequence).toBe(before);

    const covered = await patch(
      `/v1/activities/${activityId}`,
      { primaryAttachmentId: first.attachmentId },
      updatedAt,
    );
    expect(covered.status).toBe(200);
    expect((await metaRow(activityId)).icsSequence).toBe(before);

    await del(`/v1/activities/${activityId}/attachments/${first.attachmentId}`);
    const meta = await metaRow(activityId);
    expect(meta.icsSequence).toBe(before);
    expect(meta).not.toHaveProperty('primaryAttachmentId');
  });

  /**
   * `lastActivityAt` sorts Needs a date and is bumped by "anything that means this plan is
   * being **discussed**" (`data-model.md` §3.5). An owner attaching their own photo is not
   * discussion, and floating their plan up that list would be a behaviour change no product
   * doc asks for.
   */
  it('leaves lastActivityAt alone too', async () => {
    const { activityId } = await createPlan();
    const before = (await metaRow(activityId)).lastActivityAt;
    const grant = await uploadedAttachment();

    await post(`/v1/activities/${activityId}/attachments`, {
      attachmentId: grant.attachmentId,
    });
    expect((await metaRow(activityId)).lastActivityAt).toBe(before);

    await del(`/v1/activities/${activityId}/attachments/${grant.attachmentId}`);
    expect((await metaRow(activityId)).lastActivityAt).toBe(before);
  });
});

/** Rule 5: the same confirm-and-link path, run from a create and from the schedule bridge. */
describe('attachmentIds on a create', () => {
  it('links a confirmed id onto the activity it created', async () => {
    const grant = await uploadedAttachment();

    const created = await post('/v1/activities', {
      objectKind: 'plan',
      type: 'event',
      title: 'New York Trip',
      attachmentIds: [grant.attachmentId],
    });

    expect(created.status).toBe(201);
    const { activityId } = created.body.data as { activityId: string };
    const rows = await attachmentRows(activityId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attachmentId).toBe(grant.attachmentId);
    expect(String(rows[0]?.key).startsWith('tmp/')).toBe(false);
  });

  it('400s an unconfirmable id and writes no activity at all', async () => {
    // Issued but never uploaded.
    const issued = await post('/v1/attachments/upload-url', {
      contentType: 'image/png',
      byteSize: BYTES.length,
    });
    const grant = issued.body.data as Grant;

    const created = await post('/v1/activities', {
      objectKind: 'plan',
      type: 'event',
      title: 'New York Trip',
      attachmentIds: [grant.attachmentId],
    });

    expect(created.status).toBe(400);
    expect((created.body.error as { code: string }).code).toBe('validation_failed');

    // Nothing was created. Asserted against the caller's index partition rather than a list
    // response, because "no Activity exists" is a fact about storage.
    const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
    const index = await documents.send(
      new QueryCommand({
        TableName: TEST_TABLE,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :sk)',
        ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: { ':pk': `USER#${USER}`, ':sk': 'IDX#' },
        ConsistentRead: true,
      }),
    );
    expect(index.Items ?? []).toEqual([]);
  });
});
