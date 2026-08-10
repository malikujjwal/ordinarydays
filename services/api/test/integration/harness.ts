import {
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { TABLE, tableName } from '@od/shared/table';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import { createLocalTable } from '../../scripts/create-local-table.js';

/**
 * One table per integration test **file**, created from `@od/shared/table`, truncated
 * between tests and dropped at the end (`testing.md` §3.1, P1-28).
 *
 * ## What this replaces
 *
 * Every file used to point at the shared `od-main-local` and then hand-clean the partitions
 * it happened to know about. That works only for rows whose partition key a test can name,
 * and the rows it cannot name are the ones that caused the bugs: `ACT#<id>` partitions that
 * survived between runs and made an item count a fact about the container rather than about
 * the run; `IDEM#<user>#<key>` records that made the second run of a file report `in-flight`;
 * `RATE#` counters that accumulated across a file until it started answering `429`. Each of
 * those was found the hard way and worked around in place, three times, in three different
 * shapes. A table nobody else can reach removes the cause rather than the symptom.
 *
 * It also means a test may assert on **everything in the table**, which the sweeps could
 * never support.
 *
 * ## Why a Scan is right here and banned everywhere else
 *
 * `truncate` reads every key with a `Scan` and deletes them in batches. The ban
 * (`data-model.md` §5, `CLAUDE.md`) is about application code: a `Scan` there reads a
 * multi-tenant table in full, and the Lambda's IAM policy denies it at runtime. Neither
 * applies to a disposable table containing one file's fixtures, and `check-forbidden.mjs`'s
 * `no-scan` roots — `services/api/src`, `apps`, `packages` — deliberately exclude test code.
 * The alternative is what the sweeps did: enumerate only the partitions you can name, and be
 * wrong about the rest.
 */

const ENDPOINT = process.env.DDB_ENDPOINT ?? 'http://localhost:8000';

/**
 * The calling test file's name, kebab-cased: `activityRepository.int.test.ts` becomes
 * `activity-repository`.
 *
 * Derived rather than passed in. A name the file states is a name two files can state the
 * same way — a copy-pasted constant is exactly how "one table per file" quietly becomes two
 * files sharing one — and there is nothing to keep in step when a file is renamed.
 *
 * `expect.getState().testPath` is set before a file is collected, so it is available here, at
 * module scope, which is what lets `TEST_TABLE` be a constant the environment is configured
 * from below. It throws rather than falling back to a shared name: a harness that silently
 * put two files on one table would reintroduce precisely the failures it exists to remove.
 */
function currentFileSlug(): string {
  const path = expect.getState().testPath;
  if (path === undefined || path === '') {
    throw new Error(
      'harness.ts could not determine the test file it was imported from, so it cannot ' +
        'name a table for it. It must be imported from a test file, not from a setup file ' +
        'or a plain module.',
    );
  }
  const stem = (path.split(/[\\/]/).pop() ?? '').replace(/\.int\.test\.ts$/, '');
  return stem.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** `od-main-test-<file>`, built by the one speller the CDK stack and local script use. */
export const TEST_TABLE = tableName(`test-${currentFileSlug()}`);

/**
 * Set at module scope, because `lib/config.ts` parses the environment when it loads and
 * `lib/ddb.ts` builds its client from the result. Importing this harness is therefore the
 * whole of a file's environment setup: whatever it imports afterwards — statically or in a
 * `beforeAll` — reads this table.
 *
 * The constant half of the environment (`STAGE`, `AUTH_MODE`, `MEDIA_BUCKET`, `WEB_ORIGINS`,
 * `LOG_LEVEL`) lives in `vitest.int.config.ts`, where a value that changes for every file at
 * once belongs. Only the per-file table name and the local endpoint are set here.
 */
process.env.TABLE_NAME = TEST_TABLE;
process.env.DDB_ENDPOINT = ENDPOINT;
process.env.AWS_REGION ??= 'us-east-1';
// DynamoDB Local requires credentials to be present, not valid.
process.env.AWS_ACCESS_KEY_ID ??= 'local';
process.env.AWS_SECRET_ACCESS_KEY ??= 'localsecret';

/**
 * The administrative client: table lifecycle and truncation, never the code under test.
 *
 * Separate from `lib/ddb.ts`'s client on purpose. This one exists to set up and tear down the
 * table; that one is the thing being tested, and a test that shared it could not tell a
 * broken repository from a broken fixture.
 */
export const admin = new DynamoDBClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: ENDPOINT,
  credentials: { accessKeyId: 'local', secretAccessKey: 'localsecret' },
});

