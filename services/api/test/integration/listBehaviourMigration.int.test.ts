import { createHash } from 'node:crypto';
import type { List, ListBehaviourConfirmation, ListItem } from '@od/shared/types';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BehaviourMigrationWork } from '../../src/repositories/listRepository.js';
import { useTestTable } from './harness.js';

useTestTable();

/**
 * The behaviour migration (§P3-09, `data-model.md` §7 "Change List behaviour"), end to end
 * against DynamoDB Local.
 *
 * What is proved here rather than at the route level is everything that is only true across
 * several committed transactions: that public `META` keeps the old behaviour until the last
 * one, that a paused run gates every read and mutation, that two callers converge on one
 * generation, that the version advance invalidates cursors issued before it, and that the
 * Undo record a finisher stores really names the prior behaviour and the defaults the upgrade
 * created. A command mock could only assert that its own fixture came back.
 */

type AppModule = typeof import('../../src/app.js');
type Repository = typeof import('../../src/repositories/listRepository.js');
type Base = typeof import('../../src/repositories/base.js');
type Keys = typeof import('../../src/repositories/keys.js');

let createApp: AppModule['createApp'];
let repository: Repository;
let base: Base;
let keys: Keys;

const DEV = 'usr_local_dev';
const NOW = '2026-08-24T09:00:00.000Z';

beforeAll(async () => {
  createApp = (await import('../../src/app.js')).createApp;
  repository = await import('../../src/repositories/listRepository.js');
  base = await import('../../src/repositories/base.js');
  keys = await import('../../src/repositories/keys.js');
});

const app = () => createApp();

const request = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  app().fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

async function seedList(overrides: Partial<List> = {}): Promise<List> {
  const list: List = {
    listId: repository.newListId(),
    ownerId: DEV,
    behaviour: 'collection',
    templateKey: 'checklist',
    title: 'Watch later',
    icon: 'check-square',
    emptyStateCopy: 'Add something to check off.',
    capabilities: { checkable: true, supportsLocation: false },
    slot: null,
    itemCount: 0,
    uncheckedCount: 0,
    memberCount: 1,
    rankVersion: 0,
    archived: false,
    updatedAt: NOW,
    ...overrides,
  };
  await repository.createList(DEV, list, { now: NOW });
  return list;
}

/** The dev profile `defaultLists` hangs off; `PATCH /v1/me` requires it to exist. */
async function seedProfile(): Promise<void> {
  await base.putItem({
    ...keys.userProfile(DEV),
    entity: 'User',
    userId: DEV,
    displayName: 'Dev',
    timezone: 'America/New_York',
    currency: 'USD',
    weekStartsOn: 0,
    onboardingState: 'done',
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  });
}

const accessFor = async (listId: string) => {
  const grant = await repository.getListPointer(DEV, listId);
  if (grant === undefined) throw new Error('List fixture has no access grant.');
  return grant;
};

/** Every item, straight from storage, in stored sort-key order. */
async function storedItems(listId: string): Promise<ListItem[]> {
  const prefix = keys.listItemPrefix(listId);
  const rows = await base.queryAll<Record<string, unknown>>(
    { pk: prefix.pk },
    { skPrefix: prefix.skPrefix, consistentRead: true },
  );
  return rows as unknown as ListItem[];
}

async function storedMeta(listId: string): Promise<Record<string, unknown>> {
  const row = await base.getItem<Record<string, unknown>>(keys.listMeta(listId), {
    consistentRead: true,
  });
  if (row === undefined) throw new Error('The list fixture has no META row.');
  return row;
}

/** The migration work row for one operation, straight from storage. */
async function storedWork(
  listId: string,
  operationId: string,
): Promise<Record<string, unknown> | undefined> {
  return base.getItem<Record<string, unknown>>(
    keys.listBehaviourMigration(listId, operationId),
    { consistentRead: true },
  );
}

/** The receipt an installed migration carries, so any finisher can record its answer. */
const preparedReceipt = () => ({
  userId: DEV,
  key: crypto.randomUUID(),
  route: 'POST /v1/lists/:id/behaviour',
  status: 200,
  body: '{"data":{}}',
  ttl: 2_000_000_000,
  createdAt: NOW,
});

