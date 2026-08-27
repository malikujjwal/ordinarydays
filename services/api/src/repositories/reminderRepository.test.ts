import {
  DeleteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IdempotencyReceipt } from '../lib/idempotency.js';
import { createForUser, deleteForUser, listForUser } from './reminderRepository.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ACTIVITY_ID = 'act_01J8XKQ2M4N5P6R7S8T9V0W1AA';

const REMINDER_ID = 'rem_01J8XKQ2M4N5P6R7S8T9V0W1AA';
const NOW = '2026-08-11T12:00:00.000Z';
const receipt: IdempotencyReceipt = {
  userId: 'usr_alice',
  key: '11111111-1111-4111-8111-111111111111',
  route: 'POST /v1/activities/:id/reminders',
  status: 201,
  body: '{}',
  ttl: 1,
  createdAt: NOW,
};

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(TransactWriteCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
});

describe('listForUser', () => {
  it('queries only the caller prefix and projects validated reminders', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          pk: `ACT#${ACTIVITY_ID}`,
          sk: 'REM#usr_alice#rem_1',
          entity: 'Reminder',
          reminderId: 'rem_01J8XKQ2M4N5P6R7S8T9V0W1AA',
          activityId: ACTIVITY_ID,
          userId: 'usr_alice',
          offsetMinutes: -15,
          channel: 'push',
          schemaVersion: 1,
        },
      ],
    });

    const rows = await listForUser(ACTIVITY_ID, 'usr_alice');

    expect(rows).toEqual([
      {
        reminderId: 'rem_01J8XKQ2M4N5P6R7S8T9V0W1AA',
        activityId: ACTIVITY_ID,
        userId: 'usr_alice',
        offsetMinutes: -15,
        channel: 'push',
      },
    ]);
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0]?.input).toMatchObject({
      ExpressionAttributeValues: {
        ':pk': `ACT#${ACTIVITY_ID}`,
        ':skPrefix': 'REM#usr_alice#',
      },
    });
  });

  it('returns an empty list without inventing a reminder', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await expect(listForUser(ACTIVITY_ID, 'usr_alice')).resolves.toEqual([]);
  });
});

describe('createForUser', () => {
  it('writes the row under exactly the supplied user prefix with its receipt', async () => {
    await createForUser(
      ACTIVITY_ID,
      'usr_alice',
      { reminderId: REMINDER_ID, offsetMinutes: -15, channel: 'push' },
      NOW,
      receipt,
    );

    const items =
      ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems;
    expect(items?.[0]?.Put?.Item).toMatchObject({
      pk: `ACT#${ACTIVITY_ID}`,
      sk: `REM#usr_alice#${REMINDER_ID}`,
      entity: 'Reminder',
      userId: 'usr_alice',
      offsetMinutes: -15,
      createdAt: NOW,
      updatedAt: NOW,
      schemaVersion: 1,
    });
    expect(items?.[0]?.Put?.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(items?.[1]?.ConditionCheck).toMatchObject({
      Key: { pk: `ACT#${ACTIVITY_ID}`, sk: 'META' },
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#deletingAt)',
      ExpressionAttributeNames: { '#deletingAt': 'deletingAt' },
    });
    expect(items?.[2]?.Put?.Item?.entity).toBe('Idempotency');
  });
});

describe('deleteForUser', () => {
  it('can address only the supplied user prefix and requires the row to exist', async () => {
    await deleteForUser(ACTIVITY_ID, 'usr_bob', REMINDER_ID);

    expect(ddbMock.commandCalls(DeleteCommand)[0]?.args[0].input).toMatchObject({
      Key: {
        pk: `ACT#${ACTIVITY_ID}`,
        sk: `REM#usr_bob#${REMINDER_ID}`,
      },
      ConditionExpression: 'attribute_exists(pk)',
    });
  });
});
