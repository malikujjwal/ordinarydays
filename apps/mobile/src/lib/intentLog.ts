import { MAX_AUTOMATIC_INTENT_AGE_DAYS, MAX_OFFLINE_MUTATIONS } from '@od/shared';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The durable intent log (`tech-stack.md` §3.4 mechanism 4, ADR-055).
 *
 * ## Why this is not the query cache
 *
 * The query cache holds server responses: reconstructable, disposable, and correctly thrown
 * away by a cache-buster bump or an age check. This holds **accepted user actions the server
 * has not acknowledged**, and it is the only copy in existence. The 2026-08-13 review found
 * queued mutations living inside the cache's envelope, where three separate paths destroyed
 * them silently — the buster equality check, the seven-day `MAX_AGE` check, and a slow
 * restore that let an empty client overwrite the stored one.
 *
 * So the two stores are split: own key, own `schemaVersion`, no age expiry, and an
 * unsupported version **migrates or surfaces** rather than being discarded.
 *
 * ## Write-ahead, not replica
 *
 * `append` persists before the caller reports the action accepted and before the request is
 * attempted. A storage failure therefore surfaces as a rejected action rather than as a write
 * the user believes happened. That is the whole durability contract: if it is in the log it
 * will be attempted, and if `append` threw the user was told.
 *
 * ## Entity-generic on purpose
 *
 * Intents carry an opaque `mutationKey` and `variables`, so `act_`, `rem_` and Phase 3's
 * `itm_` all ride one mechanism. P2-57 is explicitly forbidden from modifying this file —
 * "needing to means the primitive is wrong" — which is only satisfiable if reminders already
 * fit. Same reason the `Pending` indicator is copy-parameterised rather than per-entity.
 */

/** Persisted schema v2 states. `refused` belongs only to the action coordinator. */
export type IntentStatus = 'queued' | 'in_flight' | 'acknowledged' | 'needs_attention';

export interface RejectedIntentAttention {
  readonly kind: 'rejected';
  readonly status?: number;
  readonly code?: string;
  readonly details?: unknown;
}

export type ParkedIntentReason =
  | 'clock_uncertainty'
  | 'replay_age_expired'
  | 'ambiguous_collision'
  | 'legacy_unknown';

export interface ParkedIntentAttention {
  readonly kind: 'parked';
  readonly reason: ParkedIntentReason;
}

export type IntentAttention = RejectedIntentAttention | ParkedIntentAttention;

export interface Intent {
  readonly intentId: string;
  /** Immutable owner. Replay under a different principal would misattribute the entity. */
  readonly ownerUserId: string;
  readonly mutationKey: readonly string[];
  readonly variables: unknown;
  /**
   * What this intent acts on. FIFO is promised **per entity** and deliberately not across
   * them: two edits to one activity must not reorder, but a completion on one row has no
   * ordering relationship with a create on another, and promising one would serialise the
   * whole queue behind a single failing request.
   */
  readonly entityId: string;
  readonly status: IntentStatus;
  /** Device wall clock at acceptance. Never trusted for ordering — `seq` is. */
  readonly createdAt: number;
  /** Monotonic within a log, so ordering survives a wrong or moved clock (invariant 3). */
  readonly seq: number;
  readonly attempts: number;
  /** Structured control state. Required exactly when status is `needs_attention`. */
  readonly attention?: IntentAttention;
  readonly lastError?: string;
  /** Canonical META version returned by an acknowledged recurrence PATCH. */
  readonly reconciliationVersion?: string;
  /** Causal predecessor. A missing predecessor is never interpreted as success. */
  readonly dependsOnIntentId?: string;
  /** Names the original when this intent is a durable inverse. */
  readonly compensationForIntentId?: string;
}

