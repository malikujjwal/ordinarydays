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
    state: 'open',
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
      state: 'done',
      features: { place: { label: 'Philadelphia' } },
      sourceActivityId: 'act_01J0000000000000000000000A',
      sourceLabel: 'Chicken tacos',
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
        items.installAcknowledged(transaction, canonical),
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

  /**
   * The caller's viewer pair (P3-35): page truth installs and clears it, item truth preserves
   * it. The asymmetry is the whole design — a patch acknowledgement says nothing about the
   * caller's link, and a page entry with no pair **is** a cleared pointer.
   */
  describe('the viewer plan pair', () => {
    const pair = {
      viewerLink: {
        listId: LIST,
        itemId: 'itm_01J000000000000000000000AA',
        viewerUserId: 'usr_01J0000000000000000000000B',
        activityId: 'act_01J0000000000000000000000A',
        linkedAt: '2026-08-12T10:00:00.000Z',
      },
      viewerPlan: {
        type: 'event',
        status: 'scheduled',
        schedule: { date: '2026-08-15', time: '19:00', timezone: 'America/New_York' },
      },
    } as const;

    it('round-trips a page row carrying the pair', async () => {
      const stored = item('itm_01J000000000000000000000AA', 'a', { ...pair });
      await transactions.run((transaction) =>
        items.replaceFirstPage(transaction, LIST, [stored], page()),
      );
      expect((await items.read(LIST))[0]).toEqual(stored);
    });

    it('is preserved by an item acknowledgement and cleared by a bare page merge', async () => {
      const stored = item('itm_01J000000000000000000000AA', 'a', { ...pair });
      await transactions.run((transaction) =>
        items.replaceFirstPage(transaction, LIST, [stored], page('cursor-1')),
      );

      // A patch acknowledgement carries the item alone; the stored pair must survive it.
      await transactions.run((transaction) =>
        items.installAcknowledged(
          transaction,
          item('itm_01J000000000000000000000AA', 'a', { title: 'Renamed' }),
        ),
      );
      expect((await items.read(LIST))[0]).toEqual({
        ...item('itm_01J000000000000000000000AA', 'a', { title: 'Renamed' }),
        ...pair,
      });

      // A page entry with no pair is the caller's current truth: the pointer was cleared.
      await transactions.run((transaction) =>
        items.mergePage(
          transaction,
          LIST,
          [item('itm_01J000000000000000000000AA', 'a', { title: 'Renamed' })],
          page(),
        ),
      );
      expect((await items.read(LIST))[0]).toEqual(
        item('itm_01J000000000000000000000AA', 'a', { title: 'Renamed' }),
      );
    });

    it('is installed and cleared by setViewerPair, the settlement path', async () => {
      await transactions.run((transaction) =>
        items.replaceFirstPage(
          transaction,
          LIST,
          [item('itm_01J000000000000000000000AA', 'a')],
          page(),
        ),
      );

      await transactions.run((transaction) =>
        items.setViewerPair(transaction, LIST, 'itm_01J000000000000000000000AA', pair),
      );
      expect((await items.read(LIST))[0]?.viewerPlan).toEqual(pair.viewerPlan);

      await transactions.run((transaction) =>
        items.setViewerPair(
          transaction,
          LIST,
          'itm_01J000000000000000000000AA',
          undefined,
        ),
      );
      expect((await items.read(LIST))[0]?.viewerPlan).toBeUndefined();
    });
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

  /**
   * Which meal ingredient(s) a row answers for (migration 29, ADR-059 amendment,
   * 2026-09-16) — the only carrier for Option B's derived `Added` presence. `origins` is
   * item truth like `sourceActivityId`/`sourceLabel`, so it round-trips through the same
   * write path as every other item field; unlike them, a corrupt or absent column must never
   * fail the read, because "unknown" is this feature's safe default.
   */
  describe('list item origins', () => {
    it('round-trips a stored item that answers for a meal ingredient', async () => {
      const stored = item('itm_01J000000000000000000000AA', 'a', {
        origins: [
          {
            activityId: 'act_01J0000000000000000000000A',
            ingredientId: 'ing_01J0000000000000000000000B',
          },
        ],
      });

      await transactions.run((transaction) =>
        items.replaceFirstPage(transaction, LIST, [stored], page()),
      );

      expect((await items.read(LIST))[0]).toEqual(stored);
    });

    it('allows the same ingredient to originate rows on two different lists', async () => {
      const origin = [
        {
          activityId: 'act_01J0000000000000000000000A',
          ingredientId: 'ing_01J0000000000000000000000B',
        },
      ];
      await transactions.run(async (transaction) => {
        await items.replaceFirstPage(
          transaction,
          LIST,
          [item('itm_01J000000000000000000000AA', 'a', { origins: origin })],
          page(),
        );
        await items.replaceFirstPage(
          transaction,
          OTHER_LIST,
          [
            item('itm_01J000000000000000000000BB', 'a', {
              listId: OTHER_LIST,
              origins: origin,
            }),
          ],
          page(),
        );
      });

      expect((await items.read(LIST))[0]?.origins).toEqual(origin);
      expect((await items.read(OTHER_LIST))[0]?.origins).toEqual(origin);
    });

    it('has no origins on an ordinary item, not an empty array', async () => {
      await transactions.run((transaction) =>
        items.replaceFirstPage(
          transaction,
          LIST,
          [item('itm_01J000000000000000000000AA', 'a')],
          page(),
        ),
      );

      expect((await items.read(LIST))[0]?.origins).toBeUndefined();
    });

    it('tolerates a NULL origins column as absence', async () => {
      if (database === undefined) throw new Error('missing item database');
      await transactions.run((transaction) =>
        items.replaceFirstPage(
          transaction,
          LIST,
          [item('itm_01J000000000000000000000AA', 'a')],
          page(),
        ),
      );

      expect(
        await database.first(
          `SELECT source_origins_json FROM list_items WHERE item_id = 'itm_01J000000000000000000000AA';`,
        ),
      ).toEqual({ source_origins_json: null });
      expect(
        (await items.getLocal('itm_01J000000000000000000000AA'))?.origins,
      ).toBeUndefined();
    });

    it('tolerates unparsable origins JSON as absence, never a throw', async () => {
      if (database === undefined) throw new Error('missing item database');
      await transactions.run((transaction) =>
        items.replaceFirstPage(
          transaction,
          LIST,
          [item('itm_01J000000000000000000000AA', 'a')],
          page(),
        ),
      );
      await database.run(
        'UPDATE list_items SET source_origins_json = ? WHERE item_id = ?;',
        ['{not-valid-json', 'itm_01J000000000000000000000AA'],
      );

      const row = await items.getLocal('itm_01J000000000000000000000AA');
      expect(row).toEqual(
        expect.objectContaining({ itemId: 'itm_01J000000000000000000000AA' }),
      );
      expect(row?.origins).toBeUndefined();
    });

    it('tolerates a malformed origins shape as absence, never a throw', async () => {
      if (database === undefined) throw new Error('missing item database');
      await transactions.run((transaction) =>
        items.replaceFirstPage(
          transaction,
          LIST,
          [item('itm_01J000000000000000000000AA', 'a')],
          page(),
        ),
      );
      await database.run(
        'UPDATE list_items SET source_origins_json = ? WHERE item_id = ?;',
        [
          JSON.stringify([{ activityId: 'act_only_no_ingredient' }]),
          'itm_01J000000000000000000000AA',
        ],
      );

      expect(
        (await items.getLocal('itm_01J000000000000000000000AA'))?.origins,
      ).toBeUndefined();
    });
  });
});
