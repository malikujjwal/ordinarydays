import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { GSI1_PROJECTED_ATTRIBUTES, TABLE } from '@od/shared/table';
import { describe, expect, it } from 'vitest';
import { createLocalTable } from '../../scripts/create-local-table.js';
import {
  admin as client,
  documents,
  TEST_TABLE as NAME,
  useTestTable,
} from './harness.js';

/**
 * The test that makes "the local database is the real schema" a fact.
 *
 * It creates the table with the same script `pnpm ddb:create-table` runs, then asserts the
 * **live** table against `@od/shared/table`, attribute for attribute.
 *
 * **Why it compares against the shared definition and not against the synthesised
 * `DataStack` template**, which is what P0-21's task description asks for: `repo-structure.md`
 * §3 rule 6 says nothing imports `infra`, and `services/api` may import `@od/shared` only
 * (rule 4). A test here that reached into the CDK app would be the first violation of the
 * dependency direction in the repository, to assert a property that is already covered from
 * both ends:
 *
 * - `infra/test/data-stack.test.ts` pins the CDK table to `@od/shared/table` — key schema,
 *   TTL attribute, index name, index keys, `INCLUDE` projection, non-key attributes, plus a
 *   "takes its whole shape from @od/shared/table" anti-drift assertion.
 * - This file pins the live local table to the same object, over the same fields.
 *
 * Both legs are exhaustive over `TABLE`, so local ≡ definition ≡ CDK. Raised in the P0-21
 * pull request rather than resolved silently.
 */

/**
 * No truncation between tests: this file asserts the table's *shape*, and the one test that
 * writes an item cleans up the item it wrote.
 */
useTestTable({ truncateBetweenTests: false });

describe('the local table', () => {
  it('is created by the same script the dev workflow runs', async () => {
    const { Table } = await client.send(new DescribeTableCommand({ TableName: NAME }));

    expect(Table?.TableName).toBe(NAME);
    expect(Table?.TableStatus).toBe('ACTIVE');
  });

  it('has the shared definition’s key schema, in order', async () => {
    const { Table } = await client.send(new DescribeTableCommand({ TableName: NAME }));

    expect(Table?.KeySchema).toEqual([
      { AttributeName: TABLE.partitionKey, KeyType: 'HASH' },
      { AttributeName: TABLE.sortKey, KeyType: 'RANGE' },
    ]);
  });

  it('declares exactly the four key attributes, all strings', async () => {
    const { Table } = await client.send(new DescribeTableCommand({ TableName: NAME }));

    const declared = (Table?.AttributeDefinitions ?? [])
      .map((a) => `${a.AttributeName}:${a.AttributeType}`)
      .sort();

    expect(declared).toEqual(
      [
        `${TABLE.partitionKey}:S`,
        `${TABLE.sortKey}:S`,
        `${TABLE.indexes[0].partitionKey}:S`,
        `${TABLE.indexes[0].sortKey}:S`,
      ].sort(),
    );
  });

  /**
   * One index, and only one. Every additional GSI is a second write on every mutation, and
   * adding one requires a written justification in `data-model.md` (`CLAUDE.md`).
   */
  it('has exactly the indexes the definition describes', async () => {
    const { Table } = await client.send(new DescribeTableCommand({ TableName: NAME }));

    expect(Table?.GlobalSecondaryIndexes?.map((i) => i.IndexName)).toEqual(
      TABLE.indexes.map((i) => i.name),
    );
  });

  it('keys GSI1 the way the definition does', async () => {
    const { Table } = await client.send(new DescribeTableCommand({ TableName: NAME }));
    const [gsi1] = TABLE.indexes;

    expect(Table?.GlobalSecondaryIndexes?.[0]?.KeySchema).toEqual([
      { AttributeName: gsi1.partitionKey, KeyType: 'HASH' },
      { AttributeName: gsi1.sortKey, KeyType: 'RANGE' },
    ]);
  });

  /**
   * `INCLUDE`, never `ALL`. A projection cannot be altered in place — changing it means
   * replacing the index — so a laptop that quietly used `ALL` would hide the cost of the
   * agenda query until it was expensive to fix.
   */
  it('projects INCLUDE with exactly the definition’s attributes', async () => {
    const { Table } = await client.send(new DescribeTableCommand({ TableName: NAME }));
    const projection = Table?.GlobalSecondaryIndexes?.[0]?.Projection;

    expect(projection?.ProjectionType).toBe('INCLUDE');
    expect([...(projection?.NonKeyAttributes ?? [])].sort()).toEqual(
      [...GSI1_PROJECTED_ATTRIBUTES].sort(),
    );
  });

  /**
   * TTL is a separate API call, not a `CreateTable` parameter, which makes it the easiest
   * thing in the definition to forget. If it were missing, invite tokens, idempotency
   * records and rate-limit counters would simply never expire — and nothing would fail.
   */
  it('enables TTL on the definition’s attribute', async () => {
    const { TimeToLiveDescription } = await client.send(
      new DescribeTimeToLiveCommand({ TableName: NAME }),
    );

    expect(TimeToLiveDescription?.TimeToLiveStatus).toBe('ENABLED');
    expect(TimeToLiveDescription?.AttributeName).toBe(TABLE.ttlAttribute);
  });
});

describe('the local table round-trips an item', () => {
  const key = { [TABLE.partitionKey]: 'USER#int-test', [TABLE.sortKey]: 'PROBE#1' };

  it('writes, reads back and deletes through the document client', async () => {
    await documents.send(
      new PutCommand({ TableName: NAME, Item: { ...key, title: 'A probe', count: 1 } }),
    );

    const { Item } = await documents.send(new GetCommand({ TableName: NAME, Key: key }));

    expect(Item).toMatchObject({ ...key, title: 'A probe', count: 1 });

    await documents.send(new DeleteCommand({ TableName: NAME, Key: key }));
    const after = await documents.send(new GetCommand({ TableName: NAME, Key: key }));
    expect(after.Item).toBeUndefined();
  });
});

describe('the create script', () => {
  it('is a no-op when the table already matches', async () => {
    expect(await createLocalTable(client, NAME)).toBe('unchanged');
  });

  /**
   * The reset button, which is the whole reason the script is safe to run without thinking.
   *
   * `./.dynamodb-data` survives `docker compose down`, so a table created before a schema
   * change outlives it. Detecting drift and recreating is what stops a laptop from quietly
   * running against last week's key schema — the failure mode being a query that returns
   * nothing and looks like a bug in the code that wrote the row.
   *
   * Run against its own table name so a failure here cannot destroy the one the rest of the
   * file just asserted.
   */
  it('deletes and recreates a table whose schema has drifted', async () => {
    const drifted = `${NAME}-drift-probe`;

    await client.send(
      new CreateTableCommand({
        TableName: drifted,
        BillingMode: 'PAY_PER_REQUEST',
        // One key, wrongly named, and no index at all.
        AttributeDefinitions: [{ AttributeName: 'wrongKey', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'wrongKey', KeyType: 'HASH' }],
      }),
    );

    expect(await createLocalTable(client, drifted)).toBe('recreated');

    const { Table } = await client.send(new DescribeTableCommand({ TableName: drifted }));
    expect(Table?.KeySchema).toEqual([
      { AttributeName: TABLE.partitionKey, KeyType: 'HASH' },
      { AttributeName: TABLE.sortKey, KeyType: 'RANGE' },
    ]);
    expect(Table?.GlobalSecondaryIndexes?.map((i) => i.IndexName)).toEqual(
      TABLE.indexes.map((i) => i.name),
    );

    await client.send(new DeleteTableCommand({ TableName: drifted }));
  });
});
