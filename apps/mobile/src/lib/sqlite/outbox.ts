import { MAX_AUTOMATIC_INTENT_AGE_DAYS, MAX_OFFLINE_MUTATIONS } from '@od/shared';
import { changesRecurrenceTopology } from '@/lib/mutationKeys';
import type { SqliteExecutor, SqliteReader, SqliteRow } from '@/lib/sqlite/database';

export type OutboxStatus = 'queued' | 'in_flight' | 'acknowledged' | 'needs_attention';

export type OutboxAttention =
  | {
      readonly kind: 'rejected';
      readonly status?: number;
      readonly code?: string;
      readonly details?: unknown;
      readonly recoveryRequired?: true;
    }
  | {
      readonly kind: 'parked';
      readonly reason:
        | 'clock_uncertainty'
        | 'replay_age_expired'
        | 'ambiguous_collision'
        | 'predecessor_rejected'
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
  readonly recoveryRequired?: true;
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

export interface CanonicalOutboxGuards {
  readonly deletedActivityIds: ReadonlySet<string>;
  readonly deletedReminderIds: ReadonlySet<string>;
  readonly createdReminderIds: ReadonlySet<string>;
  /** Ordinary pulls cannot overwrite any still-represented local Activity work. */
  readonly protectedActivityIds: ReadonlySet<string>;
  /** Occurrence-only local work is protected even when the Activity row stayed canonical. */
  readonly protectedOccurrenceKeys: ReadonlySet<string>;
  readonly reconcilingActivityIds: ReadonlySet<string>;
}

export interface ListArchiveUndoOffer {
  readonly originalIntentId: string;
  readonly currentIntentId: string;
  readonly listId: string;
  readonly inverseIntentId?: string;
  readonly undoToken?: string;
  readonly undoExpiresAt?: string;
  readonly createdAt: number;
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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function freshVariables(value: unknown, freshIntentId: string): unknown {
  const variables = record(value);
  if (variables === undefined) throw new Error('Blocked intent variables are malformed.');
  const hasIntentId = typeof variables.intentId === 'string';
  const hasIdempotencyKey = typeof variables.idempotencyKey === 'string';
  if (!hasIntentId && !hasIdempotencyKey) {
    throw new Error('Blocked intent has no retry identity.');
  }
  return {
    ...variables,
    ...(hasIntentId ? { intentId: freshIntentId } : {}),
    ...(hasIdempotencyKey ? { idempotencyKey: freshIntentId } : {}),
  };
}

/**
 * How a parked create is re-identified, per mutation.
 *
 * `idKeys` are the payload fields that name the entity. Spelled out rather than "rewrite
 * every string that matches": a title or a note may legitimately contain an id, and rewriting
 * one would edit the user's own words.
 *
 * `orderingKeyPrefix` is `undefined` when the ordering key does **not** name the entity being
 * re-minted. An item create is the case: its key names the list, so items typed in sequence
 * reach the server in that sequence and an item create serialises behind an archive of the
 * same list. Re-minting the item must leave that key alone, or the retried write would order
 * itself against a list nothing else names.
 */
interface RemapDescriptor {
  readonly idKeys: readonly string[];
  readonly orderingKeyPrefix?: string;
}

/** Both create mutations, named once so the guard below cannot drift from the descriptor. */
function isCreateMutation(mutationKey: readonly string[]): boolean {
  return mutationKey[1] === 'create' || mutationKey[1] === 'item-create';
}

function remapDescriptor(mutationKey: readonly string[]): RemapDescriptor | undefined {
  const [domain, name] = mutationKey;
  if (domain === 'activity') {
    return { idKeys: ['activityId', 'parentActivityId'], orderingKeyPrefix: 'activity' };
  }
  if (domain === 'list') {
    return name === 'item-create'
      ? { idKeys: ['itemId'] }
      : { idKeys: ['listId'], orderingKeyPrefix: 'list' };
  }
  return undefined;
}

function remapEntityVariables(
  value: unknown,
  previousEntityId: string,
  freshEntityId: string,
  idKeys: readonly string[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((child) =>
      remapEntityVariables(child, previousEntityId, freshEntityId, idKeys),
    );
  }
  const object = record(value);
  if (object === undefined) return value;
  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => [
      key,
      idKeys.includes(key) && child === previousEntityId
        ? freshEntityId
        : remapEntityVariables(child, previousEntityId, freshEntityId, idKeys),
    ]),
  );
}