/** Document-client view of {@link admin}, so keys come back as plain values. */
export const documents = DynamoDBDocumentClient.from(admin);

/** DynamoDB's hard cap on `BatchWriteItem`. */
const BATCH_LIMIT = 25;

type Key = Record<string, string>;

/**
 * Deletes one batch, re-sending whatever DynamoDB declined.
 *
 * `UnprocessedItems` is not an error and is not empty-by-default: a batch that is throttled
 * or too large comes back partially done, and a harness that ignored the remainder would
 * leave rows behind for the next test to trip over — the exact failure mode this file exists
 * to end.
 */
async function deleteBatch(keys: Key[]): Promise<void> {
  let pending = keys.map((key) => ({ DeleteRequest: { Key: key } }));

  for (let attempt = 0; pending.length > 0 && attempt < 10; attempt += 1) {
    const { UnprocessedItems } = await documents.send(
      new BatchWriteCommand({ RequestItems: { [TEST_TABLE]: pending } }),
    );
    pending = (UnprocessedItems?.[TEST_TABLE] ?? []) as typeof pending;
  }

  if (pending.length > 0) {
    throw new Error(
      `${TEST_TABLE} would not accept ${pending.length} deletes after 10 attempts.`,
    );
  }
}

/**
 * Empties the file's table: every item, whatever partition it is in.
 *
 * Dropping and recreating instead would be simpler to write and much slower — a create plus
 * two waiters per test rather than one round trip — and the table it recreated would be
 * identical to the one it dropped.
 */
export async function truncate(): Promise<void> {
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await documents.send(
      new ScanCommand({
        TableName: TEST_TABLE,
        // Keys only. Nothing here reads the items, and a fixture with a large `notes` field
        // would otherwise be pulled over the wire to be thrown away.
        ProjectionExpression: '#pk, #sk',
        ExpressionAttributeNames: { '#pk': TABLE.partitionKey, '#sk': TABLE.sortKey },
        ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
      }),
    );

    const keys = (page.Items ?? []) as Key[];
    for (let from = 0; from < keys.length; from += BATCH_LIMIT) {
      await deleteBatch(keys.slice(from, from + BATCH_LIMIT));
    }

    startKey = page.LastEvaluatedKey;
  } while (startKey !== undefined);
}

export interface TestTableOptions {
  /**
   * `false` for a file whose tests build on each other by design — the seed suite writes once
   * in `beforeAll` and then asserts against it, and the schema suite asserts the table rather
   * than its contents. Everything else takes the default: an empty table per test, so an
   * assertion about a count is a fact about that test alone (§3.2).
   */
  readonly truncateBetweenTests?: boolean;
}

/**
 * Registers the table's whole lifecycle for the calling file. Call it once, at module scope,
 * above the file's own hooks — Vitest runs `beforeAll` in registration order, so the table
 * exists before anything the file imports goes looking for it.
 */
export function useTestTable(options: TestTableOptions = {}): void {
  beforeAll(async () => {
    await createLocalTable(admin, TEST_TABLE);
  });

  if (options.truncateBetweenTests !== false) {
    beforeEach(async () => {
      await truncate();
    });
  }

  afterAll(async () => {
    await admin.send(new DeleteTableCommand({ TableName: TEST_TABLE }));
    await waitUntilTableNotExists(
      { client: admin, maxWaitTime: 30 },
      { TableName: TEST_TABLE },
    );
    admin.destroy();
  });
}
