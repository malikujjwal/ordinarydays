import { describe, expect, it, vi } from 'vitest';
import type { SqliteExecutor } from './database';
import { OutboxRepository } from './outbox';

describe('OutboxRepository append hot path', () => {
  it('allocates and returns a new intent with two reads and two writes', async () => {
    const first = vi
      .fn<SqliteExecutor['first']>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ next_seq: 41, unresolved_count: 3 });
    const run = vi
      .fn<SqliteExecutor['run']>()
      .mockResolvedValue({ changes: 1, lastInsertRowId: 0 });
    const database: SqliteExecutor = {
      first,
      all: vi.fn(async () => []),
      exec: vi.fn(async () => undefined),
      run,
    };
    const outbox = new OutboxRepository(database);

    const result = await outbox.append(
      database,
      {
        intentId: 'intent-fast-append',
        mutationKey: ['activity', 'complete'],
        variables: { activityId: 'act_fast' },
        entityId: 'act_fast',
      },
      1234,
    );

    expect(first).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      kind: 'inserted',
      intent: {
        intentId: 'intent-fast-append',
        status: 'queued',
        seq: 41,
        createdAt: 1234,
        attempts: 0,
      },
    });
  });
});
