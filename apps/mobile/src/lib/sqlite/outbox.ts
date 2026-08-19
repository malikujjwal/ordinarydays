import { MAX_AUTOMATIC_INTENT_AGE_DAYS, MAX_OFFLINE_MUTATIONS } from '@od/shared';
import type { SqliteExecutor, SqliteReader, SqliteRow } from '@/lib/sqlite/database';

export type OutboxStatus = 'queued' | 'in_flight' | 'acknowledged' | 'needs_attention';

export type OutboxAttention =
  | {
      readonly kind: 'rejected';
      readonly status?: number;
      readonly code?: string;
      readonly details?: unknown;
    }
  | {
      readonly kind: 'parked';
      readonly reason:
        | 'clock_uncertainty'
        | 'replay_age_expired'
        | 'ambiguous_collision'
        | 'legacy_unknown';
    };

export interface OutboxIntent {
  readonly intentId: string;
  readonly mutationKey: readonly string[];
  readonly variables: unknown;
  readonly entityId: string;
  readonly orderingKey: string;
  readonly status: OutboxStatus;
  readonly createdAt: number;
  readonly seq: number;
  readonly attempts: number;
  readonly attention?: OutboxAttention;
  readonly lastError?: string;
  readonly reconciliationVersion?: string;
  readonly dependsOnIntentId?: string;
  readonly compensationForIntentId?: string;
}

export interface OutboxAppendInput {
  readonly intentId: string;
  readonly mutationKey: readonly string[];
  readonly variables: unknown;
  readonly entityId: string;
  readonly orderingKey?: string;
  readonly dependsOnIntentId?: string;
  readonly compensationForIntentId?: string;
}

export class OutboxFullError extends Error {
  constructor() {
    super("You're offline and there's a lot waiting to sync.");
    this.name = 'OutboxFullError';
  }
}

export class OutboxInvariantError extends Error {
  constructor(readonly intentId: string) {
    super(`Intent id ${intentId} was reused for a different durable action.`);
    this.name = 'OutboxInvariantError';
  }
}

const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_AUTOMATIC_AGE_MS = MAX_AUTOMATIC_INTENT_AGE_DAYS * 24 * 60 * 60 * 1000;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

export function outboxSemanticKey(input: OutboxAppendInput): string {
  return JSON.stringify(
    canonicalValue({
      mutationKey: input.mutationKey,
      variables: input.variables,
      entityId: input.entityId,
      orderingKey: input.orderingKey ?? `activity:${input.entityId}`,
      dependsOnIntentId: input.dependsOnIntentId,
      compensationForIntentId: input.compensationForIntentId,
    }),
  );
}

function stringValue(row: SqliteRow, column: string): string | undefined {
  const value = row[column];
  return typeof value === 'string' ? value : undefined;
}

function numberValue(row: SqliteRow, column: string): number | undefined {
  const value = row[column];
  return typeof value === 'number' ? value : undefined;
}

function parseJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(value) as unknown;
}

