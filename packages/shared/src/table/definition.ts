/**
 * The DynamoDB key schema, as plain data.
 *
 * Three consumers read this and cannot drift from each other: `DataStack` maps it onto CDK
 * constructs (P0-12), the local table script maps it onto a `CreateTableCommand` (P0-21),
 * and the integration harness maps it onto a per-file test table.
 *
 * It lives in `packages/shared`, not `infra`, because `services/api` may import `@od/shared`
 * but may never import `infra` (`repo-structure.md` §3). No `aws-cdk-lib` type and no
 * `@aws-sdk` type may appear in this file — it is a description of a table, not a client
 * for one.
 */

/**
 * Attributes projected into `GSI1` beyond the four key attributes, which DynamoDB always
 * includes and which therefore must not be repeated here.
 *
 * `INCLUDE`, never `ALL` (`aws-services.md` §1.4, `data-model.md` §3.5). The agenda query is
 * the hottest read in the product; a narrower projection is fewer RCUs and less GSI storage.
 *
 * These are the **stored** `AgendaItem` fields (`api-contract.md` §2.2). The remaining
 * `AgendaItem` fields are absent on purpose because they are computed at read time and
 * projecting them would mean storing a value that goes stale:
 *
 * - `occurrenceDate`, `isSnoozed` — produced by expanding a series and merging `OCC#`
 *   overrides, so they do not exist on the index row at all.
 * - `hasCheckbox` — `type === 'task'`, derived from a field already projected.
 * - `isPast`, `overdueFromDate` — depend on the caller's today, not on the row.
 *
 * A GSI projection cannot be altered in place; changing it means replacing the index. This
 * list is therefore load-bearing, and P0-12 should confirm it before `DataStack` is first
 * deployed in Phase 4.
 */
export const GSI1_PROJECTED_ATTRIBUTES = [
  'activityId',
  'type',
  'title',
  'status',
  'timezone',
  'time',
  'endTime',
  'isRecurring',
  'participantAvatars',
  'participantCount',
  'locationLabel',
  'subtitle',
] as const;

export const TABLE = {
  partitionKey: 'pk',
  sortKey: 'sk',
  /** Epoch seconds. Used by invite tokens, idempotency records and rate-limit counters. */
  ttlAttribute: 'ttl',
  indexes: [
    {
      name: 'GSI1',
      partitionKey: 'gsi1pk',
      sortKey: 'gsi1sk',
      projection: 'INCLUDE',
      nonKeyAttributes: GSI1_PROJECTED_ATTRIBUTES,
    },
  ],
} as const;

export type TableDefinition = typeof TABLE;
export type IndexDefinition = TableDefinition['indexes'][number];

/**
 * Physical table name for a stage: `od-main-local`, `od-main-dev`, `od-main-prod`.
 * One speller, so the CDK stack and the local script cannot disagree.
 */
export function tableName(stage: string): string {
  return `od-main-${stage}`;
}
