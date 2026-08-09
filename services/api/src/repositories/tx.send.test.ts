import {
  type CancellationReason,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../lib/errors.js';
import { userProfile } from './keys.js';
import { transactWrite } from './tx.js';

/**
 * The composition and the error mapping.
 *
 * The integration suite proves a real cancellation is caught; this proves the **shape** —
 * that every item is stamped with the table name, and that a cancellation reason is mapped
 * back to the item that caused it. Constructing a `TransactionCanceledException` with
 * whatever reasons a test needs is something only a mock can do: provoking each combination
 * against a real table would mean engineering a failure per case.
 */
const ddbMock = mockClient(DynamoDBDocumentClient);

const ALICE = 'usr_a';
const item = { Put: { Item: { ...userProfile(ALICE), schemaVersion: 1 } } };

const cancelled = (reasons: CancellationReason[]) =>
  new TransactionCanceledException({
    message: 'Transaction cancelled',
    CancellationReasons: reasons,
    $metadata: {},
  });

beforeEach(() => {
  ddbMock.reset();
});

describe('composition', () => {
  it('stamps every item with the table name, so no call site has to remember', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    await transactWrite([item, item, item], { operation: 'createActivity' });

    const sent = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0]?.input
      .TransactItems as Array<{ Put?: { TableName?: string } }>;

    expect(sent).toHaveLength(3);
    expect(sent.every((entry) => entry.Put?.TableName === 'od-main-local')).toBe(true);
  });

  it('preserves the condition a caller set alongside the table name', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    await transactWrite(
      [{ Put: { ...item.Put, ConditionExpression: 'attribute_not_exists(pk)' } }],
      { operation: 'createUser' },
    );

    const sent = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0]?.input
      .TransactItems as Array<{ Put?: Record<string, unknown> }> | undefined;

    expect(sent?.[0]?.Put).toMatchObject({
      TableName: 'od-main-local',
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('sends nothing at all for an empty transaction', async () => {
    await transactWrite([], { operation: 'noop' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('refuses to send more than 100 items', async () => {
    await expect(
      transactWrite(
        Array.from({ length: 101 }, () => item),
        { operation: 'huge' },
      ),
    ).rejects.toThrow(AppError);

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe('cancellation mapping', () => {
  it('maps a failed condition to a conflict by default', async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejects(cancelled([{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }]));

    await expect(transactWrite([item, item], { operation: 'x' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  /**
   * The SDK reports one reason per item, in order. That positional mapping is the only way
   * to know *which* condition failed, and losing it is why "the transaction was cancelled"
   * is such an unhelpful error in practice.
   */
  it('hands the failing item’s index to the caller’s mapper', async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejects(
        cancelled([
          { Code: 'None' },
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
        ]),
      );

    const seen: number[] = [];

    await expect(
      transactWrite([item, item, item], {
        operation: 'createActivity',
        onConditionFailed: (index) => {
          seen.push(index);
          return new AppError('conflict', `item ${index} lost`);
        },
      }),
    ).rejects.toThrow('item 2 lost');

    expect(seen).toEqual([2]);
  });

  it('falls back to the default conflict when the mapper declines', async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejects(cancelled([{ Code: 'ConditionalCheckFailed' }]));

    await expect(
      transactWrite([item], { operation: 'x', onConditionFailed: () => undefined }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  /**
   * Throughput or a genuine service failure is not the caller's fault and not something they
   * can act on, so it stays what it was and surfaces as a 500 — rather than being dressed up
   * as a conflict the user is invited to resolve.
   */
  it('leaves a non-condition cancellation alone', async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejects(cancelled([{ Code: 'ThrottlingError' }, { Code: 'None' }]));

    await expect(transactWrite([item, item], { operation: 'x' })).rejects.toBeInstanceOf(
      TransactionCanceledException,
    );
  });

  it('leaves an unrelated error alone', async () => {
    ddbMock.on(TransactWriteCommand).rejects(new Error('socket hang up'));

    await expect(transactWrite([item], { operation: 'x' })).rejects.toThrow(
      'socket hang up',
    );
  });
});
