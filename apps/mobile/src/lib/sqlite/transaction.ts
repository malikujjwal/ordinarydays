import {
  measureSqliteExecutor,
  type SqliteDatabase,
  type SqliteExecutionMetrics,
  type SqliteExecutor,
  type SqliteReader,
} from '@/lib/sqlite/database';
import type {
  RepositoryScope,
  RepositorySubscriptions,
} from '@/lib/sqlite/subscriptions';

export interface TransactionContext {
  readonly database: SqliteExecutor;
  changed(scope: RepositoryScope): void;
}

export type TransactionPriority = 'interactive' | 'normal';

export interface TransactionExecutionMetrics extends SqliteExecutionMetrics {
  /** Time admitted work spent waiting behind already-running or higher-priority work. */
  readonly queueWaitMs: number;
  /** Full BEGIN/task/COMMIT envelope, including JS work between SQLite calls. */
  readonly transactionMs: number;
}

interface MutableTransactionExecutionMetrics {
  queueWaitMs: number;
  transactionMs: number;
  sqlite: (() => SqliteExecutionMetrics) | undefined;
}

interface QueuedTransaction<T> {
  readonly kind: 'transaction';
  readonly task: (context: TransactionContext) => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly enqueuedAt: number;
  readonly measurement?: MutableTransactionExecutionMetrics;
}

interface QueuedRead<T> {
  readonly kind: 'read';
  readonly task: (database: SqliteReader) => Promise<T>;
  readonly notBefore: number;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

type QueuedDatabaseWork<T> = QueuedTransaction<T> | QueuedRead<T>;

export interface SqliteReadScheduler {
  read<T>(task: (database: SqliteReader) => Promise<T>, delayMs?: number): Promise<T>;
}

const MAX_INTERACTIVE_BURST = 4;
const MAX_FOREGROUND_BURST = 4;

/**
 * One process-wide queue per open account database, with notifications after commit only.
 *
 * UI writes may pass one queued sync-maintenance transaction, but normal work is admitted
 * after four interactive commits so sustained tapping cannot starve convergence.
 */
export class SerializedTransactionRunner {
  private readonly interactive: QueuedTransaction<unknown>[] = [];
  private readonly normal: QueuedTransaction<unknown>[] = [];
  private readonly background: QueuedRead<unknown>[] = [];
  private running = false;
  private interactiveBurst = 0;
  private foregroundBurst = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly subscriptions: RepositorySubscriptions,
  ) {}

  run<T>(
    task: (context: TransactionContext) => Promise<T>,
    priority: TransactionPriority = 'normal',
  ): Promise<T> {
    return this.enqueue(task, priority);
  }

  runMeasured<T>(
    task: (context: TransactionContext) => Promise<T>,
    priority: TransactionPriority = 'normal',
  ): Promise<{
    readonly value: T;
    readonly metrics: TransactionExecutionMetrics;
  }> {
    const measurement: MutableTransactionExecutionMetrics = {
      queueWaitMs: 0,
      transactionMs: 0,
      sqlite: undefined,
    };
    return this.enqueue(task, priority, measurement).then((value) => {
      const sqlite = measurement.sqlite?.() ?? { callCount: 0, durationMs: 0 };
      return {
        value,
        metrics: {
          queueWaitMs: measurement.queueWaitMs,
          transactionMs: measurement.transactionMs,
          callCount: sqlite.callCount,
          durationMs: sqlite.durationMs,
        },
      };
    });
  }

  private enqueue<T>(
    task: (context: TransactionContext) => Promise<T>,
    priority: TransactionPriority,
    measurement?: MutableTransactionExecutionMetrics,
  ): Promise<T> {
    const pending = new Promise<T>((resolve, reject) => {
      const queued: QueuedTransaction<T> = {
        kind: 'transaction',
        task,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        ...(measurement === undefined ? {} : { measurement }),
      };
      const queue = priority === 'interactive' ? this.interactive : this.normal;
      queue.push(queued as QueuedTransaction<unknown>);
    });
    this.drain();
    return pending;
  }

