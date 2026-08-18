import type {
  IntentAttention,
  IntentLog,
  RejectedIntentAttention,
  UndoLogResult,
} from '@/lib/intentLog';
import { getActiveIntentLog, requestActiveIntentReplay } from '@/lib/intentReplay';

export type DurableActionStatus =
  | 'refused'
  | 'queued'
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
  /** Resolves after the initial dispatch settles into durable state. */
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

const coordinating = new Set<string>();

/** Query-client lifecycle callbacks defer semantic settlement to this coordinator. */
export function isCoordinatingIntent(intentId: string): boolean {
  return coordinating.has(intentId);
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

async function dispatchDurable(
  action: ObservableDurableAction,
  options: CoordinateDurableActionOptions,
  log: IntentLog | undefined,
): Promise<void> {
  const { intent } = options;
  if (log !== undefined) {
    const claimed = await log.tryClaim(intent.intentId);
    if (claimed === undefined) {
      const stored = log
        .snapshot()
        .intents.find((candidate) => candidate.intentId === intent.intentId);
      if (stored?.status === 'queued' && stored.dependsOnIntentId !== undefined) {
        action.update({ intentId: intent.intentId, status: 'queued' });
        action.settleAttempt();
        return;
      }
      if (stored === undefined && action.snapshot().status === 'acknowledged') {
        action.settleAttempt();
        return;
      }
      action.update({ intentId: intent.intentId, status: 'refused' });
      options.rollback();
      options.restorePosition?.();
      action.settleAttempt();
      return;
    }
  }
  action.update({ intentId: intent.intentId, status: 'in_flight' });
  coordinating.add(intent.intentId);
  try {
    await options.dispatch();
    await log?.acknowledge(intent.intentId);
    action.update({ intentId: intent.intentId, status: 'acknowledged' });
  } catch (error) {
    const attention = rejection(error);
    const lastError = errorMessage(error);
    if (attention === undefined && log !== undefined) {
      await log.requeue(intent.intentId, lastError);
      action.update({ intentId: intent.intentId, status: 'queued', lastError });
      requestActiveIntentReplay('transient');
    } else if (attention !== undefined) {
      const { kind: _kind, ...details } = attention;
      await log?.fail(intent.intentId, lastError, details);
      options.rollback();
      options.restorePosition?.();
      action.update({
        intentId: intent.intentId,
        status: 'needs_attention',
        attention,
        lastError,
      });
    } else {
      options.rollback();
      options.restorePosition?.();
      action.update({ intentId: intent.intentId, status: 'refused', lastError });
    }
  } finally {
    coordinating.delete(intent.intentId);
    action.settleAttempt();
  }
}

/**
 * Accepts, projects and starts one action in write-ahead order.
 *
 * The returned promise resolves after append + projection, not after HTTP. Callers observe
 * `attempt` for the first dispatch outcome and never reinterpret its rejected promise.
 */
export async function coordinateDurableAction(
  options: CoordinateDurableActionOptions,
): Promise<DurableAction> {
  const log = getActiveIntentLog();
  if (log !== undefined) {
    try {
      await log.append(options.intent);
    } catch (error) {
      options.rollback();
      options.restorePosition?.();
      return terminalAction({
        intentId: options.intent.intentId,
        status: 'refused',
        lastError: errorMessage(error),
      });
    }
  }

  let action!: ObservableDurableAction;
  const undo = async (): Promise<DurableAction> => {
    options.revert();
    options.restorePosition?.();
    if (log !== undefined && options.inverse !== undefined) {
      let undoResult: UndoLogResult;
      try {
        undoResult = await log.undo(
          options.intent.intentId,
          options.inverse.intent,
          action.snapshot().status === 'acknowledged' ? options.intent : undefined,
        );
      } catch (error) {
        options.apply();
        return terminalAction({
          intentId: options.inverse.intent.intentId,
          status: 'refused',
          lastError: errorMessage(error),
        });
      }
      if (undoResult.kind === 'cancelled') {
        action.update({ intentId: options.intent.intentId, status: 'acknowledged' });
        action.settleAttempt();
        return terminalAction({
          intentId: `${options.intent.intentId}:cancelled`,
          status: 'acknowledged',
        });
      }
      if (undoResult.kind === 'rejected') {
        return terminalAction({
          intentId: options.inverse.intent.intentId,
          status: 'acknowledged',
        });
      }
      if (undoResult.kind === 'missing_dependency') {
        options.apply();
        return terminalAction({
          intentId: options.inverse.intent.intentId,
          status: 'needs_attention',
          attention: { kind: 'parked', reason: 'legacy_unknown' },
          lastError: 'The original action receipt is missing.',
        });
      }

      const outcome = await action.attempt;
      if (
        outcome.status === 'needs_attention' &&
        outcome.attention?.kind === 'rejected'
      ) {
        return terminalAction({
          intentId: options.inverse.intent.intentId,
          status: 'acknowledged',
        });
      }
      if (outcome.status !== 'acknowledged') {
        return terminalAction({
          intentId: options.inverse.intent.intentId,
          status: 'queued',
        });
      }
      return coordinateDurableAction({
        intent: {
          ...options.inverse.intent,
          dependsOnIntentId: options.intent.intentId,
          compensationForIntentId: options.intent.intentId,
        },
        apply: () => undefined,
        revert: options.apply,
        rollback: options.apply,
        ...(options.restorePosition === undefined
          ? {}
          : { restorePosition: options.restorePosition }),
        dispatch: options.inverse.dispatch,
      });
    }

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
    {
      intentId: options.intent.intentId,
      status: log === undefined ? 'in_flight' : 'queued',
    },
    undo,
  );
  options.apply();
  void dispatchDurable(action, options, log);
  return action;
}
