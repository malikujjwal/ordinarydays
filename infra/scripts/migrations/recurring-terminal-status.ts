import { pathToFileURL } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';

type DamagedStatus = 'completed' | 'skipped';
type StoredItem = Record<string, unknown>;

interface CommandClient {
  send(command: ScanCommand | TransactWriteCommand): Promise<unknown>;
}

export interface DamagedSeries {
  readonly activityId: string;
  readonly currentStatus: DamagedStatus;
  readonly proposedStatus: 'scheduled';
  readonly expectedUpdatedAt: string;
  readonly metaKey: Readonly<{ pk: string; sk: string }>;
  readonly indexKeys: readonly Readonly<{ pk: string; sk: string }>[];
}

export interface AuditReport {
  readonly tableName: string;
  readonly mode: 'report-only' | 'repair';
  readonly damagedSeries: readonly {
    activityId: string;
    currentStatus: DamagedStatus;
    proposedStatus: 'scheduled';
    indexRowCount: number;
  }[];
}

const terminalStatus = (value: unknown): value is DamagedStatus =>
  value === 'completed' || value === 'skipped';

const keyOf = (item: StoredItem): { pk: string; sk: string } | undefined =>
  typeof item.pk === 'string' && typeof item.sk === 'string'
    ? { pk: item.pk, sk: item.sk }
    : undefined;

/** Pure classification used by both the operator command and fixture tests. */
export function findDamagedSeries(items: readonly StoredItem[]): DamagedSeries[] {
  const indexKeys = new Map<string, { pk: string; sk: string }[]>();
  for (const item of items) {
    if (item.entity !== 'ActivityIndex' || typeof item.activityId !== 'string') continue;
    const key = keyOf(item);
    if (key === undefined) continue;
    const existing = indexKeys.get(item.activityId) ?? [];
    existing.push(key);
    indexKeys.set(item.activityId, existing);
  }

  return items
    .flatMap((item): DamagedSeries[] => {
      const metaKey = keyOf(item);
      if (
        item.entity !== 'Activity' ||
        typeof item.activityId !== 'string' ||
        typeof item.updatedAt !== 'string' ||
        item.recurrence === undefined ||
        !terminalStatus(item.status) ||
        metaKey === undefined
      ) {
        return [];
      }
      return [
        {
          activityId: item.activityId,
          currentStatus: item.status,
          proposedStatus: 'scheduled',
          expectedUpdatedAt: item.updatedAt,
          metaKey,
          indexKeys: (indexKeys.get(item.activityId) ?? []).toSorted((left, right) =>
            `${left.pk}\u0000${left.sk}`.localeCompare(`${right.pk}\u0000${right.sk}`),
          ),
        },
      ];
    })
    .toSorted((left, right) => left.activityId.localeCompare(right.activityId));
}

export function confirmationFor(tableName: string): string {
  return `REPAIR_RECURRING_STATUS:${tableName}`;
}

export function assertRepairConfirmation(tableName: string, confirmation?: string): void {
  const expected = confirmationFor(tableName);
  if (confirmation !== expected) {
    throw new Error(`Repair refused. Pass --confirm ${expected} exactly.`);
  }
}

function repairTransaction(
  tableName: string,
  candidate: DamagedSeries,
  repairedAt: string,
): TransactWriteCommandInput {
  const commonValues = {
    ':activityId': candidate.activityId,
    ':current': candidate.currentStatus,
    ':expected': candidate.expectedUpdatedAt,
    ':scheduled': candidate.proposedStatus,
    ':repairedAt': repairedAt,
  };
  const meta = {
    Update: {
      TableName: tableName,
      Key: candidate.metaKey,
      UpdateExpression:
        'SET #status = :scheduled, #updatedAt = :repairedAt REMOVE #completedAt, #outcome',
      ConditionExpression:
        '#activityId = :activityId AND #status = :current AND #updatedAt = :expected AND attribute_exists(#recurrence)',
      ExpressionAttributeNames: {
        '#activityId': 'activityId',
        '#status': 'status',
        '#updatedAt': 'updatedAt',
        '#recurrence': 'recurrence',
        '#completedAt': 'completedAt',
        '#outcome': 'outcome',
      },
      ExpressionAttributeValues: commonValues,
    },
  };
  const indexes = candidate.indexKeys.map((key) => ({
    Update: {
      TableName: tableName,
      Key: key,
      UpdateExpression: 'SET #status = :scheduled, #updatedAt = :repairedAt',
      ConditionExpression:
        '#activityId = :activityId AND #status = :current AND #updatedAt = :expected',
      ExpressionAttributeNames: {
        '#activityId': 'activityId',
        '#status': 'status',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: commonValues,
    },
  }));
  const transactItems = [meta, ...indexes];
  if (transactItems.length > 100) {
    throw new Error(
      `${candidate.activityId} has too many index rows for one safe repair.`,
    );
  }
  return { TransactItems: transactItems };
}

async function scanAll(client: CommandClient, tableName: string): Promise<StoredItem[]> {
  const items: StoredItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const response = (await client.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression:
          'pk, sk, entity, activityId, #status, recurrence, updatedAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ...(exclusiveStartKey === undefined
          ? {}
          : { ExclusiveStartKey: exclusiveStartKey }),
      }),
    )) as { Items?: StoredItem[]; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(response.Items ?? []));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return items;
}

export async function auditRecurringTerminalStatus(
  client: CommandClient,
  options: {
    readonly tableName: string;
    readonly repair?: boolean;
    readonly confirmation?: string;
    readonly now?: () => string;
  },
): Promise<AuditReport> {
  if (options.repair === true) {
    assertRepairConfirmation(options.tableName, options.confirmation);
  }
  const candidates = findDamagedSeries(await scanAll(client, options.tableName));
  if (options.repair === true) {
    const repairedAt = (options.now ?? (() => new Date().toISOString()))();
    for (const candidate of candidates) {
      await client.send(
        new TransactWriteCommand(
          repairTransaction(options.tableName, candidate, repairedAt),
        ),
      );
    }
  }
  return {
    tableName: options.tableName,
    mode: options.repair === true ? 'repair' : 'report-only',
    damagedSeries: candidates.map((candidate) => ({
      activityId: candidate.activityId,
      currentStatus: candidate.currentStatus,
      proposedStatus: candidate.proposedStatus,
      indexRowCount: candidate.indexKeys.length,
    })),
  };
}

async function main(): Promise<void> {
  const tableName = process.env.TABLE_NAME;
  if (tableName === undefined || tableName.length === 0) {
    throw new Error('TABLE_NAME is required.');
  }
  const repair = process.argv.includes('--repair');
  const confirmAt = process.argv.indexOf('--confirm');
  const confirmation = confirmAt === -1 ? undefined : process.argv[confirmAt + 1];
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const report = await auditRecurringTerminalStatus(client, {
    tableName,
    repair,
    ...(confirmation === undefined ? {} : { confirmation }),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
