import type { Intent } from '@/lib/intent';
import { changesRecurrenceTopology } from '@/lib/mutationKeys';
import { type OutboxIntent, readOutboxIntents } from '@/lib/sqlite/outbox';
import type { RevisionedProjectionReader } from '@/lib/sqlite/projectionReader';
import type {
  RepositoryInvalidationMetadata,
  RepositorySubscriptions,
} from '@/lib/sqlite/subscriptions';

const EMPTY_INTENTS: readonly Intent[] = Object.freeze([]);
const COMPLETION_MUTATIONS = new Set(['complete', 'uncomplete']);
const RETRY_BASE_MS = 100;
const RETRY_MAX_MS = 2_000;

export interface OutboxPresentationSnapshot {
  readonly pending: readonly Intent[];
  readonly blocked: readonly Intent[];
}

const EMPTY_SNAPSHOT: OutboxPresentationSnapshot = Object.freeze({
  pending: EMPTY_INTENTS,
  blocked: EMPTY_INTENTS,
});

interface PendingRead {
  readonly generation: number;
  readonly requiredRevision: number | undefined;
  readonly retryCount: number;
}

interface OccurrenceSnapshot {
  readonly entityId: string;
  readonly occurrenceDate: string | undefined;
  readonly intents: readonly Intent[];
}

function completionOccurrenceDate(intent: Intent): string | undefined | null {
  if (!COMPLETION_MUTATIONS.has(intent.mutationKey[1] ?? '')) return null;
  if (typeof intent.variables !== 'object' || intent.variables === null) return null;
  const input = (intent.variables as { readonly input?: unknown }).input;
  if (typeof input !== 'object' || input === null) return null;
  const occurrenceDate = (input as { readonly occurrenceDate?: unknown }).occurrenceDate;
  return occurrenceDate === undefined
    ? undefined
    : typeof occurrenceDate === 'string'
      ? occurrenceDate
      : null;
}

function relevantToOccurrence(intent: Intent, occurrenceDate?: string): boolean {
  const intentDate = completionOccurrenceDate(intent);
  return intentDate === null || intentDate === occurrenceDate;
}

function sameItems(previous: readonly Intent[], next: readonly Intent[]): boolean {
  return (
    previous.length === next.length &&
    previous.every((intent, index) => intent === next[index])
  );
}

function stableItems(
  previous: readonly Intent[] | undefined,
  next: readonly Intent[],
): readonly Intent[] {
  if (previous !== undefined && sameItems(previous, next)) return previous;
  return next.length === 0 ? EMPTY_INTENTS : Object.freeze(next);
}

function occurrenceKey(entityId: string, occurrenceDate?: string): string {
  return JSON.stringify([entityId, occurrenceDate ?? null]);
}

/**
 * One account-session observer for presentation-only outbox state. SQLite remains authoritative:
 * this cache only normalizes committed reader snapshots for stable React subscriptions.
 */
export class OutboxPresentationStore {
  private started = false;
  private stopped = false;
  private unsubscribe: (() => void) | undefined;
  private generation = 0;
  private requiredRevision: number | undefined;
  private pendingRead: PendingRead | undefined;
  private readRunning = false;
  private readScheduled = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  private fingerprints = new Map<string, string>();
  private intentsById = new Map<string, Intent>();
  private allIntents: readonly Intent[] = EMPTY_INTENTS;
  private globalSnapshot: OutboxPresentationSnapshot = EMPTY_SNAPSHOT;
  private entitySnapshots = new Map<string, readonly Intent[]>();
  private occurrenceSnapshots = new Map<string, OccurrenceSnapshot>();

  private readonly globalListeners = new Set<() => void>();
  private readonly entityListeners = new Map<string, Set<() => void>>();
  private readonly occurrenceListeners = new Map<string, Set<() => void>>();

