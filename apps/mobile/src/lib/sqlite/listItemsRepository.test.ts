import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeSqliteFactory } from '../../../test/node-sqlite';
import type { SqliteDatabase } from './database';
import { type ListItemRow, ListItemsRepository } from './listItemsRepository';
import { FOUNDATION_MIGRATIONS, runMigrations } from './migrations';
import { RepositorySubscriptions } from './subscriptions';
import { SerializedTransactionRunner } from './transaction';

/**
 * The item slice (P3-27, ADR-057).
 *
 * Two properties carry the screen above it: the order is `(rank, itemId)`, and a page is not a
 * list. Everything below tests one of those.
 */

const LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const OTHER_LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X3';

const item = (itemId: string, rank: string, overrides: Partial<ListItemRow> = {}) =>
  ({
    itemId,
    listId: LIST,
    rank,
    title: `Item ${itemId.slice(-2)}`,
    checked: false,
    ...overrides,
  }) satisfies ListItemRow;

const page = (nextCursor?: string) => ({
  rankVersion: 3,
  ...(nextCursor === undefined ? {} : { nextCursor }),
  complete: nextCursor === undefined,
});

describe('the SQLite item slice', () => {
  let directory = '';
  let database: SqliteDatabase | undefined;
  let items: ListItemsRepository;
  let transactions: SerializedTransactionRunner;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ordinarydays-list-items-'));
    database = await createNodeSqliteFactory(directory).open('items.sqlite');
    await runMigrations(database, FOUNDATION_MIGRATIONS);
    const subscriptions = new RepositorySubscriptions();
    transactions = new SerializedTransactionRunner(database, subscriptions);
    items = new ListItemsRepository(database, subscriptions);
  });

  afterEach(async () => {
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * The tie-break is load-bearing, not defensive: two people adding at the same position
   * produce equal ranks by design (§5.11.5), and `itemId` is what makes both phones agree.
   */
  it('reads back in (rank, itemId) order however the page arrived', async () => {
    await transactions.run((transaction) =>
      items.replaceFirstPage(
        transaction,
        LIST,
        [
          item('itm_01J000000000000000000000ZZ', 'b'),
          item('itm_01J000000000000000000000AA', 'a'),
          // Equal ranks, deliberately, and out of id order.
          item('itm_01J000000000000000000000CC', 'b'),
        ],
        page(),
      ),
    );

    expect((await items.read(LIST)).map((row) => row.itemId)).toEqual([
      'itm_01J000000000000000000000AA',
      'itm_01J000000000000000000000CC',
      'itm_01J000000000000000000000ZZ',
    ]);
  });

  it('keeps every stored field across the boundary', async () => {
    const stored = item('itm_01J000000000000000000000AA', 'a', {
      title: 'Zahav',
      note: 'book ahead',
      checked: true,
      location: { label: 'Philadelphia' },
      sourceActivityId: 'act_01J0000000000000000000000A',
      sourceLabel: 'Sunday dinner',
    });

    await transactions.run((transaction) =>
      items.replaceFirstPage(transaction, LIST, [stored], page()),
    );

    expect((await items.read(LIST))[0]).toEqual(stored);
  });

  it('scopes rows to their list', async () => {
    await transactions.run(async (transaction) => {
      await items.replaceFirstPage(
        transaction,
        LIST,
        [item('itm_01J000000000000000000000AA', 'a')],
        page(),
      );
      await items.replaceFirstPage(
        transaction,
        OTHER_LIST,
        [item('itm_01J000000000000000000000BB', 'a', { listId: OTHER_LIST })],
        page(),
      );
    });

    expect(await items.read(LIST)).toHaveLength(1);
  });

  describe('a page is not a list', () => {
    it('replaces on page one and merges afterwards', async () => {
      await transactions.run((transaction) =>
        items.replaceFirstPage(
          transaction,
          LIST,
          [item('itm_01J000000000000000000000AA', 'a')],
          page('cursor-1'),
        ),
      );
      await transactions.run((transaction) =>
        items.mergePage(
          transaction,
          LIST,
          [item('itm_01J000000000000000000000BB', 'b')],
          page(),
        ),
      );

      expect((await items.read(LIST)).map((row) => row.itemId)).toEqual([
        'itm_01J000000000000000000000AA',
        'itm_01J000000000000000000000BB',
      ]);
      expect(await items.pageState(LIST)).toEqual({ rankVersion: 3, complete: true });
    });

    /** Page one is the only page whose arrival proves the projection is current. */
    it('drops rows a new first page no longer contains', async () => {
      await transactions.run((transaction) =>
        items.replaceFirstPage(
          transaction,
          LIST,
          [item('itm_01J000000000000000000000AA', 'a')],
          page(),
        ),
      );
      await transactions.run((transaction) =>
        items.replaceFirstPage(
          transaction,
          LIST,
          [item('itm_01J000000000000000000000BB', 'b')],
          page(),
        ),
      );

      expect((await items.read(LIST)).map((row) => row.itemId)).toEqual([
        'itm_01J000000000000000000000BB',
      ]);
    });

    /**
     * The `503` contract's first two clauses. They are one decision and one method: the rows
     * the user is looking at stay, and every cursor goes.
     */
    it('discards every cursor while keeping the committed rows', async () => {
      await transactions.run((transaction) =>
        items.replaceFirstPage(
          transaction,
          LIST,
          [item('itm_01J000000000000000000000AA', 'a')],
          page('cursor-1'),
        ),
      );

      await transactions.run((transaction) => items.invalidatePages(transaction, LIST));

      expect(await items.read(LIST)).toHaveLength(1);
      expect(await items.pageState(LIST)).toBeUndefined();
    });

    it('reports incomplete while a cursor remains', async () => {
      await transactions.run((transaction) =>
        items.replaceFirstPage(transaction, LIST, [], page('cursor-1')),
      );

      expect(await items.pageState(LIST)).toEqual({
        rankVersion: 3,
        nextCursor: 'cursor-1',
        complete: false,
      });
    });
  });

  describe('locally created rows', () => {
    it('survives a canonical page that could not have contained it', async () => {
      const pending = item('itm_01J000000000000000000000NN', 'z', { title: 'Milk' });
      await transactions.run((transaction) =>
        items.insertPendingCreate(transaction, pending),
      );

      await transactions.run((transaction) =>
        items.replaceFirstPage(
          transaction,
          LIST,
          [item('itm_01J000000000000000000000AA', 'a')],
          page(),
          new Set([pending.itemId]),
        ),
      );

      expect((await items.read(LIST)).map((row) => row.title)).toEqual([
        'Item AA',
        'Milk',
      ]);
    });

    it('keeps its place when an explicit Retry re-identifies it', async () => {
      const pending = item('itm_01J000000000000000000000NN', 'a');
      await transactions.run((transaction) =>
        items.insertPendingCreate(transaction, pending),
      );

      await transactions.run((transaction) =>
        items.remapPendingCreate(
          transaction,
          LIST,
          pending.itemId,
          'itm_01J000000000000000000000MM',
        ),
      );

      expect(await items.read(LIST)).toEqual([
        { ...pending, itemId: 'itm_01J000000000000000000000MM' },
      ]);
    });

    it('is replaced wholesale by the server row on acknowledgement', async () => {
      const pending = item('itm_01J000000000000000000000NN', 'zzz', { title: 'Milk' });
      await transactions.run((transaction) =>
        items.insertPendingCreate(transaction, pending),
      );

      // The server allocated its own rank under its own `rankVersion`.
      const canonical = { ...pending, rank: 'm' };
      await transactions.run((transaction) =>
        items.acceptCreated(transaction, canonical),
      );

      expect(await items.read(LIST)).toEqual([canonical]);
    });
  });

  /**
   * A page whose rows name a different list would delete under one key and insert under
   * another, leaving rows nothing ever revisits. Cheap to check, and impossible to notice.
   */
  it('refuses a page whose rows belong to another list', async () => {
    await expect(
      transactions.run((transaction) =>
        items.replaceFirstPage(
          transaction,
          LIST,
          [item('itm_01J000000000000000000000BB', 'a', { listId: OTHER_LIST })],
          page(),
        ),
      ),
    ).rejects.toThrow('does not belong to this list');
  });

  it('drops a list slice whole when the list leaves', async () => {
    await transactions.run((transaction) =>
      items.replaceFirstPage(
        transaction,
        LIST,
        [item('itm_01J000000000000000000000AA', 'a')],
        page('cursor-1'),
      ),
    );

    await transactions.run((transaction) => items.removeList(transaction, LIST));

    expect(await items.read(LIST)).toEqual([]);
    expect(await items.pageState(LIST)).toBeUndefined();
  });
});
