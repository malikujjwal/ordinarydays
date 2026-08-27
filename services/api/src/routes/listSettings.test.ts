import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { MAX_AUTOMATIC_INTENT_AGE_DAYS } from '@od/shared';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';

import type { createApp as CreateApp } from '../app.js';
import { IDEMPOTENCY_TTL_SECONDS } from '../lib/idempotency.js';
import { idempotency } from '../repositories/keys.js';

/**
 * `PATCH /v1/lists/:id` and `POST /v1/lists/:id/behaviour` (P3-09).
 *
 * One test per row of the change-rules table, plus the two things the table does not say and
 * the endpoints have to: who may make each change, and what an unconfirmed destructive call
 * costs — which is nothing, because it is refused before anything is written.
 *
 * The **migration itself** is proved against DynamoDB Local in
 * `test/integration/listBehaviourMigration.int.test.ts`: a paused 500-item run, competing
 * reads and writes, the version fence and the recorded Undo inverse are all about what
 * storage really does across several transactions, and a command mock would only be able to
 * assert that this file's own fixture was returned.
 */
const ddbMock = mockClient(DynamoDBDocumentClient);

let createApp: typeof CreateApp;

const DEV = 'usr_local_dev';
const BEN = 'usr_ben';
const LST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ITM = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const ITM2 = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X4';
const UPDATED_AT = '2026-08-23T00:00:00.000Z';

const listMetaRow = (overrides: Record<string, unknown> = {}) => ({
  pk: `LIST#${LST}`,
  sk: 'META',
  entity: 'List',
  listId: LST,
  ownerId: DEV,
  behaviour: 'collection',
  templateKey: 'groceries',
  title: 'Groceries',
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  capabilities: { checkable: true, supportsLocation: false },
  slot: 'groceries',
  itemCount: 2,
  uncheckedCount: 2,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: UPDATED_AT,
  lastItemActivityAt: UPDATED_AT,
  ...overrides,
});

const pointerRow = (userId = DEV, role = 'owner') => ({
  pk: `USER#${userId}`,
  sk: `LIST#${LST}`,
  entity: 'ListIndex',
  listId: LST,
  userId,
  role,
  addedAt: UPDATED_AT,
});

const itemRow = (itemId: string, rank: string, details?: Record<string, unknown>) => ({
  pk: `LIST#${LST}`,
  sk: `ITEM#${rank}#${itemId}`,
  entity: 'ListItem',
  itemId,
  listId: LST,
  rank,
  itemRevision: 0,
  title: 'Severance',
  checked: false,
  ...(details === undefined ? {} : { details }),
});

const seedGets = (rows: Record<string, unknown>[]) => {
  const byKey = new Map(rows.map((row) => [`${row.pk}|${row.sk}`, row]));
  ddbMock
    .on(GetCommand)
    .callsFake((input) => ({ Item: byKey.get(`${input.Key.pk}|${input.Key.sk}`) }));
};

/** The item rows a whole-list read returns; every other Query answers empty. */
const seedItems = (rows: Record<string, unknown>[]) => {
  ddbMock
    .on(QueryCommand)
    .callsFake((input) =>
      String(input.ExpressionAttributeValues?.[':pk'] ?? '').startsWith('LIST#')
        ? { Items: rows }
        : { Items: [] },
    );
};

beforeEach(async () => {
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(TransactWriteCommand).resolves({});
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

const asUser = (userId: string) =>
  createApp({ identityProvider: { resolve: () => Promise.resolve(userId) } });

const patch = (
  app: ReturnType<typeof CreateApp>,
  body: unknown,
  headers: Record<string, string> = { 'If-Match': UPDATED_AT },
) =>
  app.fetch(
    new Request(`http://localhost/v1/lists/${LST}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );

const postBehaviour = (
  app: ReturnType<typeof CreateApp>,
  body: unknown,
  options: { query?: string; headers?: Record<string, string> } = {},
) =>
  app.fetch(
    new Request(`http://localhost/v1/lists/${LST}/behaviour${options.query ?? ''}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': UPDATED_AT,
        'Idempotency-Key': crypto.randomUUID(),
        ...options.headers,
      },
      body: JSON.stringify(body),
    }),
  );

