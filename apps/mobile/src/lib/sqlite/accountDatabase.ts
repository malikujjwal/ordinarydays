import type { SqliteDatabase, SqliteDatabaseFactory } from '@/lib/sqlite/database';
import { numberColumn, textColumn } from '@/lib/sqlite/database';
import { expoSqliteDatabaseFactory } from '@/lib/sqlite/expoDatabase';
import {
  FOUNDATION_MIGRATIONS,
  runMigrations,
  type SqliteMigration,
} from '@/lib/sqlite/migrations';
import { RepositorySubscriptions } from '@/lib/sqlite/subscriptions';
import { SerializedTransactionRunner } from '@/lib/sqlite/transaction';

const OWNER_KEY = 'owner_account_namespace';
const DATABASE_PREFIX = 'ordinarydays-native-';

export type AccountNamespaceHasher = (accountNamespace: string) => Promise<string>;

export async function sha256AccountNamespace(accountNamespace: string): Promise<string> {
  const Crypto = await import('expo-crypto');
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, accountNamespace);
}

export async function accountDatabaseFilename(
  accountNamespace: string,
  hash: AccountNamespaceHasher = sha256AccountNamespace,
): Promise<string> {
  if (accountNamespace.length === 0)
    throw new Error('An immutable account namespace is required.');
  const digest = (await hash(accountNamespace)).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest))
    throw new Error('The account namespace hash must be SHA-256.');
  return `${DATABASE_PREFIX}${digest}.sqlite`;
}

export class AccountOwnerMismatchError extends Error {
  constructor(readonly filename: string) {
    super('The native database belongs to a different account.');
    this.name = 'AccountOwnerMismatchError';
  }
}

async function configureConnection(database: SqliteDatabase): Promise<void> {
  await database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const journalMode = textColumn(
    await database.first('PRAGMA journal_mode;'),
    'journal_mode',
  );
  const foreignKeys = numberColumn(
    await database.first('PRAGMA foreign_keys;'),
    'foreign_keys',
  );
  if (journalMode?.toLowerCase() !== 'wal' || foreignKeys !== 1) {
    throw new Error('SQLite did not enable WAL and foreign keys.');
  }
}

async function assertOwner(
  database: SqliteDatabase,
  filename: string,
  accountNamespace: string,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.exec(`
      CREATE TABLE IF NOT EXISTS native_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
    `);
    const stored = textColumn(
      await transaction.first('SELECT value FROM native_metadata WHERE key = ?;', [
        OWNER_KEY,
      ]),
      'value',
    );
    if (stored !== undefined && stored !== accountNamespace) {
      throw new AccountOwnerMismatchError(filename);
    }
    if (stored === undefined) {
      await transaction.run('INSERT INTO native_metadata (key, value) VALUES (?, ?);', [
        OWNER_KEY,
        accountNamespace,
      ]);
    }
  });
}

export class AccountDatabase {
  readonly subscriptions = new RepositorySubscriptions();
  readonly transactions: SerializedTransactionRunner;

  constructor(
    readonly accountNamespace: string,
    readonly filename: string,
    readonly database: SqliteDatabase,
  ) {
    this.transactions = new SerializedTransactionRunner(database, this.subscriptions);
  }
}

export interface AccountDatabaseManagerOptions {
  readonly factory?: SqliteDatabaseFactory;
  readonly hash?: AccountNamespaceHasher;
  readonly migrations?: readonly SqliteMigration[];
}

export class AccountDatabaseManager {
  private current: AccountDatabase | undefined;
  private readonly quarantined = new Set<string>();
  private lifecycle: Promise<void> = Promise.resolve();
  private readonly factory: SqliteDatabaseFactory;
  private readonly hash: AccountNamespaceHasher;
  private readonly migrations: readonly SqliteMigration[];

  constructor(options: AccountDatabaseManagerOptions = {}) {
    this.factory = options.factory ?? expoSqliteDatabaseFactory;
    this.hash = options.hash ?? sha256AccountNamespace;
    this.migrations = options.migrations ?? FOUNDATION_MIGRATIONS;
  }

  open(accountNamespace: string): Promise<AccountDatabase> {
    return this.serial(async () => {
      if (this.current?.accountNamespace === accountNamespace) return this.current;
      await this.quarantineCurrent();
      const filename = await accountDatabaseFilename(accountNamespace, this.hash);
      const database = await this.factory.open(filename);
      try {
        await configureConnection(database);
        await assertOwner(database, filename, accountNamespace);
        await runMigrations(database, this.migrations);
      } catch (error) {
        await database.close().catch(() => undefined);
        throw error;
      }
      const opened = new AccountDatabase(accountNamespace, filename, database);
      this.quarantined.delete(filename);
      this.current = opened;
      return opened;
    });
  }

  signOut(): Promise<void> {
    return this.serial(() => this.quarantineCurrent());
  }

  purgeConfirmedAccount(accountNamespace: string): Promise<void> {
    return this.serial(async () => {
      const filename = await accountDatabaseFilename(accountNamespace, this.hash);
      if (this.current?.filename === filename) await this.quarantineCurrent();
      await this.factory.delete(filename);
      this.quarantined.delete(filename);
    });
  }

  isQuarantined(filename: string): boolean {
    return this.quarantined.has(filename);
  }

  private async quarantineCurrent(): Promise<void> {
    const current = this.current;
    if (current === undefined) return;
    this.current = undefined;
    this.quarantined.add(current.filename);
    await current.database.close();
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const pending = this.lifecycle.then(task, task);
    this.lifecycle = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}
