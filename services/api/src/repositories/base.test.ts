import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../lib/errors.js';
import {
  deleteAll,
  deleteItem,
  getItem,
  putItem,
  query,
  queryAll,
  updateItem,
} from './base.js';
import { activityIndex, userProfile } from './keys.js';

/**
 * **Did we build the right command?**
 *
 * That is the question a mock answers and a database cannot: `test/integration/` proves the
 * commands come back with the right rows, but a `KeyConditionExpression` that quietly
 * dropped its `begins_with`, or a query that forgot `ScanIndexForward`, still returns *rows*
 * — just the wrong ones, in a way that reads as a bug in the caller. The two suites answer
 * different questions and neither substitutes for the other (`testing.md` §4.2).
 */
const ddbMock = mockClient(DynamoDBDocumentClient);

const ALICE = 'usr_a';

beforeEach(() => {
  ddbMock.reset();
});

const lastQuery = () =>
  ddbMock.commandCalls(QueryCommand)[0]?.args[0]?.input as Record<string, unknown>;

describe('query builds the right command', () => {
  beforeEach(() => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
  });

  it('scopes to the partition and names the table once', async () => {
    await query({ pk: userProfile(ALICE).pk });

    expect(lastQuery()).toMatchObject({
      TableName: 'od-main-local',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': `USER#${ALICE}` },
    });
  });

  it('adds begins_with for a sort-key prefix', async () => {
    await query({ pk: userProfile(ALICE).pk }, { skPrefix: 'IDX#' });

    expect(lastQuery().KeyConditionExpression).toBe(
      '#pk = :pk AND begins_with(#sk, :skPrefix)',
    );
    expect(lastQuery().ExpressionAttributeValues).toMatchObject({ ':skPrefix': 'IDX#' });
  });

  it('adds BETWEEN for a sort-key range', async () => {
    await query({ pk: 'ACT#act_1' }, { skBetween: ['OCC#2026-08-01', 'OCC#2026-08-31'] });

    expect(lastQuery().KeyConditionExpression).toBe(
      '#pk = :pk AND #sk BETWEEN :from AND :to',
    );
  });

  /**
   * A GSI1 query keys on `gsi1pk`/`gsi1sk`, not `pk`/`sk`. Getting this wrong would query
   * the table by an attribute that is not its key and fail — or, worse, match nothing and
   * look like an empty agenda.
   */
  it('keys an index query on the index attributes and names the index', async () => {
    await query({ gsi1pk: `U#${ALICE}#S` }, { indexName: 'GSI1', skPrefix: '2026-08' });

    expect(lastQuery()).toMatchObject({
      IndexName: 'GSI1',
      ExpressionAttributeNames: { '#pk': 'gsi1pk', '#sk': 'gsi1sk' },
      ExpressionAttributeValues: { ':pk': `U#${ALICE}#S` },
    });
  });

  it('omits ScanIndexForward unless newest-first was asked for', async () => {
    await query({ pk: userProfile(ALICE).pk });
    expect(lastQuery()).not.toHaveProperty('ScanIndexForward');

    ddbMock.reset();
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await query({ pk: userProfile(ALICE).pk }, { ascending: false });
    expect(lastQuery().ScanIndexForward).toBe(false);
  });

  it('passes a decoded cursor as ExclusiveStartKey', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ pk: `USER#${ALICE}`, sk: 'IDX#act_1' }),
    ).toString('base64url');

    await query({ pk: userProfile(ALICE).pk }, { cursor });

    expect(lastQuery().ExclusiveStartKey).toEqual({
      pk: `USER#${ALICE}`,
      sk: 'IDX#act_1',
    });
  });

  /**
   * The check that matters most on this path: a bad cursor must never reach DynamoDB. If it
   * did, an `ExclusiveStartKey` naming attributes the query does not key on is at best an
   * SDK error and at worst a read from somewhere the caller did not ask for.
   */
  it('rejects a malformed cursor without sending anything', async () => {
    await expect(
      query({ pk: userProfile(ALICE).pk }, { cursor: '!!!not-a-cursor' }),
    ).rejects.toThrow(AppError);

    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('returns a next cursor only when there is another page', async () => {
    ddbMock.reset();
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [],
        LastEvaluatedKey: { pk: `USER#${ALICE}`, sk: 'IDX#act_1' },
      })
      .resolves({ Items: [] });

    expect((await query({ pk: userProfile(ALICE).pk })).nextCursor).toBeDefined();
    expect((await query({ pk: userProfile(ALICE).pk })).nextCursor).toBeUndefined();
  });

  it('upgrades every returned row on read', async () => {
    ddbMock.reset();
    ddbMock.on(QueryCommand).resolves({ Items: [{ pk: 'x', sk: 'y' }] });

    const page = await query({ pk: userProfile(ALICE).pk });
    expect(page.items).toHaveLength(1);
  });
});

describe('queryAll follows pagination itself', () => {
  it('keeps going until there is no cursor, and returns every item', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [{ pk: 'a', sk: '1' }],
        LastEvaluatedKey: { pk: 'a', sk: '1' },
      })
      .resolvesOnce({
        Items: [{ pk: 'a', sk: '2' }],
        LastEvaluatedKey: { pk: 'a', sk: '2' },
      })
      .resolves({ Items: [{ pk: 'a', sk: '3' }] });

    const items = await queryAll<{ sk: string }>({ pk: 'ACT#act_1' });

    expect(items.map((item) => item.sk)).toEqual(['1', '2', '3']);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(3);
  });
});

