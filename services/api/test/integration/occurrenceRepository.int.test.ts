import { BatchGetCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Occurrence } from '@od/shared/types';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { documents, TEST_TABLE, useTestTable } from './harness.js';

useTestTable();

type Repository = typeof import('../../src/repositories/occurrenceRepository.js');
type Base = typeof import('../../src/repositories/base.js');
type Keys = typeof import('../../src/repositories/keys.js');
type Ddb = typeof import('../../src/lib/ddb.js');

let repository: Repository;
let base: Base;
let keys: Keys;
let ddbModule: Ddb;

const ACTIVITY_ID = 'act_01J8XKQ2M4N5P6R7S8T9V0W1AA';
const at = '2026-08-08T15:00:00.000Z';

beforeAll(async () => {
  repository = await import('../../src/repositories/occurrenceRepository.js');
  base = await import('../../src/repositories/base.js');
  keys = await import('../../src/repositories/keys.js');
  ddbModule = await import('../../src/lib/ddb.js');
});

const completed = (date: string): Occurrence => ({
  activityId: ACTIVITY_ID,
  date,
  status: 'completed',
  completedAt: at,
});

const stored = (value: Occurrence) => ({
  ...keys.occurrence(value.activityId, value.date),
  entity: 'Occurrence',
  ...value,
  createdAt: at,
  updatedAt: at,
  schemaVersion: 1,
});

async function seedOccurrences(values: readonly Occurrence[]): Promise<void> {
  for (let start = 0; start < values.length; start += 25) {
    await documents.send(
      new BatchWriteCommand({
        RequestItems: {
          [TEST_TABLE]: values.slice(start, start + 25).map((value) => ({
            PutRequest: { Item: stored(value) },
          })),
        },
      }),
    );
  }
}

describe('round trips and replacement', () => {
  it('preserves every field', async () => {
    const value: Occurrence = {
      activityId: ACTIVITY_ID,
      date: '2026-08-08',
      status: 'rescheduled',
      snoozedUntil: '2026-08-09T12:00:00.000Z',
      overrideTime: '08:30',
      overrideDate: '2026-08-09',
      completedAt: at,
    };

    await repository.put(value);
    await expect(repository.get(value.activityId, value.date)).resolves.toEqual(value);
  });

  it('replaces the current state for the same nominal date', async () => {
    await repository.put(completed('2026-08-08'));
    const snoozed: Occurrence = {
      activityId: ACTIVITY_ID,
      date: '2026-08-08',
      status: 'snoozed',
      snoozedUntil: '20:00',
    };
    await repository.put(snoozed);

    await expect(repository.get(ACTIVITY_ID, '2026-08-08')).resolves.toEqual(snoozed);
  });
});

describe('batch hydration', () => {
  it('chunks 250 pairs into three calls and pairs results including a miss', async () => {
    const dates = Array.from({ length: 250 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 0, 1 + index));
      return date.toISOString().slice(0, 10);
    });
    await seedOccurrences(dates.slice(0, -1).map(completed));

    const send = vi.spyOn(ddbModule.ddb, 'send');
    const rows = await repository.batchGetForPairs(
      dates.map((date) => ({ activityId: ACTIVITY_ID, date })),
    );

    expect(rows).toHaveLength(250);
    expect(rows.slice(0, -1).every((row) => row?.status === 'completed')).toBe(true);
    expect(rows.at(-1)).toBeNull();
    expect(
      send.mock.calls.filter(([command]) => command instanceof BatchGetCommand),
    ).toHaveLength(3);
    send.mockRestore();
  });

  it('retries a seeded UnprocessedKeys response against the real table', async () => {
    const value = completed('2026-08-08');
    await seedOccurrences([value]);
    const key = keys.occurrence(ACTIVITY_ID, value.date);
    const send = vi.spyOn(ddbModule.ddb, 'send');
    send.mockResolvedValueOnce({
      UnprocessedKeys: { [TEST_TABLE]: { Keys: [key] } },
    } as never);

    await expect(
      repository.batchGetForPairs([{ activityId: ACTIVITY_ID, date: value.date }]),
    ).resolves.toEqual([value]);
    expect(
      send.mock.calls.filter(([command]) => command instanceof BatchGetCommand),
    ).toHaveLength(2);
    send.mockRestore();
  });
});

describe('window, mutation isolation and count', () => {
  it('includes both window bounds', async () => {
    await seedOccurrences(
      ['2026-07-31', '2026-08-01', '2026-08-31', '2026-09-01'].map(completed),
    );
    const rows = await repository.queryWindow(ACTIVITY_ID, '2026-08-01', '2026-08-31');
    expect(rows.map((row) => row.date)).toEqual(['2026-08-01', '2026-08-31']);
  });

  it('leaves ACT#/META byte-identical', async () => {
    const meta = {
      ...keys.activityMeta(ACTIVITY_ID),
      entity: 'Activity',
      title: 'Series',
      createdAt: at,
      updatedAt: at,
      schemaVersion: 1,
    };
    await base.putItem(meta);
    const before = await base.getItem(keys.activityMeta(ACTIVITY_ID));

    await repository.put(completed('2026-08-08'));

    expect(await base.getItem(keys.activityMeta(ACTIVITY_ID))).toEqual(before);
  });

  it('delete restores absence', async () => {
    await repository.put(completed('2026-08-08'));
    await repository.delete(ACTIVITY_ID, '2026-08-08');
    await expect(repository.get(ACTIVITY_ID, '2026-08-08')).resolves.toBeNull();
  });

  it('counts completed only', async () => {
    await seedOccurrences([
      completed('2026-08-01'),
      completed('2026-08-02'),
      { activityId: ACTIVITY_ID, date: '2026-08-03', status: 'skipped' },
      {
        activityId: ACTIVITY_ID,
        date: '2026-08-04',
        status: 'snoozed',
        snoozedUntil: '20:00',
      },
    ]);
    await expect(repository.countCompleted(ACTIVITY_ID)).resolves.toBe(2);
  });
});