const transacted = () =>
  ddbMock
    .commandCalls(TransactWriteCommand)
    .flatMap((call) => call.args[0].input.TransactItems ?? []) as Array<{
    Put?: { Item?: Record<string, unknown> };
    Delete?: { Key?: Record<string, unknown> };
    Update?: {
      Key?: Record<string, unknown>;
      UpdateExpression?: string;
      ConditionExpression?: string;
      ExpressionAttributeValues?: Record<string, unknown>;
    };
    ConditionCheck?: { Key?: Record<string, unknown> };
  }>;

const metaUpdate = () =>
  transacted().find(
    (entry) =>
      entry.Update?.Key?.pk === `LIST#${LST}` && entry.Update?.Key?.sk === 'META',
  )?.Update;

const undoWrite = () =>
  transacted().find((entry) => entry.Put?.Item?.entity === 'ListUndo')?.Put?.Item;

const receiptWrite = () =>
  transacted().find((entry) => entry.Put?.Item?.entity === 'Idempotency')?.Put?.Item;

const directReceiptWrite = () =>
  ddbMock
    .commandCalls(PutCommand)
    .map((call) => call.args[0].input.Item as Record<string, unknown> | undefined)
    .find((item) => item?.entity === 'Idempotency');

const profileUpdate = () =>
  transacted().find((entry) => entry.Update?.Key?.pk === `USER#${DEV}`)?.Update;

