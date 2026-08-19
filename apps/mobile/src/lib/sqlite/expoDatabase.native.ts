import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import type {
  SqliteDatabase as DatabaseContract,
  SqliteDatabaseFactory,
  SqliteExecutor,
  SqliteParameters,
  SqliteRow,
  SqliteRunResult,
} from '@/lib/sqlite/database';

function parameters(
  values: SqliteParameters | undefined,
): Array<string | number | null | boolean | Uint8Array> {
  return values === undefined ? [] : [...values];
}

function executor(database: SQLiteDatabase): SqliteExecutor {
  return {
    exec: (sql) => database.execAsync(sql),
    run: async (sql, values): Promise<SqliteRunResult> => {
      const result = await database.runAsync(sql, parameters(values));
      return { changes: result.changes, lastInsertRowId: result.lastInsertRowId };
    },
    first: async (sql, values) => {
      const row = await database.getFirstAsync<SqliteRow>(sql, parameters(values));
      return row ?? undefined;
    },
    all: (sql, values) => database.getAllAsync<SqliteRow>(sql, parameters(values)),
  };
}

class ExpoSqliteDatabase implements DatabaseContract {
  private closed = false;

  constructor(private readonly database: SQLiteDatabase) {}

  exec(sql: string): Promise<void> {
    return this.database.execAsync(sql);
  }

  async run(sql: string, values?: SqliteParameters): Promise<SqliteRunResult> {
    return executor(this.database).run(sql, values);
  }

  first(sql: string, values?: SqliteParameters): Promise<SqliteRow | undefined> {
    return executor(this.database).first(sql, values);
  }

  all(sql: string, values?: SqliteParameters): Promise<readonly SqliteRow[]> {
    return executor(this.database).all(sql, values);
  }

  async transaction<T>(task: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    let outcome: { readonly value: T } | undefined;
    await this.database.withExclusiveTransactionAsync(async (transaction) => {
      outcome = { value: await task(executor(transaction)) };
    });
    if (outcome === undefined)
      throw new Error('SQLite transaction completed without a result.');
    return outcome.value;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.database.closeAsync();
  }
}

export const expoSqliteDatabaseFactory: SqliteDatabaseFactory = {
  open: async (filename) => new ExpoSqliteDatabase(await openDatabaseAsync(filename)),
  delete: (filename) => deleteDatabaseAsync(filename),
};