  constructor(
    private readonly ownerUserId: string,
    private readonly subscriptions: RepositorySubscriptions,
    private readonly projections: RevisionedProjectionReader,
  ) {}

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.unsubscribe = this.subscriptions.subscribe('outbox', (metadata) => {
      this.invalidate(metadata);
    });
    this.requestRead();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    this.pendingRead = undefined;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.globalListeners.clear();
    this.entityListeners.clear();
    this.occurrenceListeners.clear();
  }

  getSnapshot(): OutboxPresentationSnapshot {
    return this.globalSnapshot;
  }

  getEntitySnapshot(entityId: string | undefined): readonly Intent[] {
    if (entityId === undefined) return EMPTY_INTENTS;
    return this.entitySnapshots.get(entityId) ?? EMPTY_INTENTS;
  }

  getOccurrenceSnapshot(
    entityId: string | undefined,
    occurrenceDate?: string,
  ): readonly Intent[] {
    if (entityId === undefined) return EMPTY_INTENTS;
    const key = occurrenceKey(entityId, occurrenceDate);
    const current = this.occurrenceSnapshots.get(key);
    if (current !== undefined) return current.intents;
    const intents = stableItems(
      undefined,
      this.getEntitySnapshot(entityId).filter((intent) =>
        relevantToOccurrence(intent, occurrenceDate),
      ),
    );
    this.occurrenceSnapshots.set(key, { entityId, occurrenceDate, intents });
    return intents;
  }

  subscribe(listener: () => void): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  subscribeEntity(entityId: string | undefined, listener: () => void): () => void {
    if (entityId === undefined) return () => undefined;
    return this.subscribeKey(this.entityListeners, entityId, listener);
  }

  subscribeOccurrence(
    entityId: string | undefined,
    occurrenceDate: string | undefined,
    listener: () => void,
  ): () => void {
    if (entityId === undefined) return () => undefined;
    const key = occurrenceKey(entityId, occurrenceDate);
    this.getOccurrenceSnapshot(entityId, occurrenceDate);
    const release = this.subscribeKey(this.occurrenceListeners, key, listener);
    return () => {
      release();
      if (!this.occurrenceListeners.has(key)) this.occurrenceSnapshots.delete(key);
    };
  }

  private invalidate(metadata: RepositoryInvalidationMetadata): void {
    if (metadata.commitRevision !== undefined) {
      this.requiredRevision = Math.max(
        this.requiredRevision ?? 0,
        metadata.commitRevision,
      );
    }
    this.requestRead();
  }

  private requestRead(): void {
    if (this.stopped) return;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.generation += 1;
    this.pendingRead = {
      generation: this.generation,
      requiredRevision: this.requiredRevision,
      retryCount: 0,
    };
    this.scheduleRead();
  }

  private scheduleRead(): void {
    if (
      this.stopped ||
      this.readRunning ||
      this.readScheduled ||
      this.retryTimer !== undefined ||
      this.pendingRead === undefined
    ) {
      return;
    }
    this.readScheduled = true;
    queueMicrotask(() => {
      this.readScheduled = false;
      void this.drainRead();
    });
  }

  private async drainRead(): Promise<void> {
    if (this.stopped || this.readRunning) return;
    const request = this.pendingRead;
    if (request === undefined) return;
    this.pendingRead = undefined;
    this.readRunning = true;
    try {
      const snapshot = await this.projections.snapshot(readOutboxIntents);
      if (this.stopped || request.generation !== this.generation) return;
      if (
        request.requiredRevision !== undefined &&
        snapshot.commitRevision < request.requiredRevision
      ) {
        this.retry(request, 'stale');
        return;
      }
      this.apply(snapshot.data);
    } catch (error) {
      if (!this.stopped && request.generation === this.generation) {
        this.retry(request, 'failed');
        if (__DEV__) {
          console.warn('native_outbox_presentation_read_failed', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.readRunning = false;
      this.scheduleRead();
    }
  }

  private retry(request: PendingRead, reason: 'stale' | 'failed'): void {
    if (this.pendingRead !== undefined || this.stopped) return;
    const retryCount = request.retryCount + 1;
    this.pendingRead = { ...request, retryCount };
    const delayMs = Math.min(
      RETRY_BASE_MS * 2 ** Math.min(retryCount - 1, 8),
      RETRY_MAX_MS,
    );
    if (__DEV__ && reason === 'stale') {
      console.warn('native_outbox_presentation_revision_stale', {
        requiredRevision: request.requiredRevision,
        retryCount,
        delayMs,
      });
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.scheduleRead();
    }, delayMs);
  }

  private apply(rows: readonly OutboxIntent[]): void {
    const previousGlobal = this.globalSnapshot;
    const previousEntities = this.entitySnapshots;
    const previousOccurrences = this.occurrenceSnapshots;
    const nextFingerprints = new Map<string, string>();
    const nextById = new Map<string, Intent>();
    const decoded = rows.map((row) => {
      const fingerprint = JSON.stringify(row);
      nextFingerprints.set(row.intentId, fingerprint);
      const previous =
        this.fingerprints.get(row.intentId) === fingerprint
          ? this.intentsById.get(row.intentId)
          : undefined;
      const intent: Intent = previous ?? { ...row, ownerUserId: this.ownerUserId };
      nextById.set(intent.intentId, intent);
      return intent;
    });
    const allIntents = stableItems(this.allIntents, decoded);

    const grouped = new Map<string, Intent[]>();
    for (const intent of allIntents) {
      const entity = grouped.get(intent.entityId) ?? [];
      entity.push(intent);
      grouped.set(intent.entityId, entity);
    }
    const nextEntities = new Map<string, readonly Intent[]>();
    for (const [entityId, intents] of grouped) {
      nextEntities.set(entityId, stableItems(previousEntities.get(entityId), intents));
    }

    const pending = stableItems(
      previousGlobal.pending,
      allIntents.filter((intent) => intent.status !== 'acknowledged'),
    );
    const blocked = stableItems(
      previousGlobal.blocked,
      pending.filter(
        (intent) =>
          intent.status === 'needs_attention' ||
          (intent.status === 'queued' &&
            intent.lastError !== undefined &&
            /* Compatibility for transport errors persisted before they stopped carrying UI errors. */
            intent.lastError !== 'The request could not be sent.' &&
            changesRecurrenceTopology(intent)),
      ),
    );
    const nextGlobal =
      pending === previousGlobal.pending && blocked === previousGlobal.blocked
        ? previousGlobal
        : Object.freeze({ pending, blocked });

    const nextOccurrences = new Map<string, OccurrenceSnapshot>();
    for (const [key, current] of previousOccurrences) {
      const intents = stableItems(
        current.intents,
        (nextEntities.get(current.entityId) ?? EMPTY_INTENTS).filter((intent) =>
          relevantToOccurrence(intent, current.occurrenceDate),
        ),
      );
      nextOccurrences.set(key, { ...current, intents });
    }

    this.fingerprints = nextFingerprints;
    this.intentsById = nextById;
    this.allIntents = allIntents;
    this.globalSnapshot = nextGlobal;
    this.entitySnapshots = nextEntities;
    this.occurrenceSnapshots = nextOccurrences;

    if (nextGlobal !== previousGlobal) this.publish(this.globalListeners);
    for (const key of new Set([...previousEntities.keys(), ...nextEntities.keys()])) {
      if (
        (previousEntities.get(key) ?? EMPTY_INTENTS) !==
        (nextEntities.get(key) ?? EMPTY_INTENTS)
      ) {
        this.publish(this.entityListeners.get(key));
      }
    }
    for (const [key, current] of nextOccurrences) {
      if (current.intents !== previousOccurrences.get(key)?.intents) {
        this.publish(this.occurrenceListeners.get(key));
      }
    }
  }

  private subscribeKey(
    listeners: Map<string, Set<() => void>>,
    key: string,
    listener: () => void,
  ): () => void {
    const current = listeners.get(key) ?? new Set<() => void>();
    current.add(listener);
    listeners.set(key, current);
    return () => {
      current.delete(listener);
      if (current.size === 0) listeners.delete(key);
    };
  }

  private publish(listeners: Set<() => void> | undefined): void {
    for (const listener of listeners ?? []) {
      try {
        listener();
      } catch (error) {
        if (__DEV__) {
          console.warn('native_outbox_presentation_listener_failed', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}
