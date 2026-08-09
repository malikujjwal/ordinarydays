import {
  type AttributeDefinition,
  BillingMode,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  type GlobalSecondaryIndex,
  type KeySchemaElement,
  KeyType,
  ProjectionType,
  ResourceNotFoundException,
  ScalarAttributeType,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import { TABLE, tableName } from '@od/shared/table';

/**
 * Creates `od-main-local` in DynamoDB Local from the **same definition `DataStack` uses**.
 *
 * This script maps `@od/shared/table` onto a `CreateTableCommand`; `infra` maps the same
 * object onto CDK constructs. Neither adds a key, an index or a projected attribute of its
 * own, which is what makes "the local database is the real schema" a fact rather than a
 * hope — and `test/integration/table-schema.int.test.ts` asserts it against the live table.
 *
 * Idempotent, and deliberately blunt about it: a table whose schema already matches is left
 * alone, and one whose schema has drifted is **deleted and recreated** with a warning. A
 * laptop table is disposable, and the alternative — a careful in-place migration — is a lot
 * of code protecting data nobody should be keeping there. The `./.dynamodb-data` volume
 * survives `docker compose down`, so a stale table can outlive a schema change; this script
 * is the reset button and is meant to be run without thinking.
 */

const [gsi1] = TABLE.indexes;

const attributeDefinitions: AttributeDefinition[] = [
  { AttributeName: TABLE.partitionKey, AttributeType: ScalarAttributeType.S },
  { AttributeName: TABLE.sortKey, AttributeType: ScalarAttributeType.S },
  { AttributeName: gsi1.partitionKey, AttributeType: ScalarAttributeType.S },
  { AttributeName: gsi1.sortKey, AttributeType: ScalarAttributeType.S },
];

const keySchema: KeySchemaElement[] = [
  { AttributeName: TABLE.partitionKey, KeyType: KeyType.HASH },
  { AttributeName: TABLE.sortKey, KeyType: KeyType.RANGE },
];

const globalSecondaryIndexes: GlobalSecondaryIndex[] = [
  {
    IndexName: gsi1.name,
    KeySchema: [
      { AttributeName: gsi1.partitionKey, KeyType: KeyType.HASH },
      { AttributeName: gsi1.sortKey, KeyType: KeyType.RANGE },
    ],
    Projection: {
      ProjectionType: ProjectionType.INCLUDE,
      NonKeyAttributes: [...gsi1.nonKeyAttributes],
    },
  },
];

/**
 * Loose enough to accept both what we send (`GlobalSecondaryIndex`) and what DynamoDB
 * returns (`GlobalSecondaryIndexDescription`), which are different types describing the
 * same thing. Every property is explicitly `| undefined` because `exactOptionalPropertyTypes`
 * distinguishes "absent" from "present and undefined", and the SDK's types are the latter.
 */
interface TableShape {
  KeySchema?: KeySchemaElement[] | undefined;
  AttributeDefinitions?: AttributeDefinition[] | undefined;
  GlobalSecondaryIndexes?:
    | Array<{
        IndexName?: string | undefined;
        KeySchema?: KeySchemaElement[] | undefined;
        Projection?:
          | {
              ProjectionType?: string | undefined;
              NonKeyAttributes?: string[] | undefined;
            }
          | undefined;
      }>
    | undefined;
}

/**
 * The comparable shape of a table: keys, attributes and indexes, with order removed.
 *
 * Sorted before comparison because DynamoDB does not promise the order it returns
 * `AttributeDefinitions` or `NonKeyAttributes` in, and a script that recreated the table
 * because two lists were permuted would destroy data for no reason.
 */
function fingerprint(input: TableShape): string {
  return JSON.stringify({
    // Key schema order is meaningful — HASH then RANGE — so it is not sorted.
    keys: (input.KeySchema ?? []).map((k) => `${k.AttributeName}:${k.KeyType}`),
    attributes: (input.AttributeDefinitions ?? [])
      .map((a) => `${a.AttributeName}:${a.AttributeType}`)
      .sort(),
    indexes: (input.GlobalSecondaryIndexes ?? [])
      .map((i) => ({
        name: i.IndexName,
        keys: (i.KeySchema ?? []).map((k) => `${k.AttributeName}:${k.KeyType}`),
        projection: i.Projection?.ProjectionType,
        included: [...(i.Projection?.NonKeyAttributes ?? [])].sort(),
      }))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
  });
}

const desiredFingerprint = fingerprint({
  KeySchema: keySchema,
  AttributeDefinitions: attributeDefinitions,
  GlobalSecondaryIndexes: globalSecondaryIndexes,
});

async function describe(client: DynamoDBClient, name: string) {
  try {
    const { Table } = await client.send(new DescribeTableCommand({ TableName: name }));
    return Table;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return undefined;
    throw error;
  }
}

async function create(client: DynamoDBClient, name: string): Promise<void> {
  await client.send(
    new CreateTableCommand({
      TableName: name,
      // Matches `DataStack`. DynamoDB Local ignores billing mode entirely, which is one of
      // the divergences P4-15 exists to catch — it is set here so the two definitions read
      // the same, not because the container enforces it.
      BillingMode: BillingMode.PAY_PER_REQUEST,
      AttributeDefinitions: attributeDefinitions,
      KeySchema: keySchema,
      GlobalSecondaryIndexes: globalSecondaryIndexes,
    }),
  );
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: name });

  // TTL is not a `CreateTable` parameter; it is a separate call on both real DynamoDB and
  // the local container. `DataStack` expresses it as `timeToLiveAttribute`, so leaving it
  // out here would be a real divergence in the one direction that matters: rows that should
  // expire — invite tokens, idempotency records, rate-limit counters — would not.
  await client.send(
    new UpdateTimeToLiveCommand({
      TableName: name,
      TimeToLiveSpecification: { AttributeName: TABLE.ttlAttribute, Enabled: true },
    }),
  );
}