export interface IntentLogEnvelope {
  readonly schemaVersion: number;
  readonly ownerUserId: string;
  readonly intents: readonly Intent[];
  /**
   * The highest wall-clock value this log has ever observed.
   *
   * Clock rollback is otherwise undetectable on a device: `Date.now()` simply returns a
   * smaller number and every age computation silently becomes wrong in the direction that
   * *extends* automation. Founder decision 6 says uncertainty may only reduce it, so the
   * witness ratchets forward and a clock found behind it parks intents for confirmation.
   */
  readonly clockWitness: number;
  readonly nextSeq: number;
}

export const INTENT_LOG_SCHEMA_VERSION = 2;
const KEY_PREFIX = 'ordinarydays-intent-log';

/** Tolerance for ordinary jitter and NTP correction, below which nothing is suspected. */
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_AUTOMATIC_INTENT_AGE_MS = MAX_AUTOMATIC_INTENT_AGE_DAYS * 24 * 60 * 60 * 1000;

/** Namespaced by immutable `userId` so two accounts on one device never share a log. */
export function intentLogKey(userId: string): string {
  return `${KEY_PREFIX}-${userId}`;
}

export function emptyEnvelope(ownerUserId: string, now: number): IntentLogEnvelope {
  return {
    schemaVersion: INTENT_LOG_SCHEMA_VERSION,
    ownerUserId,
    intents: [],
    clockWitness: now,
    nextSeq: 1,
  };
}

/** Raised when a stored log cannot be understood. Never resolved by deleting the log. */
export class IntentLogUnsupportedError extends Error {
  constructor(readonly storedVersion: number) {
    super(
      `Intent log schema version ${storedVersion} is newer than this build understands (${INTENT_LOG_SCHEMA_VERSION}).`,
    );
    this.name = 'IntentLogUnsupportedError';
  }
}

/** Raised instead of accepting a write past the 200 cap (`interaction-contract.md` §5.4). */
export class IntentLogFullError extends Error {
  constructor() {
    super("You're offline and there's a lot waiting to sync.");
    this.name = 'IntentLogFullError';
  }
}

