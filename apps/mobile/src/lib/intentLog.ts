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

/**
 * `queued → in_flight → acknowledged`, with two states that wait on a person.
 *
 * Transient failure returns to `queued`; permanent failure is `failed`; age or an untrusted
 * clock parks an intent in `needs_confirmation`.
 */
export type IntentStatus =
  | 'queued'
  | 'in_flight'
  | 'acknowledged'
  | 'failed'
  | 'needs_confirmation';

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
  readonly lastError?: string;
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

export const INTENT_LOG_SCHEMA_VERSION = 1;
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

function isIntent(value: unknown): value is Intent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Intent>;
  return (
    typeof candidate.intentId === 'string' &&
    typeof candidate.ownerUserId === 'string' &&
    Array.isArray(candidate.mutationKey) &&
    typeof candidate.entityId === 'string' &&
    typeof candidate.status === 'string' &&
    typeof candidate.createdAt === 'number' &&
    typeof candidate.attempts === 'number'
  );
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

  const stored = Array.isArray(candidate.intents)
    ? candidate.intents.filter(isIntent)
    : [];
  /**
   * Migration is additive and never drops an intent — "migrate or surface, never silently
   * discard". A pre-`seq` row is given its position in the stored order, which is the order
   * it was appended in.
   */
  const intents = stored.map((intent, index) =>
    typeof intent.seq === 'number' && intent.seq > 0
      ? intent
      : { ...intent, seq: index + 1 },
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
    return rolledBack || implausible || tooOld
      ? { ...intent, status: 'needs_confirmation' as const }
      : intent;
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

  private notify(): void {
    for (const listener of this.listeners) listener();
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
    return this.pendingFor(entityId).find((intent) => intent.mutationKey[1] === 'create');
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
        this.notify();
        throw error;
      }
      this.notify();
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
  }): Promise<Intent> {
    return this.write((current) => {
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

  /** Success. Removed rather than retained: the server is now the record of what happened. */
  acknowledge(intentId: string): Promise<Intent | undefined> {
    return this.transition(intentId, () => undefined);
  }

  /** Transient failure returns to `queued`; the next reconnect picks it up unchanged. */
  requeue(intentId: string, error?: string): Promise<Intent | undefined> {
    return this.transition(intentId, (intent) => ({
      ...intent,
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
  park(intentId: string, reason: string): Promise<Intent | undefined> {
    return this.transition(intentId, (intent) => ({
      ...intent,
      status: 'needs_confirmation',
      lastError: reason,
    }));
  }

  /** Permanent rejection. Retained until the user dismisses it — it holds their words. */
  fail(intentId: string, error: string): Promise<Intent | undefined> {
    return this.transition(intentId, (intent) => ({
      ...intent,
      status: 'failed',
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

  /** Explicit user discard, valid from the two states that wait on a person. */
  discard(intentId: string): Promise<Intent | undefined> {
    return this.transition(intentId, (intent) =>
      intent.status === 'failed' || intent.status === 'needs_confirmation'
        ? undefined
        : intent,
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
