import { MAX_AUTOMATIC_INTENT_AGE_DAYS, MAX_OFFLINE_MUTATIONS } from '@od/shared';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  type Intent,
  type IntentAttention,
  type IntentSemantic,
  type IntentStatus,
  semanticallyIdenticalIntent,
} from '@/lib/intent';

/**
 * Migration-only reader/writer for the pre-SQLite AsyncStorage intent envelope.
 *
 * This is not a runtime queue: it has no replay, subscriptions, retry owner, or HTTP/TanStack
 * integration. Native startup uses it only to normalize supported historical envelopes,
 * merge paused legacy mutations restart-safely, import them into SQLite with receipts, and
 * purge the old key after durable proof.
 *
 * Removal milestone: delete this module only after the minimum supported native build is a
 * SQLite-authoritative build and two stable release cycles have shown no remaining legacy
 * migration source. Until then, a missing bridge could strand accepted writes on upgrade.
 */

export interface LegacyIntentLogEnvelope {
  readonly schemaVersion: number;
  readonly ownerUserId: string;
  readonly intents: readonly Intent[];
  readonly clockWitness: number;
  readonly nextSeq: number;
}

export interface LegacyIntentLogStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface LegacyIntentAppendInput extends IntentSemantic {
  readonly intentId: string;
}

export const LEGACY_INTENT_LOG_SCHEMA_VERSION = 2;
const KEY_PREFIX = 'ordinarydays-intent-log';
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_AUTOMATIC_INTENT_AGE_MS = MAX_AUTOMATIC_INTENT_AGE_DAYS * 24 * 60 * 60 * 1000;

export function legacyIntentLogKey(userId: string): string {
  return `${KEY_PREFIX}-${userId}`;
}

function emptyEnvelope(ownerUserId: string, now: number): LegacyIntentLogEnvelope {
  return {
    schemaVersion: LEGACY_INTENT_LOG_SCHEMA_VERSION,
    ownerUserId,
    intents: [],
    clockWitness: now,
    nextSeq: 1,
  };
}

export class LegacyIntentLogUnsupportedError extends Error {
  constructor(readonly storedVersion: number) {
    super(
      `Legacy intent log schema version ${storedVersion} is newer than this build understands (${LEGACY_INTENT_LOG_SCHEMA_VERSION}).`,
    );
    this.name = 'LegacyIntentLogUnsupportedError';
  }
}

export class LegacyIntentLogFullError extends Error {
  constructor() {
    super('The legacy intent source contains more writes than this build can import.');
    this.name = 'LegacyIntentLogFullError';
  }
}

