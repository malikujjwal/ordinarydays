import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { listForUser } from './reminderRepository.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ACTIVITY_ID = 'act_01J8XKQ2M4N5P6R7S8T9V0W1AA';

beforeEach(() => ddbMock.reset());

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
