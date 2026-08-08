import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { config } from './config.js';

/**
 * The single DynamoDB client, created once at module scope and reused across warm
 * invocations (`tech-stack.md` §4.5).
 *
 * **This module is reachable only from `src/repositories/**`.** Not from a route, not from
 * a handler, not from a service. That rule is what makes tenant isolation testable: if key
 * construction and table access live in one layer, there is one place to audit
 * (`repo-structure.md` §2.4, `security-privacy.md` §1 row 4).
 *
 * `src/lib/ddb.import.test.ts` asserts it, `dependency-cruiser` enforces it on the real
 * module graph in P0-27, and CI greps for key literals outside the repository layer. The
 * repository layer itself arrives in Phase 1 — this file exists now so that the seam is
 * defined before the first thing that would otherwise reach past it.
 */
const client = new DynamoDBClient({
  region: config.AWS_REGION,
  // The only local-vs-deployed branch permitted in runtime code. Everything else that
  // differs between a laptop and dev is configuration, not a code path.
  ...(config.DDB_ENDPOINT !== undefined && { endpoint: config.DDB_ENDPOINT }),
});

export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    // `exactOptionalPropertyTypes` keeps `undefined` and "absent" apart in the type system;
    // this keeps them apart at rest, by never writing an attribute for an undefined value.
    removeUndefinedValues: true,
  },
});

export const TABLE_NAME = config.TABLE_NAME;
