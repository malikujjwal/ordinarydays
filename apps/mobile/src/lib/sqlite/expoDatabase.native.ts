import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import type {
  SqliteDatabase as DatabaseContract,
  SqliteDatabaseFactory,
  SqliteExecutor,
  SqliteParameters,
  SqliteReader,
  SqliteRow,
  SqliteRunResult,
  SqliteSnapshotConnection,
} from '@/lib/sqlite/database';
import { numberColumn, textColumn } from '@/lib/sqlite/database';

function parameters(
  values: SqliteParameters | undefined,
): Array<string | number | null | boolean | Uint8Array> {
  return values === undefined ? [] : [...values];
}

function reader(database: SQLiteDatabase): SqliteReader {
  return {
    first: async (sql, values) => {
      const row = await database.getFirstAsync<SqliteRow>(sql, parameters(values));
      return row ?? undefined;
    },
    all: (sql, values) => database.getAllAsync<SqliteRow>(sql, parameters(values)),
  };
}

function executor(database: SQLiteDatabase): SqliteExecutor {
  return {
    ...reader(database),
    exec: (sql) => database.execAsync(sql),
    run: async (sql, values): Promise<SqliteRunResult> => {
      const result = await database.runAsync(sql, parameters(values));
      return { changes: result.changes, lastInsertRowId: result.lastInsertRowId };
    },
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

  async readTransaction<T>(task: (reader: SqliteReader) => Promise<T>): Promise<T> {
    let outcome: { readonly value: T } | undefined;
    await this.database.withTransactionAsync(async () => {
      outcome = { value: await task(reader(this.database)) };
    });
    if (outcome === undefined)
      throw new Error('SQLite read transaction completed without a result.');
    return outcome.value;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.database.closeAsync();
  }
}

class ExpoSqliteSnapshotConnection implements SqliteSnapshotConnection {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private closed = false;

  constructor(private readonly database: SQLiteDatabase) {}

  snapshot<T>(task: (reader: SqliteReader) => Promise<T>): Promise<T> {
    if (this.closing || this.closed) {
      return Promise.reject(new Error('SQLite projection reader is closed.'));
    }
    const pending = this.tail.then(async () => {
      if (this.closing || this.closed) {
        throw new Error('SQLite projection reader is closed.');
      }
      let outcome: { readonly value: T } | undefined;
      await this.database.withTransactionAsync(async () => {
        outcome = { value: await task(reader(this.database)) };
      });
      if (outcome === undefined) {
        throw new Error('SQLite projection snapshot completed without a result.');
      }
      return outcome.value;
    });
    this.tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    await this.tail;
    if (this.closed) return;
    this.closed = true;
    await this.database.closeAsync();
  }
}

const READER_BUSY_TIMEOUT_MS = 100;

async function openReader(filename: string): Promise<SqliteSnapshotConnection> {
  const database = await openDatabaseAsync(filename, { useNewConnection: true });
  try {
    await database.execAsync(
      `PRAGMA busy_timeout = ${READER_BUSY_TIMEOUT_MS}; PRAGMA query_only = ON;`,
    );
    const reader = executor(database);
    const journalMode = textColumn(
      await reader.first('PRAGMA journal_mode;'),
      'journal_mode',
    );
    const queryOnly = numberColumn(
      await reader.first('PRAGMA query_only;'),
      'query_only',
    );
    const busyTimeout = numberColumn(
      await reader.first('PRAGMA busy_timeout;'),
      'timeout',
    );
    if (
      journalMode?.toLowerCase() !== 'wal' ||
      queryOnly !== 1 ||
      busyTimeout !== READER_BUSY_TIMEOUT_MS
    ) {
      throw new Error('SQLite projection reader configuration was not retained.');
    }
    return new ExpoSqliteSnapshotConnection(database);
  } catch (error) {
    await database.closeAsync().catch(() => undefined);
    throw error;
  }
}

export const expoSqliteDatabaseFactory: SqliteDatabaseFactory = {
  open: async (filename) => new ExpoSqliteDatabase(await openDatabaseAsync(filename)),
  openReader,
  delete: (filename) => deleteDatabaseAsync(filename),
};
