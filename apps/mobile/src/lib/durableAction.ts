import type { IntentAttention, RejectedIntentAttention } from '@/lib/intent';

/** Online-first web action lifecycle. Native resolves actions through the SQLite coordinator. */
export type DurableActionStatus =
  | 'refused'
  | 'in_flight'
  | 'acknowledged'
  | 'needs_attention';

export interface DurableActionSnapshot {
  readonly intentId: string;
  readonly status: DurableActionStatus;
  readonly attention?: IntentAttention;
  readonly lastError?: string;
}

export interface DurableIntentDescriptor {
  readonly intentId: string;
  readonly mutationKey: readonly string[];
  readonly variables: unknown;
  readonly entityId: string;
  readonly dependsOnIntentId?: string;
  readonly compensationForIntentId?: string;
}

export interface DurableAction {
  snapshot(): DurableActionSnapshot;
  subscribe(listener: () => void): () => void;
  readonly attempt: Promise<DurableActionSnapshot>;
  undo(): Promise<DurableAction>;
}

export interface CoordinateDurableActionOptions {
  readonly intent: DurableIntentDescriptor;
  readonly apply: () => void;
  readonly revert: () => void;
  readonly rollback: () => void;
  readonly restorePosition?: () => void;
  readonly dispatch: () => Promise<unknown>;
  readonly inverse?: {
    readonly intent: DurableIntentDescriptor;
    readonly dispatch: () => Promise<unknown>;
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((settle) => {
      resolve = settle;
    }),
    resolve,
  };
}

class ObservableDurableAction implements DurableAction {
  private current: DurableActionSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly attemptDeferred = deferred<DurableActionSnapshot>();
  private undoPromise: Promise<DurableAction> | undefined;

  readonly attempt = this.attemptDeferred.promise;

  constructor(
    initial: DurableActionSnapshot,
    private readonly undoAction: () => Promise<DurableAction>,
  ) {
    this.current = initial;
  }

  snapshot(): DurableActionSnapshot {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(next: DurableActionSnapshot): void {
    this.current = next;
    for (const listener of this.listeners) listener();
  }

  settleAttempt(): void {
    this.attemptDeferred.resolve(this.current);
  }

  undo(): Promise<DurableAction> {
    this.undoPromise ??= this.undoAction();
    return this.undoPromise;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rejection(error: unknown): RejectedIntentAttention | undefined {
  const candidate = error as
    | { status?: unknown; code?: unknown; details?: unknown }
    | undefined;
  const status = candidate?.status;
  if (
    typeof status !== 'number' ||
    status < 400 ||
    status >= 500 ||
    status === 408 ||
    status === 429
  ) {
    return undefined;
  }
  return {
    kind: 'rejected',
    status,
    ...(typeof candidate?.code === 'string' ? { code: candidate.code } : {}),
    ...(candidate?.details === undefined ? {} : { details: candidate.details }),
  };
}

function terminalAction(snapshot: DurableActionSnapshot): DurableAction {
  let action!: ObservableDurableAction;
  action = new ObservableDurableAction(
    snapshot,
    async (): Promise<DurableAction> => action,
  );
  action.settleAttempt();
  return action;
}

async function dispatchOnline(
  action: ObservableDurableAction,
  options: CoordinateDurableActionOptions,
): Promise<void> {
  try {
    await options.dispatch();
    action.update({ intentId: options.intent.intentId, status: 'acknowledged' });
  } catch (error) {
    const attention = rejection(error);
    const lastError = errorMessage(error);
    options.rollback();
    options.restorePosition?.();
    action.update(
      attention === undefined
        ? { intentId: options.intent.intentId, status: 'refused', lastError }
        : {
            intentId: options.intent.intentId,
            status: 'needs_attention',
            attention,
            lastError,
          },
    );
  } finally {
    action.settleAttempt();
  }
}

/**
 * Web projects immediately and treats the HTTP result as the acceptance boundary. Native
 * never calls this adapter; its platform hooks use the transactional SQLite coordinator.
 */
export async function coordinateDurableAction(
  options: CoordinateDurableActionOptions,
): Promise<DurableAction> {
  let action!: ObservableDurableAction;
  const undo = async (): Promise<DurableAction> => {
    options.revert();
    options.restorePosition?.();
    const outcome = await action.attempt;
    if (outcome.status === 'needs_attention' || options.inverse === undefined) {
      return terminalAction(outcome);
    }
    return coordinateDurableAction({
      intent: options.inverse.intent,
      apply: () => undefined,
      revert: options.apply,
      rollback: options.apply,
      ...(options.restorePosition === undefined
        ? {}
        : { restorePosition: options.restorePosition }),
      dispatch: options.inverse.dispatch,
    });
  };
  action = new ObservableDurableAction(
    { intentId: options.intent.intentId, status: 'in_flight' },
    undo,
  );
  options.apply();
  void dispatchOnline(action, options);
  return action;
}
