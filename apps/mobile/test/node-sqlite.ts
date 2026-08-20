import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  SqliteDatabase,
  SqliteDatabaseFactory,
  SqliteExecutor,
  SqliteParameters,
  SqliteReader,
  SqliteRow,
  SqliteRunResult,
  SqliteSnapshotConnection,
  SqliteValue,
} from '../src/lib/sqlite/database';

function toInput(value: SqliteValue): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function parameters(values: SqliteParameters | undefined): SQLInputValue[] {
  return values?.map(toInput) ?? [];
}

function isSqliteValue(value: unknown): value is SqliteValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value instanceof Uint8Array
  );
}

function row(value: unknown): SqliteRow {
  if (typeof value !== 'object' || value === null)
    throw new Error('SQLite returned a non-row.');
  const result: SqliteRow = {};
  for (const [column, child] of Object.entries(value)) {
    if (!isSqliteValue(child))
      throw new Error(`SQLite returned an unsupported ${column} value.`);
    result[column] = child;
  }
  return result;
}

function reader(database: DatabaseSync): SqliteReader {
  return {
    first: async (sql, values) => {
      const value = database.prepare(sql).get(...parameters(values));
      return value === undefined ? undefined : row(value);
    },
    all: async (sql, values) =>
      database
        .prepare(sql)
        .all(...parameters(values))
        .map(row),
  };
}

function executor(database: DatabaseSync): SqliteExecutor {
  return {
    ...reader(database),
    exec: async (sql) => database.exec(sql),
    run: async (sql, values): Promise<SqliteRunResult> => {
      const result = database.prepare(sql).run(...parameters(values));
      return {
        changes: Number(result.changes),
        lastInsertRowId: Number(result.lastInsertRowid),
      };
    },
  };
}

class NodeSqliteDatabase implements SqliteDatabase {
  private readonly executor: SqliteExecutor;
  private closed = false;

  constructor(private readonly database: DatabaseSync) {
    this.executor = executor(database);
  }

  exec(sql: string): Promise<void> {
    return this.executor.exec(sql);
  }

  run(sql: string, values?: SqliteParameters): Promise<SqliteRunResult> {
    return this.executor.run(sql, values);
  }

  first(sql: string, values?: SqliteParameters): Promise<SqliteRow | undefined> {
    return this.executor.first(sql, values);
  }

  all(sql: string, values?: SqliteParameters): Promise<readonly SqliteRow[]> {
    return this.executor.all(sql, values);
  }

  async transaction<T>(task: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const result = await task(this.executor);
      this.database.exec('COMMIT;');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  async readTransaction<T>(task: (reader: SqliteReader) => Promise<T>): Promise<T> {
    this.database.exec('BEGIN;');
    try {
      const result = await task(reader(this.database));
      this.database.exec('COMMIT;');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}

class NodeSqliteSnapshotConnection implements SqliteSnapshotConnection {
  private readonly reader: SqliteReader;
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private closed = false;

  constructor(private readonly database: DatabaseSync) {
    this.reader = reader(database);
  }

  snapshot<T>(task: (reader: SqliteReader) => Promise<T>): Promise<T> {
    if (this.closing || this.closed) {
      return Promise.reject(new Error('SQLite projection reader is closed.'));
    }
    const pending = this.tail.then(async () => {
      if (this.closing || this.closed) {
        throw new Error('SQLite projection reader is closed.');
      }
      this.database.exec('BEGIN;');
      try {
        const result = await task(this.reader);
        this.database.exec('COMMIT;');
        return result;
      } catch (error) {
        this.database.exec('ROLLBACK;');
        throw error;
      }
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
    this.database.close();
  }
}

export function createNodeSqliteFactory(directory: string): SqliteDatabaseFactory {
  const pathFor = (filename: string): string => {
    if (basename(filename) !== filename)
      throw new Error('Test database filename escaped its directory.');
    return join(directory, filename);
  };
  return {
    open: async (filename) => new NodeSqliteDatabase(new DatabaseSync(pathFor(filename))),
    openReader: async (filename) => {
      const database = new DatabaseSync(pathFor(filename), {
        readOnly: true,
        timeout: 100,
      });
      try {
        database.exec('PRAGMA query_only = ON;');
        const journalMode = database.prepare('PRAGMA journal_mode;').get() as
          | { journal_mode?: unknown }
          | undefined;
        const queryOnly = database.prepare('PRAGMA query_only;').get() as
          | { query_only?: unknown }
          | undefined;
        if (journalMode?.journal_mode !== 'wal' || Number(queryOnly?.query_only) !== 1) {
          throw new Error('SQLite projection reader configuration was not retained.');
        }
        return new NodeSqliteSnapshotConnection(database);
      } catch (error) {
        database.close();
        throw error;
      }
    },
    delete: async (filename) => {
      const path = pathFor(filename);
      await Promise.all(
        [path, `${path}-wal`, `${path}-shm`].map((target) => rm(target, { force: true })),
      );
    },
  };
}