function intentFromRow(row: SqliteRow): OutboxIntent {
  const intentId = stringValue(row, 'intent_id');
  const mutationKey = parseJson(stringValue(row, 'mutation_key_json'));
  const variables = parseJson(stringValue(row, 'variables_json'));
  const entityId = stringValue(row, 'entity_id');
  const orderingKey = stringValue(row, 'ordering_key');
  const status = stringValue(row, 'status');
  const createdAt = numberValue(row, 'created_at');
  const seq = numberValue(row, 'seq');
  const attempts = numberValue(row, 'attempts');
  if (
    intentId === undefined ||
    !Array.isArray(mutationKey) ||
    !mutationKey.every((part) => typeof part === 'string') ||
    entityId === undefined ||
    orderingKey === undefined ||
    (status !== 'queued' &&
      status !== 'in_flight' &&
      status !== 'acknowledged' &&
      status !== 'needs_attention') ||
    createdAt === undefined ||
    seq === undefined ||
    attempts === undefined
  ) {
    throw new OutboxInvariantError(intentId ?? 'malformed');
  }
  const attentionKind = stringValue(row, 'attention_kind');
  const attentionStatus = numberValue(row, 'attention_status');
  const attentionCode = stringValue(row, 'attention_code');
  const attentionDetails = stringValue(row, 'attention_details_json');
  const attention: OutboxAttention | undefined =
    attentionKind === 'rejected'
      ? {
          kind: 'rejected',
          ...(attentionStatus === undefined ? {} : { status: attentionStatus }),
          ...(attentionCode === undefined ? {} : { code: attentionCode }),
          ...(attentionDetails === undefined
            ? {}
            : { details: parseJson(attentionDetails) }),
        }
      : attentionKind === 'parked'
        ? {
            kind: 'parked',
            reason: (stringValue(row, 'attention_reason') ?? 'legacy_unknown') as Extract<
              OutboxAttention,
              { kind: 'parked' }
            >['reason'],
          }
        : undefined;
  const lastError = stringValue(row, 'last_error');
  const reconciliationVersion = stringValue(row, 'reconciliation_version');
  const dependsOnIntentId = stringValue(row, 'depends_on_intent_id');
  const compensationForIntentId = stringValue(row, 'compensation_for_intent_id');
  return {
    intentId,
    mutationKey,
    variables,
    entityId,
    orderingKey,
    status,
    createdAt,
    seq,
    attempts,
    ...(attention === undefined ? {} : { attention }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(reconciliationVersion === undefined ? {} : { reconciliationVersion }),
    ...(dependsOnIntentId === undefined ? {} : { dependsOnIntentId }),
    ...(compensationForIntentId === undefined ? {} : { compensationForIntentId }),
  };
}

export class OutboxRepository {
  constructor(private readonly reader: SqliteReader) {}

  async append(
    database: SqliteExecutor,
    input: OutboxAppendInput,
    now = Date.now(),
  ): Promise<{ readonly kind: 'inserted' | 'existing'; readonly intent: OutboxIntent }> {
    const existing = await database.first(
      'SELECT * FROM outbox_intents WHERE intent_id = ?;',
      [input.intentId],
    );
    const semanticKey = outboxSemanticKey(input);
    if (existing !== undefined) {
      if (stringValue(existing, 'semantic_key') !== semanticKey) {
        throw new OutboxInvariantError(input.intentId);
      }
      return { kind: 'existing', intent: intentFromRow(existing) };
    }
    const occupied = await database.first(
      "SELECT COUNT(*) AS count FROM outbox_intents WHERE status <> 'acknowledged';",
    );
    if ((numberValue(occupied ?? {}, 'count') ?? 0) >= MAX_OFFLINE_MUTATIONS) {
      throw new OutboxFullError();
    }
    const meta = await database.first(
      'SELECT next_seq, clock_witness FROM outbox_meta WHERE singleton = 1;',
    );
    const seq = numberValue(meta ?? {}, 'next_seq');
    if (seq === undefined) throw new OutboxInvariantError(input.intentId);
    const orderingKey = input.orderingKey ?? `activity:${input.entityId}`;
    await database.run(
      `INSERT INTO outbox_intents (
        intent_id, mutation_key_json, variables_json, entity_id, ordering_key,
        status, created_at, seq, attempts, depends_on_intent_id,
        compensation_for_intent_id, semantic_key
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?);`,
      [
        input.intentId,
        JSON.stringify(input.mutationKey),
        JSON.stringify(input.variables),
        input.entityId,
        orderingKey,
        now,
        seq,
        input.dependsOnIntentId ?? null,
        input.compensationForIntentId ?? null,
        semanticKey,
      ],
    );
    await database.run(
      'UPDATE outbox_meta SET next_seq = ?, clock_witness = MAX(clock_witness, ?) WHERE singleton = 1;',
      [seq + 1, now],
    );
    const inserted = await database.first(
      'SELECT * FROM outbox_intents WHERE intent_id = ?;',
      [input.intentId],
    );
    if (inserted === undefined) throw new OutboxInvariantError(input.intentId);
    return { kind: 'inserted', intent: intentFromRow(inserted) };
  }

  async all(): Promise<readonly OutboxIntent[]> {
    return (await this.reader.all('SELECT * FROM outbox_intents ORDER BY seq;')).map(
      intentFromRow,
    );
  }

  async get(database: SqliteReader, intentId: string): Promise<OutboxIntent | undefined> {
    const row = await database.first(
      'SELECT * FROM outbox_intents WHERE intent_id = ?;',
      [intentId],
    );
    return row === undefined ? undefined : intentFromRow(row);
  }

  async forEntity(entityId: string): Promise<readonly OutboxIntent[]> {
    return (
      await this.reader.all(
        'SELECT * FROM outbox_intents WHERE entity_id = ? ORDER BY seq;',
        [entityId],
      )
    ).map(intentFromRow);
  }

  async claimNext(
    database: SqliteExecutor,
    now = Date.now(),
  ): Promise<OutboxIntent | undefined> {
    await this.parkExpired(database, now);
    const row = await database.first(`
      SELECT candidate.*
      FROM outbox_intents candidate
      LEFT JOIN outbox_intents dependency
        ON dependency.intent_id = candidate.depends_on_intent_id
      WHERE candidate.status = 'queued'
        AND (candidate.depends_on_intent_id IS NULL OR dependency.status = 'acknowledged')
        AND NOT EXISTS (
          SELECT 1 FROM outbox_intents earlier
          WHERE earlier.ordering_key = candidate.ordering_key
            AND earlier.seq < candidate.seq
            AND earlier.status IN ('queued', 'in_flight', 'needs_attention')
        )
      ORDER BY candidate.seq
      LIMIT 1;
    `);
    if (row === undefined) return undefined;
    const intent = intentFromRow(row);
    await database.run(
      "UPDATE outbox_intents SET status = 'in_flight', attempts = attempts + 1, last_error = NULL WHERE intent_id = ? AND status = 'queued';",
      [intent.intentId],
    );
    const claimed = await database.first(
      'SELECT * FROM outbox_intents WHERE intent_id = ?;',
      [intent.intentId],
    );
    return claimed === undefined ? undefined : intentFromRow(claimed);
  }

  async acknowledge(
    database: SqliteExecutor,
    intentId: string,
    reconciliationVersion?: string,
  ): Promise<void> {
    const current = await database.first(
      'SELECT depends_on_intent_id FROM outbox_intents WHERE intent_id = ?;',
      [intentId],
    );
    const dependencyId =
      current === undefined ? undefined : stringValue(current, 'depends_on_intent_id');
    const dependent = await database.first(
      'SELECT intent_id FROM outbox_intents WHERE depends_on_intent_id = ? LIMIT 1;',
      [intentId],
    );
    if (dependent !== undefined || reconciliationVersion !== undefined) {
      await database.run(
        `UPDATE outbox_intents
         SET status = 'acknowledged', reconciliation_version = ?, last_error = NULL,
             attention_kind = NULL, attention_reason = NULL, attention_status = NULL,
             attention_code = NULL, attention_details_json = NULL
         WHERE intent_id = ?;`,
        [reconciliationVersion ?? null, intentId],
      );
      return;
    }
    await database.run('DELETE FROM outbox_intents WHERE intent_id = ?;', [intentId]);
    if (dependencyId !== undefined) {
      await database.run(
        `DELETE FROM outbox_intents
         WHERE intent_id = ? AND status = 'acknowledged'
           AND reconciliation_version IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM outbox_intents dependent
             WHERE dependent.depends_on_intent_id = ?
           );`,
        [dependencyId, dependencyId],
      );
    }
  }

  async requeue(
    database: SqliteExecutor,
    intentId: string,
    error: string,
  ): Promise<void> {
    await database.run(
      "UPDATE outbox_intents SET status = 'queued', last_error = ? WHERE intent_id = ? AND status = 'in_flight';",
      [error, intentId],
    );
  }

  async needsAttention(
    database: SqliteExecutor,
    intentId: string,
    attention: OutboxAttention,
    error?: string,
  ): Promise<void> {
    await database.run(
      `UPDATE outbox_intents SET
        status = 'needs_attention', attention_kind = ?, attention_reason = ?,
        attention_status = ?, attention_code = ?, attention_details_json = ?, last_error = ?
       WHERE intent_id = ?;`,
      [
        attention.kind,
        attention.kind === 'parked' ? attention.reason : null,
        attention.kind === 'rejected' ? (attention.status ?? null) : null,
        attention.kind === 'rejected' ? (attention.code ?? null) : null,
        attention.kind === 'rejected' && attention.details !== undefined
          ? JSON.stringify(attention.details)
          : null,
        error ?? null,
        intentId,
      ],
    );
  }

  async cancelQueued(database: SqliteExecutor, intentId: string): Promise<boolean> {
    const result = await database.run(
      "DELETE FROM outbox_intents WHERE intent_id = ? AND status = 'queued';",
      [intentId],
    );
    return result.changes === 1;
  }

  private async parkExpired(database: SqliteExecutor, now: number): Promise<void> {
    const meta = await database.first(
      'SELECT clock_witness FROM outbox_meta WHERE singleton = 1;',
    );
    const witness = numberValue(meta ?? {}, 'clock_witness') ?? now;
    const rolledBack = now + CLOCK_TOLERANCE_MS < witness;
    const queued = await database.all(
      "SELECT intent_id, created_at FROM outbox_intents WHERE status = 'queued';",
    );
    for (const row of queued) {
      const intentId = stringValue(row, 'intent_id');
      const createdAt = numberValue(row, 'created_at');
      if (intentId === undefined || createdAt === undefined) continue;
      const uncertain = rolledBack || createdAt > now + CLOCK_TOLERANCE_MS;
      const tooOld = now - createdAt > MAX_AUTOMATIC_AGE_MS;
      if (uncertain || tooOld) {
        await this.needsAttention(database, intentId, {
          kind: 'parked',
          reason: uncertain ? 'clock_uncertainty' : 'replay_age_expired',
        });
      }
    }
    await database.run(
      'UPDATE outbox_meta SET clock_witness = MAX(clock_witness, ?) WHERE singleton = 1;',
      [now],
    );
  }
}