export class LegacyIntentLogInvariantError extends Error {
  constructor(readonly intentId: string) {
    super(`Legacy intent id ${intentId} was reused for a different action.`);
    this.name = 'LegacyIntentLogInvariantError';
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : { variables: value };
}

function v2Attention(value: unknown): IntentAttention | undefined {
  const candidate = record(value);
  if (candidate.kind === 'rejected') {
    return {
      kind: 'rejected',
      ...(typeof candidate.status === 'number' ? { status: candidate.status } : {}),
      ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
      ...(candidate.details === undefined ? {} : { details: candidate.details }),
    };
  }
  if (
    candidate.kind === 'parked' &&
    (candidate.reason === 'clock_uncertainty' ||
      candidate.reason === 'replay_age_expired' ||
      candidate.reason === 'ambiguous_collision' ||
      candidate.reason === 'predecessor_rejected' ||
      candidate.reason === 'legacy_unknown')
  ) {
    return { kind: 'parked', reason: candidate.reason };
  }
  return undefined;
}

function migrateIntent(
  value: unknown,
  index: number,
  ownerUserId: string,
  version: number,
  now: number,
): Intent {
  const candidate = record(value);
  const legacyStatus = candidate.status;
  const attention = v2Attention(candidate.attention);
  const status: IntentStatus =
    legacyStatus === 'queued' ||
    legacyStatus === 'in_flight' ||
    legacyStatus === 'acknowledged'
      ? legacyStatus
      : 'needs_attention';
  const migratedAttention: IntentAttention | undefined =
    status !== 'needs_attention'
      ? undefined
      : (attention ??
        (version <= 1 && legacyStatus === 'failed'
          ? { kind: 'rejected' as const }
          : { kind: 'parked' as const, reason: 'legacy_unknown' as const }));
  const mutationKey = Array.isArray(candidate.mutationKey)
    ? candidate.mutationKey.map(String)
    : ['legacy', 'unknown'];
  return {
    intentId:
      typeof candidate.intentId === 'string' && candidate.intentId.length > 0
        ? candidate.intentId
        : `legacy-intent-${index + 1}`,
    ownerUserId,
    mutationKey,
    variables: Object.hasOwn(candidate, 'variables') ? candidate.variables : value,
    entityId:
      typeof candidate.entityId === 'string'
        ? candidate.entityId
        : `legacy-entity-${index + 1}`,
    status,
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : now,
    seq:
      typeof candidate.seq === 'number' && candidate.seq > 0 ? candidate.seq : index + 1,
    attempts: typeof candidate.attempts === 'number' ? candidate.attempts : 0,
    ...(migratedAttention === undefined ? {} : { attention: migratedAttention }),
    ...(typeof candidate.lastError === 'string'
      ? { lastError: candidate.lastError }
      : {}),
    ...(typeof candidate.reconciliationVersion === 'string'
      ? { reconciliationVersion: candidate.reconciliationVersion }
      : {}),
    ...(typeof candidate.dependsOnIntentId === 'string'
      ? { dependsOnIntentId: candidate.dependsOnIntentId }
      : {}),
    ...(typeof candidate.compensationForIntentId === 'string'
      ? { compensationForIntentId: candidate.compensationForIntentId }
      : {}),
  };
}

function uniqueMigratedIntents(intents: readonly Intent[]): Intent[] {
  const used = new Map<string, Intent>();
  const result: Intent[] = [];
  for (const intent of intents) {
    const existing = used.get(intent.intentId);
    if (existing === undefined) {
      used.set(intent.intentId, intent);
      result.push(intent);
      continue;
    }
    if (semanticallyIdenticalIntent(existing, intent)) continue;
    let suffix = 2;
    let repaired = `${intent.intentId}~legacy-${suffix}`;
    while (used.has(repaired)) {
      suffix += 1;
      repaired = `${intent.intentId}~legacy-${suffix}`;
    }
    const distinct = { ...intent, intentId: repaired };
    used.set(repaired, distinct);
    result.push(distinct);
  }
  return result;
}

export function parseLegacyIntentEnvelope(
  raw: unknown,
  ownerUserId: string,
  now = Date.now(),
): LegacyIntentLogEnvelope {
  if (typeof raw !== 'object' || raw === null) return emptyEnvelope(ownerUserId, now);
  const candidate = raw as Partial<LegacyIntentLogEnvelope>;
  const version =
    typeof candidate.schemaVersion === 'number' ? candidate.schemaVersion : 0;
  if (version > LEGACY_INTENT_LOG_SCHEMA_VERSION) {
    throw new LegacyIntentLogUnsupportedError(version);
  }
  const stored = Array.isArray(candidate.intents) ? candidate.intents : [];
  const intents = uniqueMigratedIntents(
    stored.map((intent, index) =>
      migrateIntent(intent, index, ownerUserId, version, now),
    ),
  );
  const maxSeq = intents.reduce((high, intent) => Math.max(high, intent.seq), 0);
  return {
    schemaVersion: LEGACY_INTENT_LOG_SCHEMA_VERSION,
    ownerUserId,
    intents,
    clockWitness:
      typeof candidate.clockWitness === 'number' ? candidate.clockWitness : now,
    nextSeq:
      typeof candidate.nextSeq === 'number' && candidate.nextSeq > maxSeq
        ? candidate.nextSeq
        : maxSeq + 1,
  };
}

function applyLegacyClockRule(
  envelope: LegacyIntentLogEnvelope,
  now: number,
): LegacyIntentLogEnvelope {
  const rolledBack = now + CLOCK_TOLERANCE_MS < envelope.clockWitness;
  return {
    ...envelope,
    intents: envelope.intents.map((intent) => {
      if (intent.status !== 'queued') return intent;
      const implausible = intent.createdAt > now + CLOCK_TOLERANCE_MS;
      const tooOld = now - intent.createdAt > MAX_AUTOMATIC_INTENT_AGE_MS;
      if (rolledBack || implausible) {
        return {
          ...intent,
          status: 'needs_attention' as const,
          attention: { kind: 'parked' as const, reason: 'clock_uncertainty' as const },
        };
      }
      if (tooOld) {
        return {
          ...intent,
          status: 'needs_attention' as const,
          attention: { kind: 'parked' as const, reason: 'replay_age_expired' as const },
        };
      }
      return intent;
    }),
    clockWitness: Math.max(envelope.clockWitness, now),
  };
}

export class LegacyIntentLog {
  private envelope: LegacyIntentLogEnvelope;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly ownerUserId: string,
    private readonly storage: LegacyIntentLogStorage = AsyncStorage,
    private readonly clock: () => number = Date.now,
  ) {
    this.envelope = emptyEnvelope(ownerUserId, clock());
  }

