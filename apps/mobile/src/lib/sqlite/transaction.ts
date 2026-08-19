import type { SqliteDatabase, SqliteExecutor } from '@/lib/sqlite/database';
import type {
  RepositoryScope,
  RepositorySubscriptions,
} from '@/lib/sqlite/subscriptions';

export interface TransactionContext {
  readonly database: SqliteExecutor;
  changed(scope: RepositoryScope): void;
}

/** One process-wide queue per open account database, with notifications after commit only. */
export class SerializedTransactionRunner {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly database: SqliteDatabase,
    private readonly subscriptions: RepositorySubscriptions,
  ) {}

  run<T>(task: (context: TransactionContext) => Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      const changedScopes = new Set<RepositoryScope>();
      const result = await this.database.transaction((transaction) =>
        task({
          database: transaction,
          changed: (scope) => changedScopes.add(scope),
        }),
      );
      this.subscriptions.publish(changedScopes);
      return result;
    };
    const pending = this.tail.then(execute, execute);
    this.tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}
