import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openDatabaseAsync: vi.fn(),
  deleteDatabaseAsync: vi.fn(),
}));

vi.mock('expo-sqlite', () => mocks);

import { expoSqliteDatabaseFactory } from '@/lib/sqlite/expoDatabase.native';

describe('Expo SQLite dedicated projection reader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens a new connection and uses serialized non-exclusive snapshots', async () => {
    const database = {
      execAsync: vi.fn(async () => undefined),
      getFirstAsync: vi.fn(async (sql: string) => {
        if (sql === 'PRAGMA journal_mode;') return { journal_mode: 'wal' };
        if (sql === 'PRAGMA query_only;') return { query_only: 1 };
        if (sql === 'PRAGMA busy_timeout;') return { timeout: 100 };
        return { value: 42 };
      }),
      getAllAsync: vi.fn(async () => []),
      withTransactionAsync: vi.fn(async (task: () => Promise<void>) => task()),
      withExclusiveTransactionAsync: vi.fn(),
      closeAsync: vi.fn(async () => undefined),
    };
    mocks.openDatabaseAsync.mockResolvedValue(database);

    const reader = await expoSqliteDatabaseFactory.openReader('account.sqlite');
    await expect(
      reader.snapshot((snapshot) => snapshot.first('SELECT 42 AS value;')),
    ).resolves.toEqual({ value: 42 });
    await reader.close();

    expect(mocks.openDatabaseAsync).toHaveBeenCalledWith('account.sqlite', {
      useNewConnection: true,
    });
    expect(database.execAsync).toHaveBeenCalledWith(
      'PRAGMA busy_timeout = 100; PRAGMA query_only = ON;',
    );
    expect(database.withTransactionAsync).toHaveBeenCalledTimes(1);
    expect(database.withExclusiveTransactionAsync).not.toHaveBeenCalled();
    expect(database.closeAsync).toHaveBeenCalledTimes(1);
  });
});