  snapshot(): LegacyIntentLogEnvelope {
    return this.envelope;
  }

  pending(): Intent[] {
    return this.envelope.intents.filter((intent) => intent.status !== 'acknowledged');
  }

  async hydrate(): Promise<LegacyIntentLogEnvelope> {
    const raw = await this.storage.getItem(legacyIntentLogKey(this.ownerUserId));
    if (raw === null) return this.envelope;
    const parsed: unknown = JSON.parse(raw);
    const normalized = parseLegacyIntentEnvelope(parsed, this.ownerUserId, this.clock());
    this.envelope = applyLegacyClockRule(
      {
        ...normalized,
        intents: normalized.intents.map((intent) =>
          intent.status === 'in_flight'
            ? { ...intent, status: 'queued' as const }
            : intent,
        ),
      },
      this.clock(),
    );
    await this.flush();
    return this.envelope;
  }

  appendMigrated(
    input: LegacyIntentAppendInput,
    metadata: { readonly createdAt: number; readonly attempts: number } = {
      createdAt: this.clock(),
      attempts: 0,
    },
  ): Promise<Intent> {
    return this.write((current) => {
      const existing = current.intents.find(
        (intent) => intent.intentId === input.intentId,
      );
      if (existing !== undefined) {
        if (!semanticallyIdenticalIntent(existing, input)) {
          throw new LegacyIntentLogInvariantError(input.intentId);
        }
        return [current, existing];
      }
      if (this.pending().length >= MAX_OFFLINE_MUTATIONS) {
        throw new LegacyIntentLogFullError();
      }
      const intent: Intent = {
        ...input,
        ownerUserId: this.ownerUserId,
        status: 'queued',
        createdAt: metadata.createdAt,
        seq: current.nextSeq,
        attempts: metadata.attempts,
      };
      return [
        {
          ...current,
          intents: [...current.intents, intent],
          nextSeq: current.nextSeq + 1,
          clockWitness: Math.max(current.clockWitness, intent.createdAt),
        },
        intent,
      ];
    });
  }

  async purge(): Promise<void> {
    await this.storage.removeItem(legacyIntentLogKey(this.ownerUserId));
    this.envelope = emptyEnvelope(this.ownerUserId, this.clock());
  }

  private async flush(): Promise<void> {
    await this.storage.setItem(
      legacyIntentLogKey(this.ownerUserId),
      JSON.stringify(this.envelope),
    );
  }

  private write<T>(
    mutate: (current: LegacyIntentLogEnvelope) => [LegacyIntentLogEnvelope, T],
  ): Promise<T> {
    const run = this.chain.then(async () => {
      const previous = this.envelope;
      const [next, result] = mutate(previous);
      this.envelope = next;
      try {
        await this.flush();
      } catch (error) {
        this.envelope = previous;
        throw error;
      }
      return result;
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
