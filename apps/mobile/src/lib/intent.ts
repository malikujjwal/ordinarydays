/**
 * Platform-neutral intent contracts shared by the native SQLite outbox, presentation
 * selectors, reminder projection, and the one-time legacy importer.
 *
 * This module deliberately contains no storage, replay owner, HTTP client, or TanStack
 * dependency. Native runtime authority lives in SQLite; the old AsyncStorage representation
 * is isolated in `legacyIntentLog.ts` and exists only to import supported upgrades.
 */

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
  | 'predecessor_rejected'
  | 'retry_exhausted'
  | 'legacy_unknown';

export interface ParkedIntentAttention {
  readonly kind: 'parked';
  readonly reason: ParkedIntentReason;
}

export type IntentAttention = RejectedIntentAttention | ParkedIntentAttention;

export interface Intent {
  readonly intentId: string;
  readonly ownerUserId: string;
  readonly mutationKey: readonly string[];
  readonly variables: unknown;
  readonly entityId: string;
  readonly status: IntentStatus;
  readonly createdAt: number;
  readonly seq: number;
  readonly attempts: number;
  readonly attention?: IntentAttention;
  readonly lastError?: string;
  readonly reconciliationVersion?: string;
  readonly dependsOnIntentId?: string;
  readonly compensationForIntentId?: string;
}

export interface IntentSemantic {
  readonly mutationKey: readonly string[];
  readonly variables: unknown;
  readonly entityId: string;
  readonly dependsOnIntentId?: string;
  readonly compensationForIntentId?: string;
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

function semanticKey(input: IntentSemantic): string {
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
  left: IntentSemantic,
  right: IntentSemantic,
): boolean {
  return semanticKey(left) === semanticKey(right);
}
