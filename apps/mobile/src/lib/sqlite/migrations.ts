import type { SqliteDatabase, SqliteExecutor } from '@/lib/sqlite/database';
import { numberColumn, textColumn } from '@/lib/sqlite/database';

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  apply(database: SqliteExecutor): Promise<void>;
}

export class SqliteMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqliteMigrationError';
  }
}

export const FOUNDATION_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: 'legacy-import-receipts',
    apply: (database) =>
      database.exec(`
        CREATE TABLE legacy_import_receipts (
          source_id TEXT PRIMARY KEY NOT NULL,
          source_fingerprint TEXT NOT NULL,
          imported_base_count INTEGER NOT NULL,
          imported_intent_count INTEGER NOT NULL,
          imported_dependency_count INTEGER NOT NULL,
          requires_sync INTEGER NOT NULL CHECK (requires_sync IN (0, 1)),
          imported_at TEXT NOT NULL
        );
      `),
  },
];

function validatePlan(migrations: readonly SqliteMigration[]): void {
  for (const [index, migration] of migrations.entries()) {
    const expected = index + 1;
    if (migration.version !== expected || migration.name.length === 0) {
      throw new SqliteMigrationError(
        `SQLite migrations must be contiguous from version 1; expected ${expected}.`,
      );
    }
  }
}

export async function runMigrations(
  database: SqliteDatabase,
  migrations: readonly SqliteMigration[] = FOUNDATION_MIGRATIONS,
  appliedAt: () => string = () => new Date().toISOString(),
): Promise<void> {
  validatePlan(migrations);
  await database.transaction((transaction) =>
    transaction.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `),
  );
  const appliedRows = await database.all(
    'SELECT version, name FROM schema_migrations ORDER BY version;',
  );
  for (const [index, row] of appliedRows.entries()) {
    const version = numberColumn(row, 'version');
    const name = textColumn(row, 'name');
    if (version !== index + 1) {
      throw new SqliteMigrationError(
        'Stored SQLite migration history is not contiguous.',
      );
    }
    const migration = version === undefined ? undefined : migrations[version - 1];
    if (migration === undefined || migration.name !== name) {
      throw new SqliteMigrationError(
        'Stored SQLite migration history does not match this build.',
      );
    }
  }
  for (const migration of migrations.slice(appliedRows.length)) {
    await database.transaction(async (transaction) => {
      await migration.apply(transaction);
      await transaction.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?);',
        [migration.version, migration.name, appliedAt()],
      );
    });
  }
}
