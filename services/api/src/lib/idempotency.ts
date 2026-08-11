/** Durable values shared by the HTTP boundary and transaction-owning repositories (P2-38). */

export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export interface CleanupRef {
  readonly activityId: string;
  readonly userId: string;
  readonly idempotencyKey: string;
}

export interface IdempotencyReceipt {
  readonly userId: string;
  readonly key: string;
  readonly route: string;
  readonly status: number;
  /** The successful response body, stored and replayed byte-for-byte. */
  readonly body: string;
  readonly ttl: number;
  readonly createdAt: string;
  readonly cleanupRef?: CleanupRef;
}

export type CleanupPhaseKind =
  | 'delete_reminders'
  | 'normalise_untimed_reminders'
  | 'reset_rsvp';

export interface CleanupPhase {
  readonly kind: CleanupPhaseKind;
  readonly cursor?: string;
  readonly complete: boolean;
}

export interface CleanupWork extends CleanupRef {
  readonly phases: readonly CleanupPhase[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly schemaVersion: 1;
}

/** Signals that another same-key transaction won the conditional receipt put. */
export class IdempotencyRaceError extends Error {
  constructor() {
    super('Another transaction committed this idempotency key.');
    this.name = 'IdempotencyRaceError';
  }
}

/** Error-handler-recognised retryable failure used when recovery cannot finish safely. */
export function retryableIdempotencyError(cause?: unknown): Error {
  const error = new Error('Idempotency recovery is temporarily unavailable.', { cause });
  error.name = 'RequestLimitExceeded';
  return error;
}