/**
 * Drops the table and builds it again — an empty table with the right schema.
 *
 * Added in P1-21 for `pnpm seed:local --reset`. Truncating by reading every key and deleting
 * it would need a `Scan`, which is banned in this codebase outside one-off migrations; and it
 * would be slower and less certain than dropping a container's table. Recreating also
 * guarantees the schema is current, which a truncate would not.
 *
 * It carries no guard of its own. The only caller is a script that has already refused to run
 * outside `local` with an explicit `DDB_ENDPOINT`, and duplicating that check here would put
 * the safety in two places where it can drift rather than one where it cannot.
 */
export async function resetLocalTable(
  client: DynamoDBClient,
  name: string,
): Promise<void> {
  if ((await describe(client, name)) !== undefined) {
    await client.send(new DeleteTableCommand({ TableName: name }));
    await waitUntilTableNotExists({ client, maxWaitTime: 30 }, { TableName: name });
  }
  await create(client, name);
}

export async function createLocalTable(
  client: DynamoDBClient,
  name: string,
): Promise<'created' | 'unchanged' | 'recreated'> {
  const existing = await describe(client, name);

  if (existing === undefined) {
    await create(client, name);
    return 'created';
  }

  if (fingerprint(existing) === desiredFingerprint) return 'unchanged';

  await client.send(new DeleteTableCommand({ TableName: name }));
  await waitUntilTableNotExists({ client, maxWaitTime: 30 }, { TableName: name });
  await create(client, name);
  return 'recreated';
}

/**
 * Reads the environment directly rather than through `src/lib/config.ts`.
 *
 * That module is the service's single env reader and it validates the **runtime's** whole
 * environment — `MEDIA_BUCKET`, `WEB_ORIGINS`, `STAGE`. A table script that refused to run
 * because the media bucket was unset would be enforcing a rule that has nothing to do with
 * creating a table. This is a developer tool, not part of the service, and it needs three
 * variables.
 */
function requireEndpoint(): { endpoint: string; region: string; name: string } {
  const endpoint = process.env.DDB_ENDPOINT;
  if (endpoint === undefined || endpoint === '') {
    throw new Error(
      'DDB_ENDPOINT is not set. This script only ever talks to DynamoDB Local — refusing ' +
        'to run without an explicit local endpoint, so that it can never delete and ' +
        'recreate a deployed table.',
    );
  }
  return {
    endpoint,
    region: process.env.AWS_REGION ?? 'us-east-1',
    name: process.env.TABLE_NAME ?? tableName('local'),
  };
}

async function main(): Promise<void> {
  const { endpoint, region, name } = requireEndpoint();
  const client = new DynamoDBClient({ region, endpoint });

  const result = await createLocalTable(client, name);

  const message = {
    created: `Created ${name} at ${endpoint}.`,
    unchanged: `${name} already matches @od/shared/table. Nothing to do.`,
    recreated: `WARNING: ${name} did not match @od/shared/table and was deleted and recreated. Any local data in it is gone.`,
  }[result];

  console.log(message);
}

// Run only when invoked as a script. The exported functions above are what the integration
// test uses, and importing this file must not talk to a database.
if (process.argv[1]?.endsWith('create-local-table.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