describe('PATCH /v1/lists/:id — the additive settings', () => {
  beforeEach(() => {
    seedGets([pointerRow(), listMetaRow()]);
  });

  it('requires If-Match, and its absence is a 400 naming the header', async () => {
    const res = await patch(createApp(), { title: 'Trader Joe’s' }, {});
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details[0].path).toBe('If-Match');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('requires an Idempotency-Key so a lost Undo response can be replayed', async () => {
    const res = await createApp().fetch(
      new Request(`http://localhost/v1/lists/${LST}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'If-Match': UPDATED_AT },
        body: JSON.stringify({ archived: true }),
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.details[0].path).toBe('Idempotency-Key');
  });

  it('retains the exact settings response for the durable outbox window', async () => {
    await patch(createApp(), { archived: true });

    const receipt = receiptWrite();
    expect(receipt).toBeDefined();
    expect(
      Number(receipt?.ttl) - Math.floor(Date.parse(String(receipt?.createdAt)) / 1000),
    ).toBe(MAX_AUTOMATIC_INTENT_AGE_DAYS * 24 * 60 * 60);
  });

  it('keeps a tokenless settings response on the ordinary receipt window', async () => {
    await patch(createApp(), { title: 'Trader Joe’s' });

    const receipt = receiptWrite();
    expect(receipt).toBeDefined();
    expect(
      Number(receipt?.ttl) - Math.floor(Date.parse(String(receipt?.createdAt)) / 1000),
    ).toBe(IDEMPOTENCY_TTL_SECONDS);
  });

  it('replays the winner when the List version and same-key receipt both lose', async () => {
    const key = crypto.randomUUID();
    const receiptKey = idempotency(DEV, key);
    const rows = new Map(
      [pointerRow(), listMetaRow()].map((row) => [`${row.pk}|${row.sk}`, row]),
    );
    let transactionAttempted = false;
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.Key.pk === receiptKey.pk && input.Key.sk === receiptKey.sk) {
        return transactionAttempted
          ? {
              Item: {
                ...receiptKey,
                status: 200,
                body: '{"data":{"source":"winner"}}',
              },
            }
          : {};
      }
      return { Item: rows.get(`${input.Key.pk}|${input.Key.sk}`) };
    });
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      transactionAttempted = true;
      throw new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
        ],
      });
    });

    const res = await patch(
      createApp(),
      { archived: true },
      {
        'If-Match': UPDATED_AT,
        'Idempotency-Key': key,
      },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { source: 'winner' } });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it.each([
    ['bare', UPDATED_AT],
    ['quoted', `"${UPDATED_AT}"`],
    ['weak', `W/"${UPDATED_AT}"`],
  ])('accepts a %s entity tag', async (_form, header) => {
    const res = await patch(
      createApp(),
      { title: 'Trader Joe’s' },
      { 'If-Match': header },
    );

    expect(res.status).toBe(200);
  });

  /**
   * `templateKey` is provenance and immutable, and `behaviour` belongs to the dedicated
   * replay-protected action. Both are refused by the strict body rather than dropped, so the
   * user is told what did not happen instead of watching a save appear to succeed.
   */
  it.each(['templateKey', 'behaviour'])('400s a PATCH carrying %s', async (field) => {
    const res = await patch(createApp(), { [field]: 'watch' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(JSON.stringify(body.error.details)).toContain(field);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('400s an empty body rather than bumping the version for nothing', async () => {
    const res = await patch(createApp(), {});

    expect(res.status).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  /**
   * Both directions are additive, so both apply immediately and both get the standard Undo.
   * Nothing about turning checkboxes off touches an item: the `checked` values stay put and
   * stop meaning anything until the capability comes back (`plans-and-lists.md` §5.5).
   */
  it.each([
    ['false → true', false, true],
    ['true → false', true, false],
  ])(
    'applies checkable %s immediately, with an Undo token and no item writes',
    async (_direction, stored, checkable) => {
      seedGets([
        pointerRow(),
        listMetaRow({ capabilities: { checkable: stored, supportsLocation: false } }),
      ]);

      const res = await patch(createApp(), { capabilities: { checkable } });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.list.capabilities).toEqual({
        checkable,
        supportsLocation: false,
      });
      expect(body.data.undoToken).toEqual(expect.any(String));
      expect(body.data.undoExpiresAt).toEqual(expect.any(String));
      expect(
        transacted().filter((entry) => entry.Put?.Item?.entity === 'ListItem'),
      ).toHaveLength(0);
    },
  );

  it('merges a partial capabilities patch onto the stored pair', async () => {
    await patch(createApp(), { capabilities: { supportsLocation: true } });

    expect(metaUpdate()?.ExpressionAttributeValues?.[':capabilities']).toEqual({
      checkable: true,
      supportsLocation: true,
    });
  });

  /**
   * **Only the flag that moved.** `Show checkboxes` and `Add a place to items` are two
   * switches on one sheet, each with its own six seconds of Undo. Recording the pair would
   * make this toast's Undo depend on the other switch not having been touched since — which
   * is exactly the sequence a settings sheet invites — and, if applied, would put the newer
   * choice back where it was.
   */
  it('records only the flag it moved, as both the inverse and the precondition', async () => {
    await patch(createApp(), { capabilities: { checkable: false } });
    const undo = undoWrite();

    expect(undo?.kind).toBe('settings');
    expect(undo?.inverse).toEqual({ capabilities: { checkable: true } });
    expect(undo?.preconditions).toEqual({ capabilities: { checkable: false } });
    expect(undo?.consumed).toBe(false);
    // Only the hash enters this retained Undo row; the exact-response receipt is separate.
    expect(JSON.stringify(undo)).not.toContain('undoToken');
  });

  /** A patch naming both flags but moving one records one; the write still carries the pair. */
  it('ignores a flag the patch restated without changing', async () => {
    await patch(createApp(), {
      capabilities: { checkable: false, supportsLocation: false },
    });

    expect(metaUpdate()?.ExpressionAttributeValues?.[':capabilities']).toEqual({
      checkable: false,
      supportsLocation: false,
    });
    expect(undoWrite()?.inverse).toEqual({ capabilities: { checkable: true } });
  });

  it('offers no Undo when the supplied flags are the ones already stored', async () => {
    const res = await patch(createApp(), { capabilities: { checkable: true } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.undoToken).toBeUndefined();
    expect(undoWrite()).toBeUndefined();
  });

  /**
   * A rename is a rename. `interaction-contract.md` §4.1 has no undo row for it, so it gets
   * no token — and a token that also reverted the title alongside a capability would take
   * back something the user was never offered the chance to keep.
   */
  it('renames in one write and offers no Undo', async () => {
    const res = await patch(createApp(), { title: 'Favourite restaurants' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.undoToken).toBeUndefined();
    expect(
      transacted().filter((entry) => entry.Put?.Item?.entity === 'List'),
    ).toHaveLength(0);
    expect(metaUpdate()?.ExpressionAttributeValues?.[':title']).toBe(
      'Favourite restaurants',
    );
  });

  it('archives with an Undo that restores archived: false', async () => {
    const res = await patch(createApp(), { archived: true });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.list.archived).toBe(true);
    expect(undoWrite()?.inverse).toEqual({ archived: false });
    expect(undoWrite()?.preconditions).toEqual({ archived: true });
  });

  /**
   * §2.7: changing or clearing a slot removes `defaultLists[oldSlot]` in the **same
   * transaction**, conditioned on that slot still naming this list. The inverse records the
   * exact entry removed, and that the slot must still be empty for it to go back.
   */
  it.each([
    ['changes', 'meals'],
    ['clears', null],
  ])(
    'removes the matching profile default when a slot %s, in the same transaction',
    async (_verb, slot) => {
      await patch(createApp(), { slot });
      const items = transacted();
      const profile = profileUpdate();

      expect(profile?.UpdateExpression).toBe('REMOVE #defaultLists.#slot');
      expect(profile?.ExpressionAttributeValues?.[':listId']).toBe(LST);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
      expect(items).toContainEqual(expect.objectContaining({ Update: profile }));
      expect(undoWrite()?.inverse).toEqual({
        slot: 'groceries',
        removedDefault: { slot: 'groceries', listId: LST },
      });
      expect(undoWrite()?.preconditions).toEqual({
        slot,
        defaultSlotAbsent: 'groceries',
      });
    },
  );

  /**
   * A newer destination chosen on another device fails only that item. The settings change
   * still applies, and the inverse must not claim to have removed a default it left standing
   * — otherwise Undo would put a stale pointer back over the user's newer choice.
   */
  it('keeps a concurrently changed default, and drops it from the inverse', async () => {
    let attempt = 0;
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      attempt += 1;
      if (attempt > 1) return {};
      throw new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [
          { Code: 'None' },
          { Code: 'None' },
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
        ],
      });
    });

    const res = await patch(createApp(), { slot: 'meals' });

    expect(res.status).toBe(200);
    expect(attempt).toBe(2);
    const undos = transacted().filter((entry) => entry.Put?.Item?.entity === 'ListUndo');
    // The first attempt tried to take the default with it; the retry left it alone, and its
    // inverse says so rather than promising to restore a pointer that never moved.
    expect(undos[0]?.Put?.Item?.inverse).toEqual({
      slot: 'groceries',
      removedDefault: { slot: 'groceries', listId: LST },
    });
    expect(undos.at(-1)?.Put?.Item?.inverse).toEqual({ slot: 'groceries' });
    expect(undos.at(-1)?.Put?.Item?.preconditions).toEqual({ slot: 'meals' });
  });

  it('409s a stale If-Match, naming the current version so the client can re-apply', async () => {
    const res = await patch(createApp(), { title: 'Nope' }, { 'If-Match': 'yesterday' });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('conflict');
    expect(body.error.details).toEqual([{ path: 'updatedAt', message: UPDATED_AT }]);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe('PATCH /v1/lists/:id — who may change what', () => {
  it('lets a member rename: it changes nothing but the title', async () => {
    seedGets([pointerRow(BEN, 'member'), listMetaRow()]);

    const res = await patch(asUser(BEN), { title: 'Ours' });

    expect(res.status).toBe(200);
  });

  it.each([
    ['capabilities', { capabilities: { checkable: false } }],
    ['slot', { slot: null }],
    ['archived', { archived: true }],
  ])(
    '403s a member changing %s — a change to the object, not their view',
    async (field, body) => {
      seedGets([pointerRow(BEN, 'member'), listMetaRow()]);

      const res = await patch(asUser(BEN), body);
      const parsed = await res.json();

      expect(res.status).toBe(403);
      expect(parsed.error.details[0].path).toBe(field);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    },
  );

  it('404s a caller with no pointer, indistinguishable from a missing list', async () => {
    seedGets([listMetaRow()]);

    const res = await patch(asUser('usr_stranger'), { title: 'Mine now' });

    expect(res.status).toBe(404);
  });
});

describe('POST /v1/lists/:id/behaviour — the refusals', () => {
  it('requires If-Match', async () => {
    seedGets([pointerRow(), listMetaRow()]);

    const res = await postBehaviour(
      createApp(),
      { behaviour: 'watch' },
      { headers: { 'If-Match': '' } },
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.details[0].path).toBe('If-Match');
  });

  /**
   * The registry classifies this as a mutating POST, so the shared middleware — not a
   * second, PATCH-shaped receipt path — refuses a request with no key.
   */
  it('requires an Idempotency-Key, from the shared middleware', async () => {
    seedGets([pointerRow(), listMetaRow()]);

    const res = await createApp().fetch(
      new Request(`http://localhost/v1/lists/${LST}/behaviour`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'If-Match': UPDATED_AT },
        body: JSON.stringify({ behaviour: 'watch' }),
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.details[0].path).toBe('Idempotency-Key');
  });

  it('400s an unknown behaviour and a body carrying anything else', async () => {
    seedGets([pointerRow(), listMetaRow()]);

    expect((await postBehaviour(createApp(), { behaviour: 'shopping' })).status).toBe(
      400,
    );
    expect(
      (await postBehaviour(createApp(), { behaviour: 'watch', confirmDataLoss: true }))
        .status,
    ).toBe(400);
  });

  it('403s a member — changing behaviour is the owner’s', async () => {
    seedGets([pointerRow(BEN, 'member'), listMetaRow()]);

    const res = await postBehaviour(asUser(BEN), { behaviour: 'watch' });

    expect(res.status).toBe(403);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('retains a lossless behaviour Undo response for the durable outbox window', async () => {
    seedGets([pointerRow(), listMetaRow()]);
    seedItems([]);

    await postBehaviour(createApp(), { behaviour: 'watch' });

    const work = transacted().find(
      (entry) => entry.Put?.Item?.entity === 'ListBehaviourMigration',
    )?.Put?.Item;
    const receipt = work?.receipt as Record<string, unknown> | undefined;
    expect(receipt).toBeDefined();
    expect(
      Number(receipt?.ttl) - Math.floor(Date.parse(String(receipt?.createdAt)) / 1000),
    ).toBe(MAX_AUTOMATIC_INTENT_AGE_DAYS * 24 * 60 * 60);
  });

  it('answers with current truth, and no Undo offer, when it is already there', async () => {
    seedGets([pointerRow(), listMetaRow({ behaviour: 'watch' })]);

    const res = await postBehaviour(createApp(), { behaviour: 'watch' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.list.behaviour).toBe('watch');
    expect(body.data.undoToken).toBeUndefined();
    expect(
      transacted().filter(
        (entry) => entry.Put?.Item?.entity === 'ListBehaviourMigration',
      ),
    ).toHaveLength(0);
    const receipt = directReceiptWrite();
    expect(receipt).toBeDefined();
    expect(
      Number(receipt?.ttl) - Math.floor(Date.parse(String(receipt?.createdAt)) / 1000),
    ).toBe(IDEMPOTENCY_TTL_SECONDS);
  });
});

describe('POST /v1/lists/:id/behaviour — the destructive confirmation', () => {
  const watchList = () =>
    seedGets([pointerRow(), listMetaRow({ behaviour: 'watch', itemCount: 3 })]);

  /**
   * §1a.1 rule 2: the count is the number of records that **actually carry** the data, not
   * the collection's size — and rule 4: the fields are named the way the user sees them.
   * Here two of three items carry watch state and only one of them has a season, so the
   * confirmation says two items and does not offer to remove an episode nobody set.
   */
  it('409s with the exact confirmation object the client must echo', async () => {
    watchList();
    seedItems([
      itemRow(ITM, 'a0', { behaviour: 'watch', watchStatus: 'watching', season: 2 }),
      itemRow(ITM2, 'a1', { behaviour: 'watch', watchStatus: 'want' }),
      itemRow('itm_01J8XKQ2M4N5P6R7S8T9V0W1X5', 'a2'),
    ]);

    const res = await postBehaviour(createApp(), { behaviour: 'collection' });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('conflict');
    expect(body.confirmation).toEqual({
      fromBehaviour: 'watch',
      toBehaviour: 'collection',
      itemVersion: 0,
      itemCount: 2,
      fields: ['Watch status', 'Season'],
    });
  });

  it('writes nothing at all — no receipt, no marker, no work record', async () => {
    watchList();
    seedItems([itemRow(ITM, 'a0', { behaviour: 'watch', watchStatus: 'want' })]);

    await postBehaviour(createApp(), { behaviour: 'collection' });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  /** `watch → meals` is not a sideways move: nothing carries season and status across it. */
  it('treats watch → meals as destructive too', async () => {
    watchList();
    seedItems([itemRow(ITM, 'a0', { behaviour: 'watch', watchStatus: 'want' })]);

    const res = await postBehaviour(createApp(), { behaviour: 'meals' });

    expect(res.status).toBe(409);
  });

  /**
   * §1a.1 rule 3: a change that is destructive only *conditionally* shows no confirmation
   * when nothing would be lost, and a confirmation that can appear with a count of zero is a
   * bug. An empty watchlist is exactly that case, so it changes immediately.
   */
  it('needs no confirmation when no item carries the data being removed', async () => {
    seedGets([pointerRow(), listMetaRow({ behaviour: 'watch', itemCount: 0 })]);
    seedItems([]);

    const res = await postBehaviour(createApp(), { behaviour: 'collection' });

    expect(res.status).not.toBe(409);
    expect(
      transacted().some((entry) => entry.Put?.Item?.entity === 'ListBehaviourMigration'),
    ).toBe(true);
  });

  it('counts a meals item by its ingredients, not by having a details object', async () => {
    seedGets([pointerRow(), listMetaRow({ behaviour: 'meals', itemCount: 2 })]);
    seedItems([
      itemRow(ITM, 'a0', { behaviour: 'meals', ingredients: [] }),
      itemRow(ITM2, 'a1', {
        behaviour: 'meals',
        ingredients: [
          { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1X2', name: 'Chicken' },
        ],
      }),
    ]);

    const res = await postBehaviour(createApp(), { behaviour: 'collection' });

    expect(await res.json()).toMatchObject({
      confirmation: {
        fromBehaviour: 'meals',
        toBehaviour: 'collection',
        itemVersion: 0,
        itemCount: 1,
        fields: ['Ingredients'],
      },
    });
  });

  /**
   * The confirmed call is a **new logical action** under a newly minted key and echoes the
   * exact preview object. The body is different by construction, and the echoed generation
   * is what the META install conditions on.
   */
  it('starts the migration once the exact preview is echoed', async () => {
    watchList();
    seedItems([itemRow(ITM, 'a0', { behaviour: 'watch', watchStatus: 'want' })]);

    const res = await postBehaviour(createApp(), {
      behaviour: 'collection',
      confirmation: {
        fromBehaviour: 'watch',
        toBehaviour: 'collection',
        itemVersion: 0,
        itemCount: 1,
        fields: ['Watch status'],
      },
    });

    expect(res.status).not.toBe(409);
    const work = transacted().find(
      (entry) => entry.Put?.Item?.entity === 'ListBehaviourMigration',
    )?.Put?.Item;
    expect(work).toMatchObject({
      state: 'snapshotting',
      fromBehaviour: 'watch',
      toBehaviour: 'collection',
      cursor: 0,
    });
    // A downgrade is confirmed, not undone: no Undo offer is prepared for it (§4.1).
    expect(work?.undo).toBeUndefined();
    expect(metaUpdate()?.ConditionExpression).toContain(
      'attribute_not_exists(#itemVersion)',
    );
    // Public behaviour is untouched by the install; only the final transaction flips it.
    expect(metaUpdate()?.UpdateExpression).toBe(
      'SET #behaviourMigrationId = :operationId',
    );
  });

  it('returns a fresh preview when a field edit changes itemVersion but not itemCount', async () => {
    watchList();
    seedItems([itemRow(ITM, 'a0', { behaviour: 'watch', watchStatus: 'want' })]);
    const first = await postBehaviour(createApp(), { behaviour: 'collection' });
    const shown = (await first.json()).confirmation;

    seedGets([
      pointerRow(),
      listMetaRow({ behaviour: 'watch', itemCount: 3, itemVersion: 1 }),
    ]);
    seedItems([
      itemRow(ITM, 'a0', { behaviour: 'watch', watchStatus: 'watching', season: 2 }),
    ]);
    const confirmed = await postBehaviour(createApp(), {
      behaviour: 'collection',
      confirmation: shown,
    });
    const body = await confirmed.json();

    expect(confirmed.status).toBe(409);
    expect(body.confirmation).toEqual({
      fromBehaviour: 'watch',
      toBehaviour: 'collection',
      itemVersion: 1,
      itemCount: 1,
      fields: ['Watch status', 'Season'],
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe('the route registry', () => {
  it('classifies the behaviour action as a mutating POST', async () => {
    const { ROUTE_REGISTRY } = await import('../middleware/routeRegistry.js');
    const entry = ROUTE_REGISTRY.find(
      (candidate) =>
        candidate.method === 'POST' && candidate.pattern === '/v1/lists/:id/behaviour',
    );

    expect(entry).toEqual({
      method: 'POST',
      pattern: '/v1/lists/:id/behaviour',
      auth: 'authenticated',
      mutates: true,
    });
  });

  it('registers settings PATCH as replay-protected because its Undo token is opaque', async () => {
    const { ROUTE_REGISTRY } = await import('../middleware/routeRegistry.js');

    expect(
      ROUTE_REGISTRY.find(
        (candidate) =>
          candidate.method === 'PATCH' && candidate.pattern === '/v1/lists/:id',
      ),
    ).toEqual({
      method: 'PATCH',
      pattern: '/v1/lists/:id',
      auth: 'authenticated',
      mutates: true,
    });
  });
});