/** Snapshot of unresolved local removals/creates used inside canonical install transactions. */
export async function readCanonicalOutboxGuards(
  database: SqliteReader,
): Promise<CanonicalOutboxGuards> {
  const deletedActivityIds = new Set<string>();
  const deletedReminderIds = new Set<string>();
  const createdReminderIds = new Set<string>();
  const protectedActivityIds = new Set<string>();
  const protectedOccurrenceKeys = new Set<string>();
  const reconcilingActivityIds = new Set<string>();
  const rows = await database.all(
    `SELECT mutation_key_json, variables_json, entity_id, status, attention_kind,
            attention_reason
     FROM outbox_intents
     WHERE status IN ('queued', 'in_flight', 'needs_attention')
        OR (status = 'acknowledged' AND reconciliation_version IS NOT NULL);`,
  );
  for (const row of rows) {
    const mutationKey = parseJson(stringValue(row, 'mutation_key_json'));
    const variables = record(parseJson(stringValue(row, 'variables_json')));
    if (!Array.isArray(mutationKey) || variables === undefined) continue;
    /* Rolled-back work must not shield the projection that replaced it. */
    if (
      stringValue(row, 'status') === 'needs_attention' &&
      (stringValue(row, 'attention_kind') === 'rejected' ||
        (stringValue(row, 'attention_kind') === 'parked' &&
          stringValue(row, 'attention_reason') === 'predecessor_rejected'))
    ) {
      continue;
    }
    const activityId = stringValue(row, 'entity_id');
    if (
      activityId !== undefined &&
      mutationKey[1] !== 'reminder-create' &&
      mutationKey[1] !== 'reminder-delete'
    ) {
      protectedActivityIds.add(activityId);
    }
    if (
      activityId !== undefined &&
      changesRecurrenceTopology({ mutationKey, variables }) &&
      stringValue(row, 'status') === 'acknowledged'
    ) {
      reconcilingActivityIds.add(activityId);
    }
    if (mutationKey[1] === 'delete') {
      if (activityId !== undefined) deletedActivityIds.add(activityId);
      continue;
    }
    if (mutationKey[1] === 'reminder-delete') {
      if (typeof variables.reminderId === 'string') {
        deletedReminderIds.add(variables.reminderId);
      }
      continue;
    }
    const input = record(variables.input);
    if (activityId !== undefined && typeof input?.occurrenceDate === 'string') {
      protectedOccurrenceKeys.add(`${activityId}:${input.occurrenceDate}`);
    }
    if (mutationKey[1] === 'reminder-create' && typeof input?.reminderId === 'string') {
      createdReminderIds.add(input.reminderId);
    }
  }
  for (const row of await database.all('SELECT activity_id FROM activity_tombstones;')) {
    const activityId = stringValue(row, 'activity_id');
    if (activityId !== undefined) deletedActivityIds.add(activityId);
  }
  for (const row of await database.all('SELECT reminder_id FROM reminder_tombstones;')) {
    const reminderId = stringValue(row, 'reminder_id');
    if (reminderId !== undefined) deletedReminderIds.add(reminderId);
  }
  return {
    deletedActivityIds,
    deletedReminderIds,
    createdReminderIds,
    protectedActivityIds,
    protectedOccurrenceKeys,
    reconcilingActivityIds,
  };
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
  const attentionReason = stringValue(row, 'attention_reason');
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
          ...(attentionReason === 'authoritative_recovery_required'
            ? { recoveryRequired: true as const }
            : {}),
        }
      : attentionKind === 'parked'
        ? {
            kind: 'parked',
            reason: (attentionReason ?? 'legacy_unknown') as Extract<
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
    ...(attention?.kind === 'rejected' && attention.recoveryRequired === true
      ? { recoveryRequired: true as const }
      : {}),
    ...(dependsOnIntentId === undefined ? {} : { dependsOnIntentId }),
    ...(compensationForIntentId === undefined ? {} : { compensationForIntentId }),
  };
}

/** Presentation readers use the same decoder without gaining access to mutation methods. */
export async function readOutboxIntents(
  reader: SqliteReader,
): Promise<readonly OutboxIntent[]> {
  return (await reader.all('SELECT * FROM outbox_intents ORDER BY seq;')).map(
    intentFromRow,
  );
}

export class OutboxRepository {
  constructor(private readonly reader: SqliteReader) {}

