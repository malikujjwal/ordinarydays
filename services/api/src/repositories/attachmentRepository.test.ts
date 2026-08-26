import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { MAX_ATTACHMENTS_PER_ACTIVITY } from '@od/shared/constants';
import type { Attachment } from '@od/shared/types';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getAttachment,
  linkAttachment,
  listAttachments,
  unlinkAttachment,
} from './attachmentRepository.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

const USER = 'usr_local_dev';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ATT = 'att_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const NOW = '2026-08-26T12:00:00.000Z';

const items = () =>
  ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];

const record = (overrides: Partial<Attachment> = {}): Attachment => ({
  attachmentId: ATT,
  activityId: ACT,
  key: `u/${USER}/01J8XKQ2M4N5P6R7S8T9V0W1X3.jpg`,
  contentType: 'image/jpeg',
  byteSize: 2048,
  createdAt: NOW,
  schemaVersion: 1,
  ...overrides,
});

/** A stored row, with the storage attributes a real one carries. */
const row = (overrides: Record<string, unknown> = {}) => ({
  pk: `ACT#${ACT}`,
  sk: `ATT#${ATT}`,
  entity: 'Attachment',
  ...record(),
  ...overrides,
});

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(TransactWriteCommand).resolves({});
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(GetCommand).resolves({});
});

describe('listAttachments', () => {
  it('queries the activity partition under the attachment prefix, capped and strongly consistent', async () => {
    await listAttachments(ACT);

    const input = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input?.ExpressionAttributeValues?.[':pk']).toBe(`ACT#${ACT}`);
    expect(input?.ExpressionAttributeValues?.[':skPrefix']).toBe('ATT#');
    expect(input?.Limit).toBe(MAX_ATTACHMENTS_PER_ACTIVITY);
    expect(input?.ConsistentRead).toBe(true);
  });

  /** Storage attributes stay in this layer (`agent-playbook.md` §6.11). */
  it('returns the domain shape with no pk, sk or entity', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [row()] });

    const [parsed] = await listAttachments(ACT);

    expect(parsed).toEqual(record());
    expect(parsed).not.toHaveProperty('pk');
    expect(parsed).not.toHaveProperty('entity');
  });

  /** ADR-023: the stored value is a key. A row holding a URL is not one this code wrote. */
  it('throws rather than returning a row it cannot read', async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [row({ contentType: 'application/pdf' })] });
    await expect(listAttachments(ACT)).rejects.toThrow();

    ddbMock.on(QueryCommand).resolves({ Items: [row({ key: '' })] });
    await expect(listAttachments(ACT)).rejects.toThrow();
  });

  it('answers with an empty list when the activity has none', async () => {
    expect(await listAttachments(ACT)).toEqual([]);
  });
});

describe('getAttachment', () => {
  it('reads the exact key, strongly consistent', async () => {
    ddbMock.on(GetCommand).resolves({ Item: row() });

    expect(await getAttachment(ACT, ATT)).toEqual(record());

    const input = ddbMock.commandCalls(GetCommand)[0]?.args[0].input;
    expect(input?.Key).toEqual({ pk: `ACT#${ACT}`, sk: `ATT#${ATT}` });
    expect(input?.ConsistentRead).toBe(true);
  });

  it('is undefined when there is no such row', async () => {
    expect(await getAttachment(ACT, ATT)).toBeUndefined();
  });
});

describe('linkAttachment', () => {
  /**
   * The two halves of one guarantee. The row without the consumed record leaves a
   * `confirming` row whose drain would re-do finished work; the consumed record without the
   * row strands the permanent object with nothing pointing at it.
   */
  it('writes the row and consumes the pending record in one transaction', async () => {
    await linkAttachment(USER, record());

    expect(items()).toHaveLength(2);
    expect(items()[0]?.Put?.Item).toEqual({
      pk: `ACT#${ACT}`,
      sk: `ATT#${ATT}`,
      entity: 'Attachment',
      attachmentId: ATT,
      activityId: ACT,
      key: `u/${USER}/01J8XKQ2M4N5P6R7S8T9V0W1X3.jpg`,
      contentType: 'image/jpeg',
      byteSize: 2048,
      createdAt: NOW,
      schemaVersion: 1,
    });
    expect(items()[1]?.Delete?.Key).toEqual({
      pk: `USER#${USER}`,
      sk: `UPLOAD#${ATT}`,
    });
  });

  /** A retry racing itself cannot write a second row for one id. */
  it('refuses to overwrite an existing row', async () => {
    await linkAttachment(USER, record());
    expect(items()[0]?.Put?.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  it('adds the receipt to the same transaction when there is one', async () => {
    await linkAttachment(USER, record(), {
      userId: USER,
      key: 'idem-key',
      route: 'POST /v1/activities/:id/attachments',
      status: 201,
      body: '{}',
      ttl: 1,
      createdAt: NOW,
    });

    expect(items()).toHaveLength(3);
    expect(String(items()[2]?.Put?.Item?.pk)).toBe(`IDEM#${USER}#idem-key`);
  });
});

describe('unlinkAttachment', () => {
  it('deletes only the row when this attachment is not the cover', async () => {
    await unlinkAttachment(ACT, ATT);

    expect(items()).toHaveLength(1);
    expect(items()[0]?.Delete?.Key).toEqual({ pk: `ACT#${ACT}`, sk: `ATT#${ATT}` });
    expect(items()[0]?.Delete?.ConditionExpression).toBe('attribute_exists(pk)');
  });

  /**
   * Rule 4, and the reason it is one transaction: there must be no instant at which the hero
   * points at an attachment that is gone.
   */
  it('clears the cover in the same transaction, conditioned on it still being this one', async () => {
    await unlinkAttachment(ACT, ATT, { now: NOW });

    expect(items()).toHaveLength(2);
    const update = items()[1]?.Update;
    expect(update?.Key).toEqual({ pk: `ACT#${ACT}`, sk: 'META' });
    expect(update?.UpdateExpression).toBe(
      'REMOVE #primaryAttachmentId SET #updatedAt = :now',
    );
    expect(update?.ConditionExpression).toBe('#primaryAttachmentId = :attachmentId');
    expect(update?.ExpressionAttributeValues).toEqual({
      ':attachmentId': ATT,
      ':now': NOW,
    });
  });

  /**
   * `lastActivityAt` is bumped by "anything that means this plan is being **discussed**"
   * (`data-model.md` §3.5) — RSVPs, posted updates, added expenses. An owner attaching or
   * removing their own photo is none of those, and `icsSequence` never moves for an
   * attachment at all (P3-22 edge cases).
   */
  it('moves neither lastActivityAt nor icsSequence', async () => {
    await unlinkAttachment(ACT, ATT, { now: NOW });

    const serialised = JSON.stringify(items());
    expect(serialised).not.toContain('lastActivityAt');
    expect(serialised).not.toContain('icsSequence');
  });
});