async function addItems(listId: string, titles: readonly string[]): Promise<string[]> {
  const created: string[] = [];
  for (let from = 0; from < titles.length; from += 100) {
    const res = await request(`POST`, `/v1/lists/${listId}/items/bulk`, {
      items: titles.slice(from, from + 100).map((title) => ({ title })),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    created.push(...body.data.map((item: { itemId: string }) => item.itemId));
  }
  return created;
}

const changeBehaviour = async (
  list: List,
  behaviour: string,
  options: { confirm?: boolean; ifMatch?: string; key?: string } = {},
) => {
  const ifMatch = options.ifMatch ?? list.updatedAt;
  let confirmation: ListBehaviourConfirmation | undefined;
  if (options.confirm === true) {
    const preview = await request(
      'POST',
      `/v1/lists/${list.listId}/behaviour`,
      { behaviour },
      { 'If-Match': ifMatch },
    );
    const body = await preview.json();
    confirmation = body.confirmation as ListBehaviourConfirmation;
  }
  return request(
    'POST',
    `/v1/lists/${list.listId}/behaviour`,
    { behaviour, ...(confirmation === undefined ? {} : { confirmation }) },
    {
      'If-Match': ifMatch,
      ...(options.key === undefined ? {} : { 'Idempotency-Key': options.key }),
    },
  );
};

describe('collection → watch', () => {
  it('initialises every item and leaves titles and ranks untouched', async () => {
    const list = await seedList();
    await addItems(list.listId, ['Severance', 'Andor', 'The Bear']);
    const before = await storedItems(list.listId);

    const res = await changeBehaviour(list, 'watch', {
      ifMatch: String((await storedMeta(list.listId)).updatedAt),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.list.behaviour).toBe('watch');

    const after = await storedItems(list.listId);
    expect(after.map((item) => [item.title, item.rank])).toEqual(
      before.map((item) => [item.title, item.rank]),
    );
    expect(after.map((item) => item.details)).toEqual([
      { behaviour: 'watch', watchStatus: 'want' },
      { behaviour: 'watch', watchStatus: 'want' },
      { behaviour: 'watch', watchStatus: 'want' },
    ]);
  });

  it('advances rankVersion and clears the marker in the same transaction', async () => {
    const list = await seedList();
    await addItems(list.listId, ['Severance']);
    const before = await storedMeta(list.listId);

    const body = await (
      await changeBehaviour(list, 'watch', { ifMatch: String(before.updatedAt) })
    ).json();
    const meta = await storedMeta(list.listId);

    expect(meta.behaviour).toBe('watch');
    expect(meta.behaviourMigrationId).toBeUndefined();
    expect(meta.rankVersion).toBe(Number(before.rankVersion) + 1);
    expect(body.data.list.rankVersion).toBe(meta.rankVersion);
    // The response is the row: composed before the transaction, and identical to it.
    expect(body.data.list.updatedAt).toBe(meta.updatedAt);
  });

  /**
   * §P3-09: the inverse names the prior behaviour and **the exact default fields the upgrade
   * created**, and applies only while those fields and the affected settings are unchanged.
   * `POST /v1/lists/:id/undo` consumes it in P3-10; what this task owes is a record that
   * says the right thing, asserted where it is written.
   */
  it('records an Undo inverse naming the prior behaviour and the created defaults', async () => {
    const list = await seedList();
    const itemIds = await addItems(list.listId, ['Severance', 'Andor']);

    const key = crypto.randomUUID();
    const body = await (
      await changeBehaviour(list, 'watch', {
        key,
        ifMatch: String((await storedMeta(list.listId)).updatedAt),
      })
    ).json();

    expect(body.data.undoToken).toEqual(expect.any(String));
    expect(
      Date.parse(body.data.undoExpiresAt) - Date.parse(body.data.list.updatedAt),
    ).toBe(6000);

    /**
     * The inverse says what compensation **writes back** — here nothing, because a
     * `collection` item carries no `details` and undoing removes the attribute. The
     * precondition says what the forward change **created**, which is §P3-09's "the exact
     * default fields that operation created": if an item's `details` has moved off it, the
     * Undo is no longer applicable and P3-10 writes nothing.
     */
    const undo = await findSettingsUndo(list.listId);
    expect(undo?.kind).toBe('behaviour_upgrade');
    expect(undo?.inverse).toEqual({
      behaviour: 'collection',
      affectedItemIds: itemIds,
    });
    expect(undo?.preconditions).toEqual({
      behaviour: 'watch',
      itemDetails: { behaviour: 'watch', watchStatus: 'want' },
    });
    expect(undo?.consumed).toBe(false);
    // The token itself is never at rest in the list partition; only its hash is.
    expect(JSON.stringify(undo)).not.toContain(body.data.undoToken);
  });

  it('leaves an empty list with nothing to migrate and still flips the behaviour', async () => {
    const list = await seedList();

    const res = await changeBehaviour(list, 'watch');

    expect(res.status).toBe(200);
    expect((await storedMeta(list.listId)).behaviour).toBe('watch');
    expect(await storedItems(list.listId)).toHaveLength(0);
  });
});

/** Every settings Undo row on one list, in the order storage returns them. */
async function allSettingsUndos(listId: string): Promise<Record<string, unknown>[]> {
  const partition = keys.listPartition(listId);
  const rows = await base.queryAll<Record<string, unknown>>(
    { pk: partition.pk },
    { consistentRead: true },
  );
  return rows.filter((row) => row.entity === 'ListUndo');
}

/** The one settings Undo row a completed operation leaves behind. */
async function findSettingsUndo(
  listId: string,
): Promise<Record<string, unknown> | undefined> {
  return (await allSettingsUndos(listId))[0];
}

describe('a paused migration', () => {
  /**
   * A 500-item list, seeded once. Building it is the expensive part of this file, so the
   * tests below install their own migration over it rather than each paying for it again.
   */
  async function bigList(): Promise<{ list: List; itemIds: string[] }> {
    const list = await seedList();
    const itemIds = await addItems(
      list.listId,
      Array.from({ length: 500 }, (_, index) => `Item ${String(index).padStart(3, '0')}`),
    );
    return { list, itemIds };
  }

  async function install(
    listId: string,
    operationId: string,
  ): Promise<BehaviourMigrationWork> {
    const meta = await storedMeta(listId);
    return repository.beginBehaviourMigration(DEV, listId, await accessFor(listId), {
      operationId,
      toBehaviour: 'watch',
      toDetails: { behaviour: 'watch', watchStatus: 'want' },
      expectedUpdatedAt: String(meta.updatedAt),
      expectedItemVersion: Number(meta.itemVersion ?? 0),
      now: NOW,
      undo: { token: 'tok_paused', expiresAt: '2026-08-24T09:00:06.000Z' },
      receipt: preparedReceipt(),
      // Nothing on a `collection` carries typed fields, so this snapshot loses nothing.
      describeLoss: () => ({ itemCount: 0, fields: [] }),
    });
  }

  /**
   * Removes the gate without finishing the operation — the one thing no production path does.
   *
   * It is how the tests below get a **fresh** outstanding migration over the same 500 items:
   * each competing request drains a bounded 320 of them and is refused with work still to do,
   * so abandoning and reinstalling puts the list back into the state under test without
   * paying to seed 500 items again.
   */
  async function abandon(listId: string, operationId: string): Promise<void> {
    const meta = await storedMeta(listId);
    delete meta.behaviourMigrationId;
    await base.putItem(meta);
    await base.deleteAll([keys.listBehaviourMigration(listId, operationId)]);
  }

  /**
   * The work row carries **no** `ttl`, and that is load-bearing rather than an omission.
   * Its `META` marker has no expiry, so a work record that aged out of the replay window
   * would leave a gate nothing can drain, finish or roll back — every read and mutation on
   * the list refused for good, with no way back short of a migration script.
   */
  it('gives the work record no expiry its permanent marker does not share', async () => {
    const list = await seedList();
    await addItems(list.listId, ['Severance']);
    await install(list.listId, 'bmg_no_ttl');

    const row = await storedWork(list.listId, 'bmg_no_ttl');

    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('ttl');
    expect((await storedMeta(list.listId)).behaviourMigrationId).toBe('bmg_no_ttl');
    await abandon(list.listId, 'bmg_no_ttl');
  });

  /**
   * §P3-09's replay case, end to end: the author is told to retry, an unrelated read finishes
   * the work, and the author's key still answers with the response the operation always had —
   * Undo token included. The receipt rides on the work record precisely so the reader that
   * commits the final transaction records **this** operation's answer under **this**
   * operation's key; without it the replay finds no receipt and is then told its `If-Match`
   * conflicts, by the very write it asked for.
   */
  it('replays the original response after an unrelated read finished the migration', async () => {
    const { list } = await bigList();
    const meta = await storedMeta(list.listId);
    const key = crypto.randomUUID();

    const first = await changeBehaviour(list, 'watch', {
      key,
      ifMatch: String(meta.updatedAt),
    });
    expect(first.status).toBe(503);

    // An unrelated reader drains what is left and commits the final transaction.
    const page = await request('GET', `/v1/lists/${list.listId}?includeItems=true`);
    expect(page.status).toBe(200);
    expect((await storedMeta(list.listId)).behaviour).toBe('watch');

    const replay = await changeBehaviour(list, 'watch', {
      key,
      ifMatch: String(meta.updatedAt),
    });
    const body = await replay.json();

    expect(replay.status).toBe(200);
    expect(body.data.list.behaviour).toBe('watch');
    expect(body.data.undoToken).toEqual(expect.any(String));
    expect(body.data.undoExpiresAt).toEqual(expect.any(String));

    // And the Undo it hands back is the one whose hash the operation actually stored.
    const undo = await findSettingsUndo(list.listId);
    expect(undo?.tokenHash).toBe(
      createHash('sha256').update(String(body.data.undoToken)).digest('base64url'),
    );
  });

  /**
   * Criterion 4's first half: the install changes nothing a client can see, and no chunk
   * moves public META off `collection` or touches a title, a rank or the item count.
   */
  it('keeps public META and every item untouched until the final transaction', async () => {
    const { list } = await bigList();
    const before = await storedItems(list.listId);
    const beforeMeta = await storedMeta(list.listId);

    let work = await install(list.listId, 'bmg_paused_chunks');

    const installed = await storedMeta(list.listId);
    expect(installed.behaviour).toBe('collection');
    expect(installed.updatedAt).toBe(beforeMeta.updatedAt);
    expect(installed.rankVersion).toBe(beforeMeta.rankVersion);
    expect(work.entries).toHaveLength(500);

    let chunks = 0;
    while (work.cursor < work.entries.length) {
      work = await repository.applyBehaviourMigrationChunk(work);
      chunks += 1;

      const meta = await storedMeta(list.listId);
      expect(meta.behaviour).toBe('collection');
      expect(meta.rankVersion).toBe(beforeMeta.rankVersion);
      const during = await storedItems(list.listId);
      expect(during).toHaveLength(500);
      expect(during.map((item) => [item.title, item.rank])).toEqual(
        before.map((item) => [item.title, item.rank]),
      );
    }

    expect(chunks).toBe(Math.ceil(500 / repository.BEHAVIOUR_MIGRATION_CHUNK));

    await repository.finishBehaviourMigration(work, {});

    const meta = await storedMeta(list.listId);
    expect(meta.behaviour).toBe('watch');
    expect(meta.behaviourMigrationId).toBeUndefined();
    expect(meta.rankVersion).toBe(Number(beforeMeta.rankVersion) + 1);
    const after = await storedItems(list.listId);
    expect(after.map((item) => item.details)).toEqual(
      Array.from({ length: 500 }, () => ({ behaviour: 'watch', watchStatus: 'want' })),
    );
    expect(after.map((item) => [item.title, item.rank])).toEqual(
      before.map((item) => [item.title, item.rank]),
    );
  });

  /**
   * Criterion 4's second half: while work outlives one request's bounded drain, **every**
   * public item read and competing mutation is refused with the retryable answer and writes
   * nothing. A caller that does manage to finish the work is a different case — it is the
   * next test, and it sees one whole generation rather than a mixture.
   */
  it('refuses every competing read and mutation while work outlives one drain', async () => {
    const { list, itemIds } = await bigList();
    const target = itemIds[0];
    const competing: [string, () => Promise<Response>][] = [
      ['list detail', () => request('GET', `/v1/lists/${list.listId}?includeItems=true`)],
      ['item page', () => request('GET', `/v1/lists/${list.listId}/items`)],
      [
        'exact item read',
        () => request('GET', `/v1/lists/${list.listId}/items/${target}`),
      ],
      [
        'item create',
        () =>
          request('POST', `/v1/lists/${list.listId}/items`, { title: 'Mid-migration' }),
      ],
      [
        'item patch',
        () =>
          request('PATCH', `/v1/lists/${list.listId}/items/${target}`, {
            title: 'Renamed mid-migration',
          }),
      ],
      [
        'item delete',
        () => request('DELETE', `/v1/lists/${list.listId}/items/${target}`),
      ],
    ];

    const before = await storedItems(list.listId);

    for (const [index, [label, send]] of competing.entries()) {
      const operationId = `bmg_gated_${String(index)}`;
      await install(list.listId, operationId);

      const res = await send();
      expect(res.status, label).toBe(503);
      expect(res.headers.get('Retry-After'), label).toBe('1');

      const meta = await storedMeta(list.listId);
      expect(meta.behaviour, label).toBe('collection');
      const during = await storedItems(list.listId);
      expect(during, label).toHaveLength(500);
      expect(
        during.map((item) => [item.itemId, item.title, item.rank]),
        label,
      ).toEqual(before.map((item) => [item.itemId, item.title, item.rank]));

      await abandon(list.listId, operationId);
    }
  });

  /**
   * Two callers draining one operation converge on **one** target generation: the second
   * request finishes what the first started, and nobody sees a mixture on the way.
   */
  it('converges to one watch generation across two requests', async () => {
    const { list } = await bigList();
    const meta = await storedMeta(list.listId);
    const key = crypto.randomUUID();

    const first = await changeBehaviour(list, 'watch', {
      key,
      ifMatch: String(meta.updatedAt),
    });
    expect(first.status).toBe(503);
    expect((await storedMeta(list.listId)).behaviour).toBe('collection');

    const second = await changeBehaviour(list, 'watch', {
      key,
      ifMatch: String(meta.updatedAt),
    });
    expect(second.status).toBe(200);

    const final = await storedMeta(list.listId);
    expect(final.behaviour).toBe('watch');
    expect(final.rankVersion).toBe(Number(meta.rankVersion) + 1);
    const items = await storedItems(list.listId);
    expect(items).toHaveLength(500);
    expect(
      items.every(
        (item) =>
          item.details?.behaviour === 'watch' && item.details.watchStatus === 'want',
      ),
    ).toBe(true);
    const rows = await base.queryAll<Record<string, unknown>>(
      { pk: keys.listPartition(list.listId).pk },
      { consistentRead: true },
    );
    expect(rows.filter((row) => row.entity === 'ListBehaviourMigration')).toHaveLength(0);
    expect(rows.filter((row) => row.entity === 'ListUndo')).toHaveLength(1);
  });

  /**
   * The final version advance is what stops a client resuming a page across the rewrite. Its
   * cursor is bound to the generation that issued it, so it is rejected rather than honoured.
   */
  it('rejects a pre-migration item cursor after the version advance', async () => {
    const list = await seedList();
    await addItems(
      list.listId,
      Array.from({ length: 60 }, (_, index) => `Item ${String(index)}`),
    );

    const firstPage = await (
      await request('GET', `/v1/lists/${list.listId}?includeItems=true`)
    ).json();
    const cursor = firstPage.data.nextCursor as string;
    expect(cursor).toEqual(expect.any(String));

    const fresh = await storedMeta(list.listId);
    expect(
      (await changeBehaviour(list, 'watch', { ifMatch: String(fresh.updatedAt) })).status,
    ).toBe(200);

    const stale = await request(
      'GET',
      `/v1/lists/${list.listId}/items?cursor=${encodeURIComponent(cursor)}`,
    );

    expect(stale.status).toBe(503);
    expect(stale.headers.get('Retry-After')).toBe('1');
  });

  /**
   * A replay of the same key resolves to the same operation id, so it joins the standing work
   * rather than installing a second marker — which is the whole reason the operation is
   * identified by the key rather than by a fresh ULID.
   */
  it('replays a lost response onto one migration, not two', async () => {
    const list = await seedList();
    await addItems(list.listId, ['Severance', 'Andor']);
    const meta = await storedMeta(list.listId);
    const key = crypto.randomUUID();

    const first = await changeBehaviour(list, 'watch', {
      key,
      ifMatch: String(meta.updatedAt),
    });
    const replay = await changeBehaviour(list, 'watch', {
      key,
      ifMatch: String(meta.updatedAt),
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());

    const rows = await base.queryAll<Record<string, unknown>>(
      { pk: keys.listPartition(list.listId).pk },
      { consistentRead: true },
    );
    expect(rows.filter((row) => row.entity === 'ListBehaviourMigration')).toHaveLength(0);
    expect(rows.filter((row) => row.entity === 'ListUndo')).toHaveLength(1);
    expect((await storedMeta(list.listId)).rankVersion).toBe(
      Number(meta.rankVersion) + 1,
    );
  });
});

describe('the destructive direction', () => {
  const watchList = async () => {
    const list = await seedList();
    await addItems(list.listId, ['Severance', 'Andor']);
    const upgraded = await (
      await changeBehaviour(list, 'watch', {
        ifMatch: String((await storedMeta(list.listId)).updatedAt),
      })
    ).json();
    return upgraded.data.list as List;
  };

  const undoCount = async (listId: string): Promise<number> => {
    const rows = await base.queryAll<Record<string, unknown>>(
      { pk: keys.listPartition(listId).pk },
      { consistentRead: true },
    );
    return rows.filter((row) => row.entity === 'ListUndo').length;
  };

  it('409s without an echo, writes nothing, and returns the exact preview', async () => {
    const list = await watchList();
    const partitionBefore = await storedItems(list.listId);

    const res = await changeBehaviour(list, 'collection');
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.confirmation).toEqual({
      fromBehaviour: 'watch',
      toBehaviour: 'collection',
      itemVersion: expect.any(Number),
      itemCount: 2,
      fields: ['Watch status'],
    });

    const meta = await storedMeta(list.listId);
    expect(meta.behaviour).toBe('watch');
    expect(meta.updatedAt).toBe(list.updatedAt);
    expect(meta.behaviourMigrationId).toBeUndefined();
    expect(await storedItems(list.listId)).toEqual(partitionBefore);
    // Not even a receipt: the refusal happens before the migration record exists.
    const rows = await base.queryAll<Record<string, unknown>>(
      { pk: keys.listPartition(list.listId).pk },
      { consistentRead: true },
    );
    expect(rows.filter((row) => row.entity === 'ListBehaviourMigration')).toHaveLength(0);
  });

  it('drops details, and offers no Undo, once the preview is echoed', async () => {
    const list = await watchList();
    // The upgrade that built the fixture left one; a downgrade must add none.
    const before = await undoCount(list.listId);

    const res = await changeBehaviour(list, 'collection', { confirm: true });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.list.behaviour).toBe('collection');
    expect(body.data.undoToken).toBeUndefined();
    expect((await storedItems(list.listId)).map((item) => item.details)).toEqual([
      undefined,
      undefined,
    ]);
    expect(await undoCount(list.listId)).toBe(before);
  });

  it('re-previews after a field edit even when the affected item count is unchanged', async () => {
    const list = await watchList();
    const first = await changeBehaviour(list, 'collection');
    const shown = (await first.json()).confirmation as ListBehaviourConfirmation;
    const [item] = await storedItems(list.listId);
    if (item === undefined) throw new Error('Expected a watch item.');

    const patched = await request(
      'PATCH',
      `/v1/lists/${list.listId}/items/${item.itemId}`,
      { title: 'Renamed after preview' },
    );
    expect(patched.status).toBe(200);

    const confirmed = await request(
      'POST',
      `/v1/lists/${list.listId}/behaviour`,
      { behaviour: 'collection', confirmation: shown },
      { 'If-Match': list.updatedAt },
    );
    const body = await confirmed.json();

    expect(confirmed.status).toBe(409);
    expect(body.confirmation).toMatchObject({
      fromBehaviour: 'watch',
      toBehaviour: 'collection',
      itemCount: shown.itemCount,
      fields: shown.fields,
      itemVersion: shown.itemVersion + 1,
    });
    expect((await storedMeta(list.listId)).behaviour).toBe('watch');
  });

  /**
   * §1a.1 rule 3 and §4.1 read together. A departure that loses nothing is not destructive,
   * so it needs no confirmation — and being additive, it gets §4's standard Undo. Reading the
   * two rules from different facts is what left an empty watchlist unable to be undone.
   */
  it('offers Undo on a departure that loses nothing, and records its inverse', async () => {
    const list = await seedList({ behaviour: 'watch' });

    const res = await changeBehaviour(list, 'collection');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.list.behaviour).toBe('collection');
    expect(body.data.undoToken).toEqual(expect.any(String));
    expect(body.data.undoExpiresAt).toEqual(expect.any(String));
    expect(await findSettingsUndo(list.listId)).toMatchObject({
      kind: 'behaviour_upgrade',
      inverse: {
        behaviour: 'watch',
        restoreDetails: { behaviour: 'watch', watchStatus: 'want' },
      },
      preconditions: { behaviour: 'collection' },
    });
  });

  /**
   * The rollback the service reaches for when the gated count disagrees with the one it
   * previewed before installing — a confirmation is only worth something if it names what is
   * actually about to go. Proved here at the primitive: an untouched install leaves the list
   * exactly as it was, and one that has already rewritten a chunk refuses to be unwound.
   */
  it('rolls an untouched install back, and refuses once a chunk has landed', async () => {
    const list = await seedList();
    const itemIds = await addItems(list.listId, ['Severance', 'Andor']);
    const before = await storedMeta(list.listId);

    const work = await repository.beginBehaviourMigration(
      DEV,
      list.listId,
      await accessFor(list.listId),
      {
        operationId: 'bmg_rollback',
        toBehaviour: 'watch',
        toDetails: { behaviour: 'watch', watchStatus: 'want' },
        expectedUpdatedAt: String(before.updatedAt),
        expectedItemVersion: Number(before.itemVersion ?? 0),
        now: NOW,
        receipt: preparedReceipt(),
        // Stands in for a concurrent write: the gated snapshot says more than the preview did.
        describeLoss: () => ({ itemCount: 3, fields: ['Watch status'] }),
      },
    );
    expect(work.lossCount).toBe(3);

    await repository.abandonBehaviourMigration(work);

    const after = await storedMeta(list.listId);
    expect(after.behaviourMigrationId).toBeUndefined();
    expect(after.behaviour).toBe('collection');
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.rankVersion).toBe(before.rankVersion);
    expect(await storedWork(list.listId, 'bmg_rollback')).toBeUndefined();
    expect((await storedItems(list.listId)).map((item) => item.details)).toEqual([
      undefined,
      undefined,
    ]);
    // Usable again, and the id it was holding is free.
    expect((await request('GET', `/v1/lists/${list.listId}/items`)).status).toBe(200);
    expect(itemIds).toHaveLength(2);

    // A migration that has already rewritten something is not a rollback candidate.
    const second = await repository.beginBehaviourMigration(
      DEV,
      list.listId,
      await accessFor(list.listId),
      {
        operationId: 'bmg_rollback_late',
        toBehaviour: 'watch',
        toDetails: { behaviour: 'watch', watchStatus: 'want' },
        expectedUpdatedAt: String((await storedMeta(list.listId)).updatedAt),
        expectedItemVersion: Number((await storedMeta(list.listId)).itemVersion ?? 0),
        now: NOW,
        receipt: preparedReceipt(),
        describeLoss: () => ({ itemCount: 0, fields: [] }),
      },
    );
    const advanced = await repository.applyBehaviourMigrationChunk(second);
    await expect(repository.abandonBehaviourMigration(advanced)).rejects.toBeInstanceOf(
      repository.BehaviourMigrationContendedError,
    );
    await repository.finishBehaviourMigration(advanced, {});
  });

  it('treats watch → meals as destructive, and initialises the meals shape once confirmed', async () => {
    const list = await watchList();

    expect((await changeBehaviour(list, 'meals')).status).toBe(409);
    expect((await storedMeta(list.listId)).updatedAt).toBe(list.updatedAt);

    const res = await changeBehaviour(list, 'meals', { confirm: true });

    expect(res.status).toBe(200);
    expect((await storedItems(list.listId)).map((item) => item.details)).toEqual([
      { behaviour: 'meals', ingredients: [] },
      { behaviour: 'meals', ingredients: [] },
    ]);
  });
});

