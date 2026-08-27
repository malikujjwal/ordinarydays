import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { List } from '@od/shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';
import type { SqliteDatabase } from './database';
import { ListsRepository } from './listsRepository';
import { FOUNDATION_MIGRATIONS, runMigrations } from './migrations';
import type { RevisionedProjectionReader } from './projectionReader';
import { RepositorySubscriptions } from './subscriptions';
import { SerializedTransactionRunner } from './transaction';

/**
 * The native Lists index (P3-25, ADR-057).
 *
 * What is asserted here is the half the screen cannot: that the rows survive SQLite with their
 * shape and their **order** intact, that a replacement is a replacement rather than an upsert,
 * and that a write notifies the `lists` scope so a subscription re-reads.
 */

const list = (overrides: Partial<List> = {}): List => ({
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  behaviour: 'collection',
  templateKey: 'groceries',
  title: 'Groceries',
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  capabilities: { checkable: true, supportsLocation: false },
  slot: 'groceries',
  itemCount: 10,
  uncheckedCount: 3,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: '2026-08-24T09:00:00.000Z',
  lastItemActivityAt: '2026-08-25T18:30:00.000Z',
  ...overrides,
});

const withId = (id: string, overrides: Partial<List> = {}): List =>
  list({ listId: `lst_01J8XKQ2M4N5P6R7S8T9V0W${id}`, ...overrides });

describe('the native Lists SQLite index', () => {
  let directory = '';
  let database: SqliteDatabase | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ordinarydays-lists-'));
    database = await createNodeSqliteFactory(directory).open('lists.sqlite');
    await runMigrations(database, FOUNDATION_MIGRATIONS);
  });

  afterEach(async () => {
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  function harness(currentDatabase: SqliteDatabase) {
    const subscriptions = new RepositorySubscriptions();
    const transactions = new SerializedTransactionRunner(currentDatabase, subscriptions);
    const projections: RevisionedProjectionReader = {
      snapshot: <T>(task: Parameters<RevisionedProjectionReader['snapshot']>[0]) =>
        currentDatabase.readTransaction(async (reader) => ({
          data: (await task(reader)) as T,
          commitRevision: 9,
          source: 'reader' as const,
          metrics: { callCount: 3, durationMs: 1 },
        })),
    };
    const repository = new ListsRepository(currentDatabase, subscriptions, projections);
    return { repository, subscriptions, transactions };
  }

  it('round-trips every field the card reads', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { repository, transactions } = harness(database);
    // No `sourceActivityId`: the column is nullable and an absent key is what a plain list has.
    const stored = list({ slot: null });

    await transactions.run((transaction) =>
      repository.replaceCanonical(transaction, [stored]),
    );

    const [read] = await repository.read();
    // Parsed back through `listView`, so this is the shape the renderer will actually get —
    // including `lastItemActivityAt`, which the card renders instead of `updatedAt` (P3-46).
    expect(read).toEqual(stored);
  });

  /**
   * Server pointer order, and nothing else. `ListIndex` stores no rank (ADR-042), so the only
   * faithful order is the one the pages arrived in — a repository that sorted by title would
   * be inventing one, and §3.2 makes the index explicitly non-reorderable for the same reason.
   */
  it('reads back in the order the pages arrived, not sorted', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { repository, transactions } = harness(database);
    const shuffled = [
      withId('C11', { title: 'Zebra' }),
      withId('A11', { title: 'Apple' }),
      withId('B11', { title: 'Mango' }),
    ];

    await transactions.run((transaction) =>
      repository.replaceCanonical(transaction, shuffled),
    );

    expect((await repository.read()).map((row) => row.title)).toEqual([
      'Zebra',
      'Apple',
      'Mango',
    ]);
  });

  /**
   * The reason `pullLists` drains every cursor before it writes: an upsert cannot express a
   * deletion, so a list removed on another device would survive as a row nothing revisits.
   */
  it('replaces rather than merges, so a removed list disappears', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { repository, transactions } = harness(database);

    await transactions.run((transaction) =>
      repository.replaceCanonical(transaction, [withId('A11'), withId('B11')]),
    );
    await transactions.run((transaction) =>
      repository.replaceCanonical(transaction, [withId('A11')]),
    );

    expect(await repository.read()).toHaveLength(1);
  });

  it('notifies the lists scope so a subscription re-reads', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { repository, transactions } = harness(database);
    const listener = vi.fn();
    const stop = repository.subscribe(listener);

    await transactions.run((transaction) =>
      repository.replaceCanonical(transaction, [list()]),
    );

    expect(listener).toHaveBeenCalled();
    stop();
  });

  it('serves a snapshot with the revision its subscriber waits on', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { repository, transactions } = harness(database);
    await transactions.run((transaction) =>
      repository.replaceCanonical(transaction, [list()]),
    );

    const snapshot = await repository.readSnapshot();

    expect(snapshot.commitRevision).toBe(9);
    expect(snapshot.lists).toHaveLength(1);
  });

  /**
   * Archiving changes whether the active filter shows a list; it does not move it in the
   * server's pointer order. A restore that landed somewhere else would read as the list having
   * moved on its own.
   */
  it('keeps a row in place when a settings write archives it', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { repository, transactions } = harness(database);
    const middle = withId('B11', { title: 'Middle' });
    await transactions.run((transaction) =>
      repository.replaceCanonical(transaction, [
        withId('A11', { title: 'First' }),
        middle,
        withId('C11', { title: 'Last' }),
      ]),
    );

    await transactions.run((transaction) =>
      repository.applySettings(transaction, { ...middle, archived: true }),
    );

    const rows = await repository.read();
    expect(rows.map((row) => row.title)).toEqual(['First', 'Middle', 'Last']);
    expect(rows[1]?.archived).toBe(true);
  });

  /** Without a page a list has no ordinal, and guessing one places it wrongly for ever. */
  it('ignores a settings write for a list it has never materialized', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { repository, transactions } = harness(database);

    await transactions.run((transaction) =>
      repository.applySettings(transaction, withId('Z99')),
    );

    expect(await repository.read()).toEqual([]);
  });

  it('removes a list the server confirmed deleted', async () => {
    if (database === undefined) throw new Error('test database not open');
    const { repository, transactions } = harness(database);
    const target = withId('A11');
    await transactions.run((transaction) =>
      repository.replaceCanonical(transaction, [target, withId('B11')]),
    );

    await transactions.run((transaction) =>
      repository.removeCanonical(transaction, target.listId),
    );

    expect((await repository.read()).map((row) => row.listId)).toEqual([
      withId('B11').listId,
    ]);
  });
});