describe('get, put, update and delete', () => {
  it('gets by key and upgrades on read', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { pk: 'x', sk: 'y', schemaVersion: 1 } });

    expect(await getItem(userProfile(ALICE))).toMatchObject({ schemaVersion: 1 });
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0]?.input).toMatchObject({
      TableName: 'od-main-local',
      // `PROFILE`, per `data-model.md` §3.2 — corrected in P1-07.
      Key: { pk: `USER#${ALICE}`, sk: 'PROFILE' },
    });
  });

  it('returns undefined rather than an empty object for a missing item', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect(await getItem(userProfile(ALICE))).toBeUndefined();
  });

  it('puts without a condition by default', async () => {
    ddbMock.on(PutCommand).resolves({});
    await putItem({ ...userProfile(ALICE), schemaVersion: 1 });

    const input = ddbMock.commandCalls(PutCommand)[0]?.args[0]?.input as Record<
      string,
      unknown
    >;
    expect(input).not.toHaveProperty('ConditionExpression');
  });

  it('passes a condition through when one is given', async () => {
    ddbMock.on(PutCommand).resolves({});
    await putItem(
      { ...userProfile(ALICE), schemaVersion: 1 },
      { expression: 'attribute_not_exists(pk)' },
    );

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0]?.input).toMatchObject({
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('updates with ALL_NEW so the caller gets the row back', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { pk: 'x', sk: 'y' } });

    await updateItem(activityIndex(ALICE, 'act_1'), {
      expression: 'SET #t = :t',
      names: { '#t': 'title' },
      values: { ':t': 'Gym' },
    });

    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0]?.input).toMatchObject({
      ReturnValues: 'ALL_NEW',
      UpdateExpression: 'SET #t = :t',
    });
  });

  it('deletes by key', async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await deleteItem(userProfile(ALICE));

    expect(ddbMock.commandCalls(DeleteCommand)[0]?.args[0]?.input).toMatchObject({
      Key: { pk: `USER#${ALICE}`, sk: 'PROFILE' },
    });
  });

  /**
   * Unconditional by default, which is what a cascade wants — it has already read the
   * partition it is clearing and a condition would only add a way for it to fail halfway.
   */
  it('sends no condition when none is given', async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await deleteItem(userProfile(ALICE));

    expect(
      ddbMock.commandCalls(DeleteCommand)[0]?.args[0]?.input.ConditionExpression,
    ).toBeUndefined();
  });

  /**
   * Added in P1-08, mirroring `putItem`'s: a delete that must distinguish "removed it" from
   * "there was nothing there" says so as a condition and reads the resulting
   * `ConditionalCheckFailedException`, rather than paying for a read before every delete.
   */
  it('passes a condition through with its names and values', async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await deleteItem(userProfile(ALICE), {
      expression: 'attribute_exists(pk) AND #owner = :owner',
      names: { '#owner': 'ownerId' },
      values: { ':owner': ALICE },
    });

    expect(ddbMock.commandCalls(DeleteCommand)[0]?.args[0]?.input).toMatchObject({
      ConditionExpression: 'attribute_exists(pk) AND #owner = :owner',
      ExpressionAttributeNames: { '#owner': 'ownerId' },
      ExpressionAttributeValues: { ':owner': ALICE },
    });
  });

  it('omits the name and value maps when the condition needs neither', async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await deleteItem(userProfile(ALICE), { expression: 'attribute_exists(pk)' });

    const input = ddbMock.commandCalls(DeleteCommand)[0]?.args[0]?.input;
    expect(input?.ConditionExpression).toBe('attribute_exists(pk)');
    expect(input).not.toHaveProperty('ExpressionAttributeNames');
    expect(input).not.toHaveProperty('ExpressionAttributeValues');
  });
});

describe('deleteAll', () => {
  const keysFor = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ pk: 'ACT#act_1', sk: `ITEM#${i}` }));

  it('sends nothing for an empty list', async () => {
    await deleteAll([]);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('splits into batches of 25, which is DynamoDB’s limit', async () => {
    ddbMock.on(BatchWriteCommand).resolves({});
    await deleteAll(keysFor(60));

    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(3);
  });

  /**
   * `BatchWriteItem` **returns** the items it did not process rather than failing, so a
   * caller that ignored `UnprocessedItems` would leave rows behind under throttling and call
   * the delete a success — which, in a cascade, means an activity that looks deleted and is
   * not.
   */
  it('retries whatever came back unprocessed', async () => {
    ddbMock
      .on(BatchWriteCommand)
      .resolvesOnce({
        UnprocessedItems: {
          'od-main-local': [
            { DeleteRequest: { Key: { pk: 'ACT#act_1', sk: 'ITEM#0' } } },
          ],
        },
      })
      .resolves({});

    await deleteAll(keysFor(2));

    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(2);
  });

  it('gives up loudly rather than looping for ever', async () => {
    ddbMock.on(BatchWriteCommand).resolves({
      UnprocessedItems: {
        'od-main-local': [{ DeleteRequest: { Key: { pk: 'ACT#act_1', sk: 'ITEM#0' } } }],
      },
    });

    await expect(deleteAll(keysFor(1))).rejects.toThrow(/unprocessed after 5 attempts/);
  });
});