  /**
   * Runs an external read on the same process-wide scheduler as writes.
   *
   * A short caller-provided delay is a low-priority admission window, not a debounce: every
   * accepted read still runs. Interactive writes may pass a queued read, while an active read
   * always finishes before the next transaction starts.
   */
  read<T>(task: (database: SqliteReader) => Promise<T>, delayMs = 0): Promise<T> {
    const pending = new Promise<T>((resolve, reject) => {
      const queued: QueuedRead<T> = {
        kind: 'read',
        task,
        notBefore: Date.now() + Math.max(0, delayMs),
        resolve,
        reject,
      };
      this.background.push(queued as QueuedRead<unknown>);
    });
    this.drain();
    return pending;
  }

  private next(): QueuedDatabaseWork<unknown> | undefined {
    const backgroundReady =
      this.background[0] !== undefined && this.background[0].notBefore <= Date.now();
    if (backgroundReady && this.foregroundBurst >= MAX_FOREGROUND_BURST) {
      this.foregroundBurst = 0;
      return this.background.shift();
    }
    if (
      this.interactive.length > 0 &&
      (this.normal.length === 0 || this.interactiveBurst < MAX_INTERACTIVE_BURST)
    ) {
      this.interactiveBurst += 1;
      this.foregroundBurst += 1;
      return this.interactive.shift();
    }
    const normal = this.normal.shift();
    if (normal !== undefined) {
      this.interactiveBurst = 0;
      this.foregroundBurst += 1;
      return normal;
    }
    const interactive = this.interactive.shift();
    if (interactive !== undefined) {
      this.interactiveBurst += 1;
      this.foregroundBurst += 1;
      return interactive;
    }
    if (backgroundReady) {
      this.foregroundBurst = 0;
      return this.background.shift();
    }
    return undefined;
  }

  private drain(): void {
    if (this.running) return;
    const queued = this.next();
    if (queued === undefined) {
      if (
        this.interactive.length === 0 &&
        this.normal.length === 0 &&
        this.background.length === 0
      ) {
        this.interactiveBurst = 0;
        this.foregroundBurst = 0;
        this.clearWakeTimer();
      } else {
        this.scheduleBackgroundWake();
      }
      return;
    }
    this.clearWakeTimer();
    this.running = true;
    const finish = () => {
      this.running = false;
      this.drain();
    };
    if (queued.kind === 'read') {
      let execution: Promise<unknown>;
      try {
        execution = queued.task(this.database);
      } catch (error) {
        queued.reject(error);
        finish();
        return;
      }
      void execution.then(queued.resolve, queued.reject).then(finish, finish);
      return;
    }
    const changedScopes = new Set<RepositoryScope>();
    const transactionStartedAt = Date.now();
    if (queued.measurement !== undefined) {
      queued.measurement.queueWaitMs = transactionStartedAt - queued.enqueuedAt;
    }
    let execution: Promise<unknown>;
    try {
      execution = this.database.transaction((transaction) => {
        const measured =
          queued.measurement === undefined
            ? undefined
            : measureSqliteExecutor(transaction);
        if (queued.measurement !== undefined) {
          queued.measurement.sqlite = measured?.metrics;
        }
        return queued.task({
          database: measured?.executor ?? transaction,
          changed: (scope) => changedScopes.add(scope),
        });
      });
    } catch (error) {
      queued.reject(error);
      finish();
      return;
    }
    void execution
      .then(
        (result) => {
          if (queued.measurement !== undefined) {
            queued.measurement.transactionMs = Date.now() - transactionStartedAt;
          }
          try {
            this.subscriptions.publish(changedScopes);
            queued.resolve(result);
          } catch (error) {
            queued.reject(error);
          }
        },
        (error) => {
          if (queued.measurement !== undefined) {
            queued.measurement.transactionMs = Date.now() - transactionStartedAt;
          }
          queued.reject(error);
        },
      )
      .then(finish, finish);
  }

  private scheduleBackgroundWake(): void {
    const next = this.background[0];
    if (next === undefined || this.wakeTimer !== undefined) return;
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = undefined;
        this.drain();
      },
      Math.max(0, next.notBefore - Date.now()),
    );
  }

  private clearWakeTimer(): void {
    if (this.wakeTimer === undefined) return;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
  }
}