describe('the additive settings around it', () => {
  /**
   * The capability is a display setting: turning it off retains every `checked` value so
   * turning it back on restores exactly what was there (`plans-and-lists.md` §5.5).
   */
  it('round-trips checkable false → true → false with the checks intact', async () => {
    const list = await seedList();
    const [first, second] = await addItems(list.listId, ['Milk', 'Bread']);
    await request('PATCH', `/v1/lists/${list.listId}/items/${first}`, { checked: true });

    const off = await request(
      'PATCH',
      `/v1/lists/${list.listId}`,
      { capabilities: { checkable: false } },
      { 'If-Match': String((await storedMeta(list.listId)).updatedAt) },
    );
    expect(off.status).toBe(200);
    expect((await off.json()).data.list.capabilities.checkable).toBe(false);

    // Hidden, not cleared — and unreachable while the capability is off.
    expect(
      (
        await request('PATCH', `/v1/lists/${list.listId}/items/${second}`, {
          checked: true,
        })
      ).status,
    ).toBe(400);
    expect((await storedItems(list.listId)).map((item) => item.checked)).toEqual([
      true,
      false,
    ]);

    const on = await request(
      'PATCH',
      `/v1/lists/${list.listId}`,
      { capabilities: { checkable: true } },
      { 'If-Match': String((await storedMeta(list.listId)).updatedAt) },
    );
    expect(on.status).toBe(200);
    expect((await storedItems(list.listId)).map((item) => item.checked)).toEqual([
      true,
      false,
    ]);
  });

  /**
   * §2.7: the profile default goes in the **same transaction** as the List update, and only
   * while that slot still names this list. The inverse records the exact entry removed so
   * P3-10 can put it back while the slot is still empty.
   */
  it('clears the matching profile default when the slot moves', async () => {
    await seedProfile();
    const list = await seedList({ slot: 'groceries' });
    await request('PATCH', '/v1/me', { defaultLists: { groceries: list.listId } });

    const res = await request(
      'PATCH',
      `/v1/lists/${list.listId}`,
      { slot: null },
      { 'If-Match': list.updatedAt },
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.list.slot).toBeNull();

    const profile = await (await request('GET', '/v1/me')).json();
    expect(profile.data.defaultLists?.groceries).toBeUndefined();

    const undo = await findSettingsUndo(list.listId);
    expect(undo?.inverse).toEqual({
      slot: 'groceries',
      removedDefault: { slot: 'groceries', listId: list.listId },
    });
    expect(undo?.preconditions).toEqual({
      slot: null,
      defaultSlotAbsent: 'groceries',
    });
  });

  it('leaves a default that names another list alone, and says so in the inverse', async () => {
    await seedProfile();
    const mine = await seedList({ slot: 'groceries' });
    const other = await seedList({ slot: 'groceries', title: 'Costco' });
    await request('PATCH', '/v1/me', { defaultLists: { groceries: other.listId } });

    const res = await request(
      'PATCH',
      `/v1/lists/${mine.listId}`,
      { slot: 'meals' },
      { 'If-Match': mine.updatedAt },
    );

    expect(res.status).toBe(200);
    const profile = await (await request('GET', '/v1/me')).json();
    expect(profile.data.defaultLists.groceries).toBe(other.listId);
    expect(await findSettingsUndo(mine.listId)).toMatchObject({
      inverse: { slot: 'groceries' },
    });
    expect(
      (await findSettingsUndo(mine.listId))?.inverse as Record<string, unknown>,
    ).not.toHaveProperty('removedDefault');
  });

  /**
   * Two switches on one sheet, each with its own six seconds. A whole-pair inverse would make
   * the first toast's Undo depend on the second switch not having been touched since — which
   * is exactly the sequence a settings sheet invites — so it records one flag and leaves the
   * other alone.
   */
  it('records only the capability flag it moved, so the other can move independently', async () => {
    const list = await seedList({
      capabilities: { checkable: true, supportsLocation: false },
    });

    await request(
      'PATCH',
      `/v1/lists/${list.listId}`,
      { capabilities: { checkable: false } },
      { 'If-Match': list.updatedAt },
    );
    const first = await findSettingsUndo(list.listId);

    expect(first?.inverse).toEqual({ capabilities: { checkable: true } });
    expect(first?.preconditions).toEqual({ capabilities: { checkable: false } });

    // The other flag moves independently; the first operation's inverse still names one flag.
    const second = await request(
      'PATCH',
      `/v1/lists/${list.listId}`,
      { capabilities: { supportsLocation: true } },
      { 'If-Match': String((await storedMeta(list.listId)).updatedAt) },
    );
    expect(second.status).toBe(200);
    expect((await storedMeta(list.listId)).capabilities).toEqual({
      checkable: false,
      supportsLocation: true,
    });
    const undos = await allSettingsUndos(list.listId);
    expect(undos.map((row) => row.inverse)).toEqual([
      { capabilities: { checkable: true } },
      { capabilities: { supportsLocation: false } },
    ]);
  });

  /**
   * A delete is a list mutation like any other: it drains what it can and answers the
   * retryable `503` when work remains, rather than failing the gate condition and surfacing
   * as "somebody edited this" for a list that is merely mid-migration.
   */
  it('503s a DELETE that arrives while a migration is outstanding', async () => {
    const list = await seedList();
    await addItems(
      list.listId,
      Array.from({ length: 500 }, (_, index) => `Item ${String(index)}`),
    );
    const meta = await storedMeta(list.listId);
    await repository.beginBehaviourMigration(
      DEV,
      list.listId,
      await accessFor(list.listId),
      {
        operationId: 'bmg_delete_fence',
        toBehaviour: 'watch',
        toDetails: { behaviour: 'watch', watchStatus: 'want' },
        expectedUpdatedAt: String(meta.updatedAt),
        expectedItemVersion: Number(meta.itemVersion ?? 0),
        now: NOW,
        undo: { token: 'tok_delete', expiresAt: '2026-08-24T09:00:06.000Z' },
        receipt: preparedReceipt(),
        describeLoss: () => ({ itemCount: 0, fields: [] }),
      },
    );

    const res = await request('DELETE', `/v1/lists/${list.listId}`);

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
    expect(await storedMeta(list.listId)).toBeDefined();
    expect(
      await base.getItem(keys.listTombstone(list.listId), { consistentRead: true }),
    ).toBeUndefined();
  });

  it('archives through PATCH and records the inverse that restores it', async () => {
    const list = await seedList();

    const res = await request(
      'PATCH',
      `/v1/lists/${list.listId}`,
      { archived: true },
      { 'If-Match': list.updatedAt },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.list.archived).toBe(true);
    expect(body.data.undoToken).toEqual(expect.any(String));
    expect((await storedMeta(list.listId)).archived).toBe(true);
    expect(await findSettingsUndo(list.listId)).toMatchObject({
      kind: 'settings',
      inverse: { archived: false },
      preconditions: { archived: true },
    });
  });

  it('409s a stale If-Match and writes nothing', async () => {
    const list = await seedList();
    await request(
      'PATCH',
      `/v1/lists/${list.listId}`,
      { title: 'First' },
      { 'If-Match': list.updatedAt },
    );

    const res = await request(
      'PATCH',
      `/v1/lists/${list.listId}`,
      { title: 'Second' },
      { 'If-Match': list.updatedAt },
    );

    expect(res.status).toBe(409);
    expect((await storedMeta(list.listId)).title).toBe('First');
  });
});