/** Same id with different semantics means corruption, never a second accepted action. */
export class IntentLogInvariantError extends Error {
  constructor(readonly intentId: string) {
    super(`Intent id ${intentId} was reused for a different durable action.`);
    this.name = 'IntentLogInvariantError';
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : { variables: value };
}

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

function semanticKey(input: {
  mutationKey: readonly string[];
  variables: unknown;
  entityId: string;
  dependsOnIntentId?: string;
  compensationForIntentId?: string;
}): string {
  return JSON.stringify(
    canonicalValue({
      mutationKey: input.mutationKey,
      variables: input.variables,
      entityId: input.entityId,
      dependsOnIntentId: input.dependsOnIntentId,
      compensationForIntentId: input.compensationForIntentId,
    }),
  );
}

export function semanticallyIdenticalIntent(
  left: Pick<
    Intent,
    | 'mutationKey'
    | 'variables'
    | 'entityId'
    | 'dependsOnIntentId'
    | 'compensationForIntentId'
  >,
  right: {
    mutationKey: readonly string[];
    variables: unknown;
    entityId: string;
    dependsOnIntentId?: string;
    compensationForIntentId?: string;
  },
): boolean {
  return semanticKey(left) === semanticKey(right);
}

function withoutAttention(intent: Intent): Omit<Intent, 'attention'> {
  const { attention: _attention, ...rest } = intent;
  return rest;
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

/** Coalesces exact legacy duplicates and deterministically repairs conflicting duplicate ids. */
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
    if (semanticKey(existing) === semanticKey(intent)) continue;
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

/**
 * Reads a stored envelope.
 *
 * An **older** version migrates forward. A **newer** one — the app was downgraded — throws so
 * the caller can surface it, because this build cannot know what a future field means and
 * guessing risks replaying a body the user never composed.
 */
export function parseEnvelope(raw: unknown, ownerUserId: string): IntentLogEnvelope {
  const now = Date.now();
  if (typeof raw !== 'object' || raw === null) return emptyEnvelope(ownerUserId, now);
  const candidate = raw as Partial<IntentLogEnvelope>;
  const version =
    typeof candidate.schemaVersion === 'number' ? candidate.schemaVersion : 0;
  if (version > INTENT_LOG_SCHEMA_VERSION) throw new IntentLogUnsupportedError(version);

  const stored = Array.isArray(candidate.intents) ? candidate.intents : [];
  /**
   * Migration is additive and never drops an intent — "migrate or surface, never silently
   * discard". A pre-`seq` row is given its position in the stored order, which is the order
   * it was appended in.
   */
  const intents = uniqueMigratedIntents(
    stored.map((intent, index) =>
      migrateIntent(intent, index, ownerUserId, version, now),
    ),
  );
  const maxSeq = intents.reduce((high, intent) => Math.max(high, intent.seq), 0);
  return {
    schemaVersion: INTENT_LOG_SCHEMA_VERSION,
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

/** Intents holding real user data, which is everything the 200-cap must count. */
export function occupiesQueue(intent: Intent): boolean {
  return intent.status !== 'acknowledged';
}

/**
 * Whether this intent may still be replayed without asking.
 *
 * Age and clock trust are the only inputs, and both can only ever move an intent *out* of
 * automation. Nothing here can extend a replay window.
 */
export function isAutomatable(
  intent: Intent,
  now: number,
  clockWitness: number,
): boolean {
  if (intent.status !== 'queued') return false;
  if (now + CLOCK_TOLERANCE_MS < clockWitness) return false;
  if (intent.createdAt > now + CLOCK_TOLERANCE_MS) return false;
  return now - intent.createdAt <= MAX_AUTOMATIC_INTENT_AGE_MS;
}

/**
 * Applies the clock rule across a whole log.
 *
 * Run on hydration and before every replay pass, so an app that sat in the background across
 * a clock change re-evaluates rather than trusting a verdict reached under the old clock.
 */
export function applyClockRule(
  envelope: IntentLogEnvelope,
  now: number,
): IntentLogEnvelope {
  const rolledBack = now + CLOCK_TOLERANCE_MS < envelope.clockWitness;
  const intents = envelope.intents.map((intent) => {
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
  });
  return {
    ...envelope,
    intents,
    // Ratchet: the witness only moves forward, so a rollback stays detectable.
    clockWitness: Math.max(envelope.clockWitness, now),
  };
}

/**
 * Replay order: by `seq` rather than `createdAt`, so a device whose clock moved cannot
 * reorder two edits to the same row (invariant 3 — chronology comes from explicit fields,
 * never from an id or a clock).
 */
export function replayOrder(intents: readonly Intent[]): Intent[] {
  return [...intents].sort((left, right) => left.seq - right.seq);
}

export interface IntentLogStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * The log for one account.
 *
 * Every mutating call goes through `write`, which serialises on a promise chain. Two intents
 * accepted in the same tick would otherwise both read the pre-write envelope and one would
 * overwrite the other — losing a write inside the component whose entire purpose is not
 * losing writes.
 */
export class IntentLog {
  private envelope: IntentLogEnvelope;
  private chain: Promise<unknown> = Promise.resolve();
  private hydrated = false;
  private readonly listeners = new Set<() => void>();
  private readonly entityListeners = new Map<string, Set<() => void>>();
  private readonly entitySnapshots = new Map<string, readonly Intent[]>();

  constructor(
    readonly ownerUserId: string,
    private readonly storage: IntentLogStorage = AsyncStorage,
    private readonly clock: () => number = Date.now,
  ) {
    this.envelope = emptyEnvelope(ownerUserId, clock());
  }

  /** The current view. Synchronous so indicators render without awaiting storage. */
  snapshot(): IntentLogEnvelope {
    return this.envelope;
  }

  /**
   * Notified after every committed change, so a `Pending` indicator tracks the queue without
   * polling it. The envelope is replaced rather than mutated on each write, which makes the
   * snapshot safe to use as a `useSyncExternalStore` value directly.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Entity-scoped subscription so one intent transition does not rerender every agenda row. */
  subscribeEntity(entityId: string, listener: () => void): () => void {
    const listeners = this.entityListeners.get(entityId) ?? new Set<() => void>();
    listeners.add(listener);
    this.entityListeners.set(entityId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.entityListeners.delete(entityId);
    };
  }

  /** Stable snapshot identity until this entity's own intents change. */
  snapshotFor(entityId: string): readonly Intent[] {
    const cached = this.entitySnapshots.get(entityId);
    if (cached !== undefined) return cached;
    const snapshot = this.envelope.intents.filter(
      (intent) => intent.entityId === entityId,
    );
    this.entitySnapshots.set(entityId, snapshot);
    return snapshot;
  }

  private notify(previous?: IntentLogEnvelope): void {
    for (const listener of this.listeners) listener();
    const entityIds = new Set([
      ...(previous?.intents.map((intent) => intent.entityId) ?? []),
      ...this.envelope.intents.map((intent) => intent.entityId),
    ]);
    for (const entityId of entityIds) {
      const before =
        previous?.intents.filter((intent) => intent.entityId === entityId) ?? [];
      const after = this.envelope.intents.filter(
        (intent) => intent.entityId === entityId,
      );
      if (
        before.length === after.length &&
        before.every((intent, index) => intent === after[index])
      ) {
        continue;
      }
      this.entitySnapshots.set(entityId, after);
      for (const listener of this.entityListeners.get(entityId) ?? []) listener();
    }
  }

  pending(): Intent[] {
    return this.envelope.intents.filter(occupiesQueue);
  }

  /** Intents for one entity, so a row can ask "am I pending?" without knowing semantics. */
  pendingFor(entityId: string): Intent[] {
    return this.pending().filter((intent) => intent.entityId === entityId);
  }

  /**
   * The unacknowledged **create** for one entity, if there is one (P2-50).
   *
   * The distinction `pendingFor` cannot make and §5.4 turns on: an entity whose *create* has
   * not landed does not exist to the server, so no server-directed action can be sent about
   * it. An entity that merely has a queued *completion* exists perfectly well and stays fully
   * usable — treating those the same would freeze a row every time a checkbox was ticked
   * offline.
   */
  pendingCreateFor(entityId: string): Intent | undefined {
    return this.pendingFor(entityId).find(
      (intent) =>
        intent.mutationKey[1] === 'create' &&
        (intent.status === 'queued' || intent.status === 'in_flight'),
    );
  }

  isHydrated(): boolean {
    return this.hydrated;
  }

  /**
   * Loads from storage and applies the clock rule.
   *
   * A read failure rethrows and leaves the in-memory envelope untouched: reporting an empty
   * log because storage hiccuped is the slow-restore bug wearing a different hat.
   */
  async hydrate(): Promise<IntentLogEnvelope> {
    const raw = await this.storage.getItem(intentLogKey(this.ownerUserId));
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      this.envelope = parseEnvelope(parsed, this.ownerUserId);
    }
    /**
     * An `in_flight` intent found on disk means the process died mid-request. It returns to
     * `queued` so the next pass picks it up — this is the case TanStack could never cover,
     * because it persisted only `isPaused` mutations and a write already on the wire was
     * simply lost. Replay is safe: the persisted `Idempotency-Key` is what stops a request the
     * server did receive from landing twice.
     */
    this.envelope = {
      ...this.envelope,
      intents: this.envelope.intents.map((intent) =>
        intent.status === 'in_flight' ? { ...intent, status: 'queued' as const } : intent,
      ),
    };
    this.hydrated = true;
    await this.refreshClockRule();
    return this.envelope;
  }

  private async flush(): Promise<void> {
    await this.storage.setItem(
      intentLogKey(this.ownerUserId),
      JSON.stringify(this.envelope),
    );
  }

  /** Serialises every envelope mutation and persists before resolving. */
  private write<T>(
    mutate: (current: IntentLogEnvelope) => [IntentLogEnvelope, T],
  ): Promise<T> {
    const run = this.chain.then(async () => {
      const previous = this.envelope;
      const [next, result] = mutate(previous);
      this.envelope = next;
      try {
        await this.flush();
      } catch (error) {
        // Roll the in-memory view back so it never claims durability it does not have.
        this.envelope = previous;
        this.notify(previous);
        throw error;
      }
      this.notify(previous);
      return result;
    });
    // The chain must not reject, or one storage failure would stall every later write.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Records an accepted action **before** it is attempted or reported accepted.
   *
   * Rejects when the queue is full or storage fails; the caller must then not tell the user
   * the action happened.
   */
  append(input: {
    intentId: string;
    mutationKey: readonly string[];
    variables: unknown;
    entityId: string;
    dependsOnIntentId?: string;
    compensationForIntentId?: string;
  }): Promise<Intent> {
    return this.write((current) => {
      const existing = current.intents.find(
        (intent) => intent.intentId === input.intentId,
      );
      if (existing !== undefined) {
        if (semanticKey(existing) !== semanticKey(input)) {
          throw new IntentLogInvariantError(input.intentId);
        }
        return [current, existing];
      }
      if (current.intents.filter(occupiesQueue).length >= MAX_OFFLINE_MUTATIONS) {
        throw new IntentLogFullError();
      }
      const intent: Intent = {
        intentId: input.intentId,
        ownerUserId: this.ownerUserId,
        mutationKey: input.mutationKey,
        variables: input.variables,
        entityId: input.entityId,
        status: 'queued',
        createdAt: this.clock(),
        seq: current.nextSeq,
        attempts: 0,
        ...(input.dependsOnIntentId === undefined
          ? {}
          : { dependsOnIntentId: input.dependsOnIntentId }),
        ...(input.compensationForIntentId === undefined
          ? {}
          : { compensationForIntentId: input.compensationForIntentId }),
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

  private transition(
    intentId: string,
    next: (intent: Intent) => Intent | undefined,
  ): Promise<Intent | undefined> {
    return this.write((current) => {
      let updated: Intent | undefined;
      const intents = current.intents.flatMap((intent) => {
        if (intent.intentId !== intentId) return [intent];
        const result = next(intent);
        if (result === undefined) return [];
        updated = result;
        return [result];
      });
      return [{ ...current, intents }, updated];
    });
  }

  /**
   * Atomically claims one queued intent for dispatch.
   *
   * This deliberately does not use `transition`: there, an `undefined` result means
   * "remove the intent", while here it means "another replay pass already owns it". Keeping
   * those meanings separate is what makes a failed claim a byte-for-byte no-op rather than
   * silent data loss.
   */
  tryClaim(intentId: string): Promise<Intent | undefined> {
    return this.write((current) => {
      const index = current.intents.findIndex((intent) => intent.intentId === intentId);
      const target = current.intents[index];
      if (index < 0 || target === undefined || target.status !== 'queued') {
        return [current, undefined];
      }
      const claimed: Intent = {
        ...target,
        status: 'in_flight',
        attempts: target.attempts + 1,
      };
      const intents = [...current.intents];
      intents[index] = claimed;
      return [{ ...current, intents }, claimed];
    });
  }

  /** Success. A later dependency step generalizes which acknowledged receipts are retained. */
  acknowledge(intentId: string): Promise<Intent | undefined> {
    return this.transition(intentId, () => undefined);
  }

  /** HTTP acknowledgement retained until a canonical recurrence projection proves the edit. */
  acknowledgeForReconciliation(
    intentId: string,
    version?: string,
  ): Promise<Intent | undefined> {
    return this.transition(intentId, (intent) => {
      const { lastError: _lastError, attention: _attention, ...retained } = intent;
      return {
        ...retained,
        status: 'acknowledged',
        ...(version === undefined ? {} : { reconciliationVersion: version }),
      };
    });
  }

  /** Records a retryable targeted-read failure without making the PATCH replayable again. */
  failReconciliation(intentId: string, error: string): Promise<Intent | undefined> {
    return this.transition(intentId, (intent) => ({
      ...intent,
      status: 'acknowledged',
      lastError: error,
    }));
  }

  /** Transient failure returns to `queued`; the next reconnect picks it up unchanged. */
  requeue(intentId: string, error?: string): Promise<Intent | undefined> {
    return this.transition(intentId, (intent) => ({
      ...withoutAttention(intent),
      status: 'queued',
      ...(error === undefined ? {} : { lastError: error }),
    }));
  }

  /**
   * Parks an intent for the user to resolve (P2-49).
   *
   * Reached when a create collided and the recovery read came back `404` — a foreign id, or
   * this one tombstoned by a delete elsewhere. Indistinguishable by design, and neither may
   * be retried automatically: a fresh id would walk past the tombstone and resurrect the
   * deletion. Only an explicit retry or discard moves it from here.
   */
  park(
    intentId: string,
    error: string,
    reason: ParkedIntentReason = 'ambiguous_collision',
  ): Promise<Intent | undefined> {
    return this.transition(intentId, (intent) => ({
      ...intent,
      status: 'needs_attention',
      attention: { kind: 'parked', reason },
      lastError: error,
    }));
  }

  /** Permanent rejection. Retained until the user dismisses it — it holds their words. */
  fail(
    intentId: string,
    error: string,
    rejection: Omit<RejectedIntentAttention, 'kind'> = {},
  ): Promise<Intent | undefined> {
    return this.transition(intentId, (intent) => ({
      ...intent,
      status: 'needs_attention',
      attention: { kind: 'rejected', ...rejection },
      lastError: error,
    }));
  }

  /**
   * Cancellation, valid in `queued` only.
   *
   * A request already on the wire cannot be retracted, so the race loser here is a no-op
   * rather than a second write: `tryClaim` and `cancel` both run through `write`, so one
   * of them observes the other's result and declines.
   */
  cancel(intentId: string): Promise<boolean> {
    return this.write((current) => {
      const target = current.intents.find((intent) => intent.intentId === intentId);
      if (target === undefined || target.status !== 'queued') return [current, false];
      return [
        {
          ...current,
          intents: current.intents.filter((intent) => intent.intentId !== intentId),
        },
        true,
      ];
    });
  }

  /** Explicit user discard, valid from structured attention. */
  discard(intentId: string): Promise<Intent | undefined> {
    return this.transition(intentId, (intent) =>
      intent.status === 'needs_attention' ? undefined : intent,
    );
  }

  /** Re-evaluates age and clock trust. Called on hydrate and before each replay pass. */
  refreshClockRule(): Promise<IntentLogEnvelope> {
    return this.write((current) => {
      const next = applyClockRule(current, this.clock());
      return [next, next];
    });
  }

  /** What a replay pass should attempt now, oldest first, automatable only. */
  replayable(): Intent[] {
    const now = this.clock();
    const { clockWitness } = this.envelope;
    return replayOrder(
      this.envelope.intents.filter((intent) => isAutomatable(intent, now, clockWitness)),
    );
  }

  /** Sign-out quarantine: forget it in memory, leave every byte on disk (`auth.md` §3.4). */
  quarantine(): void {
    this.envelope = emptyEnvelope(this.ownerUserId, this.clock());
    this.hydrated = false;
  }

  /** Account deletion only (`security-privacy.md` §3). Never called by sign-out. */
  async purge(): Promise<void> {
    await this.storage.removeItem(intentLogKey(this.ownerUserId));
    this.envelope = emptyEnvelope(this.ownerUserId, this.clock());
  }
}