  async append(
    database: SqliteExecutor,
    input: OutboxAppendInput,
    now = Date.now(),
  ): Promise<{ readonly kind: 'inserted' | 'existing'; readonly intent: OutboxIntent }> {
    /* One snapshot lookup covers idempotency, sequence allocation and the offline cap. */
    const allocation = await database.first(
      `SELECT existing.*, meta.next_seq AS meta_next_seq,
        (SELECT COUNT(*) FROM outbox_intents
         WHERE status IN ('queued', 'in_flight', 'needs_attention')) AS unresolved_count
       FROM outbox_meta meta
       LEFT JOIN outbox_intents existing ON existing.intent_id = ?
       WHERE meta.singleton = 1;`,
      [input.intentId],
    );
    const semanticKey = outboxSemanticKey(input);
    if (stringValue(allocation ?? {}, 'intent_id') !== undefined) {
      if (stringValue(allocation ?? {}, 'semantic_key') !== semanticKey) {
        throw new OutboxInvariantError(input.intentId);
      }
      return { kind: 'existing', intent: intentFromRow(allocation ?? {}) };
    }
    if (
      (numberValue(allocation ?? {}, 'unresolved_count') ?? 0) >= MAX_OFFLINE_MUTATIONS
    ) {
      throw new OutboxFullError();
    }
    const seq = numberValue(allocation ?? {}, 'meta_next_seq');
    if (seq === undefined) throw new OutboxInvariantError(input.intentId);
    const orderingKey = input.orderingKey ?? `activity:${input.entityId}`;
    const mutationKeyJson = JSON.stringify(input.mutationKey);
    const variablesJson = JSON.stringify(input.variables);
    if (variablesJson === undefined) throw new OutboxInvariantError(input.intentId);
    await database.run(
      `INSERT INTO outbox_intents (
        intent_id, mutation_key_json, variables_json, entity_id, ordering_key,
        status, created_at, seq, attempts, depends_on_intent_id,
        compensation_for_intent_id, semantic_key
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?);`,
      [
        input.intentId,
        mutationKeyJson,
        variablesJson,
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
    return {
      kind: 'inserted',
      intent: {
        intentId: input.intentId,
        mutationKey: JSON.parse(mutationKeyJson) as string[],
        variables: JSON.parse(variablesJson) as unknown,
        entityId: input.entityId,
        orderingKey,
        status: 'queued',
        createdAt: now,
        seq,
        attempts: 0,
        ...(input.dependsOnIntentId === undefined
          ? {}
          : { dependsOnIntentId: input.dependsOnIntentId }),
        ...(input.compensationForIntentId === undefined
          ? {}
          : { compensationForIntentId: input.compensationForIntentId }),
      },
    };
  }

  async all(): Promise<readonly OutboxIntent[]> {
    return readOutboxIntents(this.reader);
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

  /** List rows whose optimistic projection must survive a canonical index pull. */
  async protectedListIds(
    database: SqliteReader = this.reader,
  ): Promise<ReadonlySet<string>> {
    const rows = await database.all(
      `SELECT DISTINCT entity_id FROM outbox_intents
       WHERE json_extract(mutation_key_json, '$[0]') = 'list'
         -- An item intent's entity is an item; it protects a row in a different table.
         AND json_extract(mutation_key_json, '$[1]') NOT LIKE 'item-%'
         AND status IN ('queued', 'in_flight', 'needs_attention')
         AND NOT (
           status = 'needs_attention'
           AND (
             attention_kind = 'rejected'
             OR (attention_kind = 'parked' AND attention_reason = 'predecessor_rejected')
           )
         );`,
    );
    return new Set(
      rows
        .map((row) => stringValue(row, 'entity_id'))
        .filter((value): value is string => value !== undefined),
    );
  }

  /**
   * Item rows a canonical page must not overwrite, because this device still owes a write for
   * them: an unresolved **create**, whose row the server could not have included, or an
   * unresolved **edit**, whose fields the page predates (P3-29).
   *
   * The edit case is what stops a background page landing between an accepted edit and its
   * acknowledgement and flickering the old value back onto the screen. The protection ends at
   * settlement, where the server's own row — including whatever a concurrent member changed —
   * replaces the optimistic one.
   *
   * Rolled-back work is excluded on the same rule `protectedListIds` uses: a rejected write
   * must not shield the projection that replaced it.
   */
  async protectedListItemIds(
    listId: string,
    database: SqliteReader = this.reader,
  ): Promise<ReadonlySet<string>> {
    const rows = await database.all(
      `SELECT DISTINCT entity_id FROM outbox_intents
       WHERE mutation_key_json IN ('["list","item-create"]', '["list","item-patch"]')
         AND json_extract(variables_json, '$.listId') = ?
         AND status IN ('queued', 'in_flight', 'needs_attention')
         AND NOT (
           status = 'needs_attention'
           AND (
             attention_kind = 'rejected'
             OR (attention_kind = 'parked' AND attention_reason = 'predecessor_rejected')
           )
         );`,
      [listId],
    );
    return new Set(
      rows
        .map((row) => stringValue(row, 'entity_id'))
        .filter((value): value is string => value !== undefined),
    );
  }

  async createListArchiveUndoOffer(
    database: SqliteExecutor,
    originalIntentId: string,
    listId: string,
    createdAt = Date.now(),
  ): Promise<void> {
    await database.run(
      `INSERT OR IGNORE INTO list_archive_undo_offers
         (original_intent_id, current_intent_id, list_id, created_at)
       VALUES (?, ?, ?, ?);`,
      [originalIntentId, originalIntentId, listId, createdAt],
    );
  }

  async listArchiveUndoOffer(
    database: SqliteReader,
    intentId: string,
  ): Promise<ListArchiveUndoOffer | undefined> {
    const row = await database.first(
      `SELECT * FROM list_archive_undo_offers
       WHERE original_intent_id = ? OR current_intent_id = ? LIMIT 1;`,
      [intentId, intentId],
    );
    if (row === undefined) return undefined;
    const originalIntentId = stringValue(row, 'original_intent_id');
    const listId = stringValue(row, 'list_id');
    const currentIntentId = stringValue(row, 'current_intent_id');
    const createdAt = numberValue(row, 'created_at');
    if (
      originalIntentId === undefined ||
      currentIntentId === undefined ||
      listId === undefined ||
      createdAt === undefined
    ) {
      throw new OutboxInvariantError(intentId);
    }
    const inverseIntentId = stringValue(row, 'inverse_intent_id');
    const undoToken = stringValue(row, 'undo_token');
    const undoExpiresAt = stringValue(row, 'undo_expires_at');
    return {
      originalIntentId,
      currentIntentId,
      listId,
      createdAt,
      ...(inverseIntentId === undefined ? {} : { inverseIntentId }),
      ...(undoToken === undefined ? {} : { undoToken }),
      ...(undoExpiresAt === undefined ? {} : { undoExpiresAt }),
    };
  }

  async linkListArchiveUndoIntent(
    database: SqliteExecutor,
    originalIntentId: string,
    inverseIntentId: string,
  ): Promise<void> {
    const result = await database.run(
      `UPDATE list_archive_undo_offers SET inverse_intent_id = ?
       WHERE original_intent_id = ? AND inverse_intent_id IS NULL;`,
      [inverseIntentId, originalIntentId],
    );
    if (result.changes !== 1) throw new OutboxInvariantError(originalIntentId);
  }

  async clearListArchiveUndoOffer(
    database: SqliteExecutor,
    originalIntentId: string,
    onlyWhenUnaccepted = false,
  ): Promise<void> {
    await database.run(
      `DELETE FROM list_archive_undo_offers WHERE original_intent_id = ?${
        onlyWhenUnaccepted ? ' AND inverse_intent_id IS NULL' : ''
      };`,
      [originalIntentId],
    );
  }

  async expireUnacceptedListArchiveUndoOffers(
    database: SqliteExecutor,
    createdBefore: number,
  ): Promise<number> {
    const result = await database.run(
      `DELETE FROM list_archive_undo_offers
       WHERE inverse_intent_id IS NULL AND created_at < ?;`,
      [createdBefore],
    );
    return result.changes;
  }

  /** Installs the server token on an accepted dependent before its archive dependency clears. */
  async recordListArchiveUndoToken(
    database: SqliteExecutor,
    currentIntentId: string,
    undoToken: string,
    undoExpiresAt: string,
  ): Promise<void> {
    const offer = await this.listArchiveUndoOffer(database, currentIntentId);
    if (offer === undefined) return;
    await database.run(
      `UPDATE list_archive_undo_offers SET undo_token = ?, undo_expires_at = ?
       WHERE original_intent_id = ?;`,
      [undoToken, undoExpiresAt, offer.originalIntentId],
    );
    if (offer.inverseIntentId === undefined) return;
    const inverse = await this.get(database, offer.inverseIntentId);
    if (
      inverse?.status !== 'queued' ||
      inverse.mutationKey[0] !== 'list' ||
      inverse.mutationKey[1] !== 'undo'
    ) {
      throw new OutboxInvariantError(offer.inverseIntentId);
    }
    const variables = record(inverse.variables);
    if (variables === undefined) throw new OutboxInvariantError(inverse.intentId);
    const rebasedVariables = { ...variables, undoToken };
    const semanticKey = outboxSemanticKey({
      intentId: inverse.intentId,
      mutationKey: inverse.mutationKey,
      variables: rebasedVariables,
      entityId: inverse.entityId,
      orderingKey: inverse.orderingKey,
      ...(inverse.dependsOnIntentId === undefined
        ? {}
        : { dependsOnIntentId: inverse.dependsOnIntentId }),
      ...(inverse.compensationForIntentId === undefined
        ? {}
        : { compensationForIntentId: inverse.compensationForIntentId }),
    });
    await database.run(
      `UPDATE outbox_intents SET variables_json = ?, semantic_key = ?
       WHERE intent_id = ? AND status = 'queued';`,
      [JSON.stringify(rebasedVariables), semanticKey, inverse.intentId],
    );
  }

  /** Refreshes a rejected List PATCH from the authoritative row before user-directed Retry. */
  async rebaseListPatchIntent(
    database: SqliteExecutor,
    intentId: string,
    serverVersion: string,
  ): Promise<OutboxIntent> {
    const intent = await this.get(database, intentId);
    if (
      intent?.status !== 'queued' ||
      intent.mutationKey[0] !== 'list' ||
      intent.mutationKey[1] !== 'patch'
    ) {
      throw new OutboxInvariantError(intentId);
    }
    const variables = record(intent.variables);
    if (variables === undefined || typeof variables.ifMatch !== 'string') {
      throw new OutboxInvariantError(intentId);
    }
    const rebasedVariables = { ...variables, ifMatch: serverVersion };
    const semanticKey = outboxSemanticKey({
      intentId: intent.intentId,
      mutationKey: intent.mutationKey,
      variables: rebasedVariables,
      entityId: intent.entityId,
      orderingKey: intent.orderingKey,
      ...(intent.dependsOnIntentId === undefined
        ? {}
        : { dependsOnIntentId: intent.dependsOnIntentId }),
      ...(intent.compensationForIntentId === undefined
        ? {}
        : { compensationForIntentId: intent.compensationForIntentId }),
    });
    await database.run(
      `UPDATE outbox_intents SET variables_json = ?, semantic_key = ?
       WHERE intent_id = ? AND status = 'queued';`,
      [JSON.stringify(rebasedVariables), semanticKey, intentId],
    );
    const rebased = await this.get(database, intentId);
    if (rebased === undefined) throw new OutboxInvariantError(intentId);
    return rebased;
  }

  /** Moves an archive offer and any accepted compensation to the identity chosen by Retry. */
  async reidentifyListArchiveUndoOffer(
    database: SqliteExecutor,
    previousIntentId: string,
    freshIntentId: string,
  ): Promise<void> {
    const offer = await this.listArchiveUndoOffer(database, previousIntentId);
    if (offer === undefined) return;
    if (offer.inverseIntentId !== undefined) {
      const inverse = await this.get(database, offer.inverseIntentId);
      if (
        inverse === undefined ||
        inverse.mutationKey[0] !== 'list' ||
        inverse.mutationKey[1] !== 'undo' ||
        (inverse.status !== 'queued' &&
          !(
            inverse.status === 'needs_attention' &&
            inverse.attention?.kind === 'parked' &&
            inverse.attention.reason === 'predecessor_rejected'
          ))
      ) {
        throw new OutboxInvariantError(offer.inverseIntentId);
      }
      const variables = record(inverse.variables);
      if (variables?.originalIntentId !== offer.originalIntentId) {
        throw new OutboxInvariantError(inverse.intentId);
      }
      const semanticKey = outboxSemanticKey({
        intentId: inverse.intentId,
        mutationKey: inverse.mutationKey,
        variables,
        entityId: inverse.entityId,
        orderingKey: inverse.orderingKey,
        ...(inverse.dependsOnIntentId === undefined
          ? {}
          : { dependsOnIntentId: inverse.dependsOnIntentId }),
        ...(inverse.compensationForIntentId === undefined
          ? {}
          : { compensationForIntentId: inverse.compensationForIntentId }),
      });
      await database.run(
        `UPDATE outbox_intents SET semantic_key = ?, status = 'queued', attempts = 0,
           last_error = NULL, attention_kind = NULL, attention_reason = NULL,
           attention_status = NULL, attention_code = NULL, attention_details_json = NULL
         WHERE intent_id = ?;`,
        [semanticKey, inverse.intentId],
      );
    }
    const moved = await database.run(
      `UPDATE list_archive_undo_offers SET current_intent_id = ?
       WHERE current_intent_id = ?;`,
      [freshIntentId, previousIntentId],
    );
    if (moved.changes !== 1) throw new OutboxInvariantError(previousIntentId);
  }

  async laterInOrdering(
    database: SqliteReader,
    orderingKey: string,
    seq: number,
  ): Promise<readonly OutboxIntent[]> {
    return (
      await database.all(
        `SELECT * FROM outbox_intents
         WHERE ordering_key = ? AND seq > ?
           AND status IN ('queued', 'in_flight', 'needs_attention')
         ORDER BY seq;`,
        [orderingKey, seq],
      )
    ).map(intentFromRow);
  }

  async hasUnacknowledgedCreate(
    database: SqliteReader,
    entityId: string,
  ): Promise<boolean> {
    const row = await database.first(
      `SELECT intent_id FROM outbox_intents
       WHERE entity_id = ?
         AND status IN ('queued', 'in_flight', 'needs_attention')
         AND json_extract(mutation_key_json, '$[0]') = 'activity'
         AND json_extract(mutation_key_json, '$[1]') = 'create'
       LIMIT 1;`,
      [entityId],
    );
    return row !== undefined;
  }

  async claimNext(
    database: SqliteExecutor,
    now = Date.now(),
    excludedOrderingKeys: ReadonlySet<string> = new Set(),
  ): Promise<OutboxIntent | undefined> {
    await this.parkExpired(database, now);
    const excluded = [...excludedOrderingKeys];
    const exclusion =
      excluded.length === 0
        ? ''
        : `AND candidate.ordering_key NOT IN (${excluded.map(() => '?').join(', ')})`;
    const row = await database.first(
      `
      SELECT candidate.*
      FROM outbox_intents candidate
      LEFT JOIN outbox_intents dependency
        ON dependency.intent_id = candidate.depends_on_intent_id
      WHERE candidate.status = 'queued'
        AND (candidate.depends_on_intent_id IS NULL OR dependency.status = 'acknowledged')
        ${exclusion}
        AND NOT EXISTS (
          SELECT 1 FROM outbox_intents earlier
          WHERE earlier.ordering_key = candidate.ordering_key
            AND earlier.seq < candidate.seq
            AND earlier.status IN ('queued', 'in_flight', 'needs_attention')
        )
      ORDER BY candidate.seq
      LIMIT 1;
    `,
      excluded,
    );
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

  /** Reopens work claimed by a previous process; call once before a session can dispatch. */
  async recoverAbandoned(database: SqliteExecutor): Promise<number> {
    const result = await database.run(
      "UPDATE outbox_intents SET status = 'queued' WHERE status = 'in_flight';",
    );
    return result.changes;
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

  /**
   * Carries a server-authored Activity version to the next queued PATCH in this FIFO domain.
   *
   * Reminder writes do not author Activity versions and may be skipped. Any intervening write
   * that does return a newer Activity acknowledgement calls this again before the PATCH becomes
   * claimable, so the durable precondition monotonically follows server order. The payload and
   * semantic identity move together; the local canonical Activity version is never advanced.
   */
  async rebaseNextQueuedPatch(
    database: SqliteExecutor,
    orderingKey: string,
    seq: number,
    serverVersion: string,
  ): Promise<boolean> {
    const row = await database.first(
      `SELECT * FROM outbox_intents
       WHERE ordering_key = ? AND seq > ? AND status = 'queued'
         AND json_extract(mutation_key_json, '$[0]') = 'activity'
         AND json_extract(mutation_key_json, '$[1]') = 'patch'
       ORDER BY seq LIMIT 1;`,
      [orderingKey, seq],
    );
    if (row === undefined) return false;
    const successor = intentFromRow(row);
    const variables = record(successor.variables);
    if (variables === undefined || typeof variables.ifMatch !== 'string') {
      throw new OutboxInvariantError(successor.intentId);
    }
    const rebasedVariables = { ...variables, ifMatch: serverVersion };
    const semanticKey = outboxSemanticKey({
      intentId: successor.intentId,
      mutationKey: successor.mutationKey,
      variables: rebasedVariables,
      entityId: successor.entityId,
      orderingKey: successor.orderingKey,
      ...(successor.dependsOnIntentId === undefined
        ? {}
        : { dependsOnIntentId: successor.dependsOnIntentId }),
      ...(successor.compensationForIntentId === undefined
        ? {}
        : { compensationForIntentId: successor.compensationForIntentId }),
    });
    const result = await database.run(
      `UPDATE outbox_intents SET variables_json = ?, semantic_key = ?
       WHERE intent_id = ? AND status = 'queued';`,
      [JSON.stringify(rebasedVariables), semanticKey, successor.intentId],
    );
    return result.changes === 1;
  }

  /** Carries a server-authored List version to the next queued settings patch. */
  async rebaseNextQueuedListPatch(
    database: SqliteExecutor,
    orderingKey: string,
    seq: number,
    serverVersion: string,
  ): Promise<boolean> {
    const row = await database.first(
      `SELECT * FROM outbox_intents
       WHERE ordering_key = ? AND seq > ? AND status = 'queued'
         AND json_extract(mutation_key_json, '$[0]') = 'list'
         AND json_extract(mutation_key_json, '$[1]') = 'patch'
       ORDER BY seq LIMIT 1;`,
      [orderingKey, seq],
    );
    if (row === undefined) return false;
    const successor = intentFromRow(row);
    const variables = record(successor.variables);
    if (variables === undefined || typeof variables.ifMatch !== 'string') {
      throw new OutboxInvariantError(successor.intentId);
    }
    const rebasedVariables = { ...variables, ifMatch: serverVersion };
    const semanticKey = outboxSemanticKey({
      intentId: successor.intentId,
      mutationKey: successor.mutationKey,
      variables: rebasedVariables,
      entityId: successor.entityId,
      orderingKey: successor.orderingKey,
    });
    const result = await database.run(
      `UPDATE outbox_intents SET variables_json = ?, semantic_key = ?
       WHERE intent_id = ? AND status = 'queued';`,
      [JSON.stringify(rebasedVariables), semanticKey, successor.intentId],
    );
    return result.changes === 1;
  }

  async requeue(
    database: SqliteExecutor,
    intentId: string,
    error?: string,
  ): Promise<void> {
    await database.run(
      "UPDATE outbox_intents SET status = 'queued', last_error = ? WHERE intent_id = ? AND status = 'in_flight';",
      [error ?? null, intentId],
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
        attention.kind === 'parked'
          ? attention.reason
          : attention.recoveryRequired === true
            ? 'authoritative_recovery_required'
            : null,
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

  async completeAuthoritativeRecovery(
    database: SqliteExecutor,
    intentId: string,
  ): Promise<boolean> {
    const result = await database.run(
      `UPDATE outbox_intents SET attention_reason = NULL
       WHERE intent_id = ? AND status = 'needs_attention'
         AND attention_kind = 'rejected'
         AND attention_reason = 'authoritative_recovery_required';`,
      [intentId],
    );
    return result.changes > 0;
  }

  async pendingReconciliations(
    database: SqliteReader = this.reader,
  ): Promise<readonly OutboxIntent[]> {
    return (
      await database.all(
        `SELECT * FROM outbox_intents
         WHERE status = 'acknowledged' AND reconciliation_version IS NOT NULL
         ORDER BY seq;`,
      )
    ).map(intentFromRow);
  }

  async failReconciliation(
    database: SqliteExecutor,
    intentId: string,
    error: string,
  ): Promise<void> {
    await database.run(
      `UPDATE outbox_intents SET last_error = ?
       WHERE intent_id = ? AND status = 'acknowledged'
         AND reconciliation_version IS NOT NULL;`,
      [error, intentId],
    );
  }

  async completeReconciliation(
    database: SqliteExecutor,
    intentId: string,
  ): Promise<void> {
    await database.run(
      `UPDATE outbox_intents SET reconciliation_version = NULL, last_error = NULL
       WHERE intent_id = ? AND status = 'acknowledged';`,
      [intentId],
    );
    await this.acknowledge(database, intentId);
  }

  async cancelQueued(database: SqliteExecutor, intentId: string): Promise<boolean> {
    const result = await database.run(
      "DELETE FROM outbox_intents WHERE intent_id = ? AND status = 'queued';",
      [intentId],
    );
    return result.changes === 1;
  }

  async retryAttention(
    database: SqliteExecutor,
    intentId: string,
    freshIntentId: string,
    now = Date.now(),
  ): Promise<OutboxIntent | undefined> {
    const current = await this.get(database, intentId);
    if (current?.status !== 'needs_attention') return current;
    if ((await this.get(database, freshIntentId)) !== undefined) {
      throw new OutboxInvariantError(freshIntentId);
    }
    const variables = freshVariables(current.variables, freshIntentId);
    const semanticKey = outboxSemanticKey({
      intentId: freshIntentId,
      mutationKey: current.mutationKey,
      variables,
      entityId: current.entityId,
      orderingKey: current.orderingKey,
      ...(current.dependsOnIntentId === undefined
        ? {}
        : { dependsOnIntentId: current.dependsOnIntentId }),
      ...(current.compensationForIntentId === undefined
        ? {}
        : { compensationForIntentId: current.compensationForIntentId }),
    });
    const dependentRows = await database.all(
      `SELECT * FROM outbox_intents
       WHERE depends_on_intent_id = ? OR compensation_for_intent_id = ?;`,
      [intentId, intentId],
    );
    for (const row of dependentRows) {
      const dependent = intentFromRow(row);
      const dependsOnIntentId =
        dependent.dependsOnIntentId === intentId
          ? freshIntentId
          : dependent.dependsOnIntentId;
      const compensationForIntentId =
        dependent.compensationForIntentId === intentId
          ? freshIntentId
          : dependent.compensationForIntentId;
      const dependentSemanticKey = outboxSemanticKey({
        intentId: dependent.intentId,
        mutationKey: dependent.mutationKey,
        variables: dependent.variables,
        entityId: dependent.entityId,
        orderingKey: dependent.orderingKey,
        ...(dependsOnIntentId === undefined ? {} : { dependsOnIntentId }),
        ...(compensationForIntentId === undefined ? {} : { compensationForIntentId }),
      });
      await database.run(
        `UPDATE outbox_intents SET depends_on_intent_id = ?,
           compensation_for_intent_id = ?, semantic_key = ?
         WHERE intent_id = ?;`,
        [
          dependsOnIntentId ?? null,
          compensationForIntentId ?? null,
          dependentSemanticKey,
          dependent.intentId,
        ],
      );
    }
    await database.run(
      `UPDATE outbox_intents SET intent_id = ?, variables_json = ?, semantic_key = ?,
         status = 'queued', created_at = ?, attempts = 0, last_error = NULL,
         attention_kind = NULL, attention_reason = NULL, attention_status = NULL,
         attention_code = NULL, attention_details_json = NULL
       WHERE intent_id = ? AND status = 'needs_attention';`,
      [freshIntentId, JSON.stringify(variables), semanticKey, now, intentId],
    );
    await database.run(
      `UPDATE outbox_meta SET clock_witness = MAX(clock_witness, ?)
       WHERE singleton = 1;`,
      [now],
    );
    return this.get(database, freshIntentId);
  }

  /**
   * Re-identifies one ambiguous local create and its same-entity chain atomically.
   *
   * Sequence numbers and non-root retry identities stay fixed, so FIFO and the contents of
   * later writes do not change. Every identity-bearing payload moves with entity/order keys,
   * dependency references and semantic keys; the rejected create alone receives the fresh
   * mutation identity promised by Retry.
   */
  /**
   * Re-identifies a parked create and its whole dependent chain, in one transaction.
   *
   * **Explicit only.** A parked `ambiguous_collision` is a create whose id names something the
   * caller cannot see, and re-minting it automatically would turn one confirmed create into a
   * second entity on a schedule the user never saw (§P3-05, ADR-055). This runs when they tap
   * Retry, and it moves the ids of every intent that named the old one — payload fields,
   * ordering key, dependency and compensation edges — so the chain stays intact rather than
   * being rebuilt around a stranded predecessor.
   *
   * Domain-agnostic since P3-26: `activity` and `list` differ only in which payload fields
   * name the entity and what its ordering key is prefixed with.
   */
  async retryAmbiguousCreate(
    database: SqliteExecutor,
    intentId: string,
    freshIntentId: string,
    freshEntityId: string,
    now = Date.now(),
  ): Promise<OutboxIntent | undefined> {
    const current = await this.get(database, intentId);
    if (current?.status !== 'needs_attention') return current;
    const descriptor = remapDescriptor(current.mutationKey);
    if (
      descriptor === undefined ||
      !isCreateMutation(current.mutationKey) ||
      current.attention?.kind !== 'parked' ||
      current.attention.reason !== 'ambiguous_collision'
    ) {
      throw new OutboxInvariantError(intentId);
    }
    if (
      freshEntityId === current.entityId ||
      (await this.get(database, freshIntentId)) !== undefined ||
      (await database.first(
        'SELECT intent_id FROM outbox_intents WHERE entity_id = ? LIMIT 1;',
        [freshEntityId],
      )) !== undefined
    ) {
      throw new OutboxInvariantError(freshIntentId);
    }

    const previousEntityId = current.entityId;
    const previousOrderingKey = current.orderingKey;
    const rows = (
      await database.all(
        `SELECT * FROM outbox_intents
         WHERE entity_id = ? OR depends_on_intent_id = ?
           OR compensation_for_intent_id = ?
         ORDER BY seq;`,
        [previousEntityId, intentId, intentId],
      )
    ).map(intentFromRow);

    for (const candidate of rows) {
      const root = candidate.intentId === intentId;
      const nextIntentId = root ? freshIntentId : candidate.intentId;
      const retryVariables = root
        ? freshVariables(candidate.variables, freshIntentId)
        : candidate.variables;
      const variables = remapEntityVariables(
        retryVariables,
        previousEntityId,
        freshEntityId,
        descriptor.idKeys,
      );
      const entityId =
        candidate.entityId === previousEntityId ? freshEntityId : candidate.entityId;
      const orderingKey =
        descriptor.orderingKeyPrefix !== undefined &&
        candidate.orderingKey === previousOrderingKey
          ? `${descriptor.orderingKeyPrefix}:${freshEntityId}`
          : candidate.orderingKey;
      const dependsOnIntentId =
        candidate.dependsOnIntentId === intentId
          ? freshIntentId
          : candidate.dependsOnIntentId;
      const compensationForIntentId =
        candidate.compensationForIntentId === intentId
          ? freshIntentId
          : candidate.compensationForIntentId;
      const semanticKey = outboxSemanticKey({
        intentId: nextIntentId,
        mutationKey: candidate.mutationKey,
        variables,
        entityId,
        orderingKey,
        ...(dependsOnIntentId === undefined ? {} : { dependsOnIntentId }),
        ...(compensationForIntentId === undefined ? {} : { compensationForIntentId }),
      });
      await database.run(
        `UPDATE outbox_intents SET intent_id = ?, variables_json = ?, entity_id = ?,
           ordering_key = ?, depends_on_intent_id = ?, compensation_for_intent_id = ?,
           semantic_key = ?${
             root
               ? ", status = 'queued', created_at = ?, attempts = 0, last_error = NULL, attention_kind = NULL, attention_reason = NULL, attention_status = NULL, attention_code = NULL, attention_details_json = NULL, reconciliation_version = NULL"
               : ''
}
         WHERE intent_id = ?;`,
        [
          nextIntentId,
          JSON.stringify(variables),
          entityId,
          orderingKey,
          dependsOnIntentId ?? null,
          compensationForIntentId ?? null,
          semanticKey,
          ...(root ? [now] : []),
          candidate.intentId,
        ],
      );
    }
    if (current.mutationKey[0] === 'list' && current.mutationKey[1] === 'create') {
      // The archive Undo table is keyed by list as well as by intent, so a list create that is
      // re-identified before any archive settles must not leave an offer pointing at an id
      // nothing answers to. An item create never names a list here.
      await database.run(
        'UPDATE list_archive_undo_offers SET list_id = ? WHERE list_id = ?;',
        [freshEntityId, previousEntityId],
      );
    }
    await database.run(
      `UPDATE outbox_meta SET clock_witness = MAX(clock_witness, ?)
       WHERE singleton = 1;`,
      [now],
    );
    return this.get(database, freshIntentId);
  }

  async discardAttention(database: SqliteExecutor, intentId: string): Promise<boolean> {
    const target = await this.get(database, intentId);
    if (target?.status !== 'needs_attention') return false;
    await database.run(
      `WITH RECURSIVE doomed(intent_id) AS (
         SELECT intent_id FROM outbox_intents WHERE intent_id = ?
         UNION
         SELECT child.intent_id FROM outbox_intents child
         JOIN doomed parent
           ON child.depends_on_intent_id = parent.intent_id
           OR child.compensation_for_intent_id = parent.intent_id
       )
       DELETE FROM outbox_intents WHERE intent_id IN (SELECT intent_id FROM doomed);`,
      [intentId],
    );
    await database.run(
      `DELETE FROM list_archive_undo_offers
       WHERE current_intent_id = ? OR inverse_intent_id = ?;`,
      [intentId, intentId],
    );
    return true;
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
