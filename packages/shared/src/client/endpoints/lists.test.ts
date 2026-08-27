import { describe, expect, it } from 'vitest';
import type { FetchLike, HttpClientConfig } from '../http.js';
import { ApiError, createHttpClient, nullTokenProvider } from '../http.js';
import {
  bulkCreateListItems,
  createListItem,
  deleteListItem,
  getListItem,
  getListItemForReplay,
  getListItems,
  patchListItem,
  scheduleListItem,
} from './listItems.js';
import {
  behaviourConfirmationFrom,
  changeListBehaviour,
  createList,
  deleteList,
  getList,
  getLists,
  patchList,
  undoListOperation,
} from './lists.js';
import { getListTemplates } from './listTemplates.js';

/**
 * The List, ListItem and template endpoint functions (P3-24).
 *
 * `http.test.ts` already covers the transport exhaustively, so what is asserted here is what
 * these functions exist to keep:
 *
 * 1. **The headers a durable mutation cannot work without** — `If-Match` on a settings write,
 *    `Idempotency-Key` on everything that creates or migrates.
 * 2. **The typed `409` confirmation survives the error path and round-trips on the echo.**
 * 3. **Cursors are passed through, never assumed away** — no function believes the first 50
 *    items are the whole list.
 * 4. **No exported function takes a `rank`** (P3-03), asserted over the real signatures.
 */

const REQUEST_ID = 'req_test';

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}

function makeClient(
  outcomes: Array<{ status: number; body?: unknown }>,
  overrides: Partial<HttpClientConfig> = {},
) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    if (outcome === undefined) throw new Error('no outcome');
    return Promise.resolve({
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      headers: { get: () => null },
      json: () => Promise.resolve(outcome.body),
      text: () =>
        Promise.resolve(outcome.body === undefined ? '' : JSON.stringify(outcome.body)),
    });
  };

  const client = createHttpClient({
    baseUrl: 'https://api.test',
    fetch,
    tokenProvider: nullTokenProvider,
    timezone: 'Europe/London',
    clientVersion: 'ios/0.1.0',
    strictResponses: true,
    sleep: () => Promise.resolve(),
    newRequestId: () => REQUEST_ID,
    onWarning: () => {},
    ...overrides,
  });
  return { client, calls };
}

const LIST_ID = 'lst_01J0000000000000000000000A';
const ITEM_ID = 'itm_01J0000000000000000000000C';

const LIST = {
  listId: LIST_ID,
  ownerId: 'usr_01J0000000000000000000000B',
  behaviour: 'collection',
  templateKey: 'groceries',
  title: 'Costco run',
  icon: 'cart',
  emptyStateCopy: 'Nothing here yet',
  capabilities: { checkable: true, supportsLocation: false },
  slot: null,
  itemCount: 2,
  uncheckedCount: 1,
  memberCount: 1,
  rankVersion: 3,
  archived: false,
  updatedAt: '2026-08-26T10:00:00.000Z',
  lastItemActivityAt: '2026-08-26T10:00:00.000Z',
};

const ITEM = {
  itemId: ITEM_ID,
  listId: LIST_ID,
  rank: 'n',
  title: 'Milk',
  checked: false,
};

const ok = (data: unknown) => ({
  status: 200,
  body: { data, meta: { requestId: REQUEST_ID } },
});

const okPage = (data: unknown, nextCursor?: string) => ({
  status: 200,
  body: {
    data,
    meta: {
      requestId: REQUEST_ID,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    },
  },
});

describe('createList', () => {
  it('sends the client-minted id and the idempotency key together', async () => {
    const { client, calls } = makeClient([ok(LIST)]);

    await createList(
      client,
      { listId: LIST_ID, title: 'Costco run', templateKey: 'groceries' },
      'key-1',
    );

    expect(calls[0]?.url).toBe('https://api.test/v1/lists');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['Idempotency-Key']).toBe('key-1');
    // Both ids travel: the key deduplicates the request, `listId` is the durable identity.
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      listId: LIST_ID,
      title: 'Costco run',
      templateKey: 'groceries',
    });
  });
});

describe('getLists', () => {
  it('returns the envelope so a filtered-empty page keeps its cursor', async () => {
    // The endpoint does not filter by `archived`, so this page renders as nothing while still
    // having more behind it. A function returning `data` alone would strand P3-25's drain.
    const { client } = makeClient([okPage([{ ...LIST, archived: true }], 'cur-2')]);

    const page = await getLists(client);

    expect(page.data).toHaveLength(1);
    expect(page.meta.nextCursor).toBe('cur-2');
  });

  it('encodes the cursor it was given', async () => {
    const { client, calls } = makeClient([okPage([], undefined)]);

    await getLists(client, 'a b/c');

    expect(calls[0]?.url).toBe('https://api.test/v1/lists?cursor=a%20b%2Fc');
  });
});

describe('getList', () => {
  it('asks for items only when told to, and keeps the item cursor', async () => {
    const { client, calls } = makeClient([
      ok({ list: LIST, items: [{ item: ITEM }], nextCursor: 'items-2' }),
    ]);

    const detail = await getList(client, LIST_ID, { includeItems: true });

    expect(calls[0]?.url).toBe(`https://api.test/v1/lists/${LIST_ID}?includeItems=true`);
    // Inside `data`, because it is bound to the META rankVersion this response read.
    expect(detail.nextCursor).toBe('items-2');
  });

  it('omits the query when items were not asked for', async () => {
    const { client, calls } = makeClient([ok({ list: LIST })]);

    const detail = await getList(client, LIST_ID);

    expect(calls[0]?.url).toBe(`https://api.test/v1/lists/${LIST_ID}`);
    expect(detail.items).toBeUndefined();
  });

  it('passes the 503 fence through as a retryable error rather than interpreting it', async () => {
    const { client } = makeClient([
      {
        status: 503,
        body: {
          error: { code: 'internal', message: 'Try again.', requestId: REQUEST_ID },
        },
      },
    ]);

    await expect(getList(client, LIST_ID)).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
    });
  });
});

describe('patchList', () => {
  it('requires If-Match and sends the patch verbatim', async () => {
    const { client, calls } = makeClient([
      ok({ list: LIST, undoToken: 'undo-1', undoExpiresAt: '2026-08-26T10:00:06.000Z' }),
    ]);

    const result = await patchList(
      client,
      LIST_ID,
      { capabilities: { checkable: false } },
      '2026-08-26T10:00:00.000Z',
    );

    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.headers['If-Match']).toBe('2026-08-26T10:00:00.000Z');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      capabilities: { checkable: false },
    });
    // An additive change carries the Undo offer; the pair is present or absent together.
    expect(result).toMatchObject({ undoToken: 'undo-1' });
  });

  it('parses a rename, which records no inverse and offers no token', async () => {
    const { client } = makeClient([ok({ list: LIST })]);

    const result = await patchList(client, LIST_ID, { title: 'Big shop' }, 'v1');

    expect('undoToken' in result).toBe(false);
  });
});

describe('changeListBehaviour', () => {
  it('carries both If-Match and Idempotency-Key', async () => {
    const { client, calls } = makeClient([ok({ list: LIST })]);

    await changeListBehaviour(client, LIST_ID, { behaviour: 'watch' }, 'v1', 'key-1');

    expect(calls[0]?.url).toBe(`https://api.test/v1/lists/${LIST_ID}/behaviour`);
    expect(calls[0]?.headers['If-Match']).toBe('v1');
    // Identifies the migration, so a replay resumes its own work instead of starting a second.
    expect(calls[0]?.headers['Idempotency-Key']).toBe('key-1');
  });

  /**
   * The contract point the whole 409 exists for: the server's typed preview reaches the
   * surface intact, and the confirmed call echoes **that object**, not one the client rebuilt.
   * `itemVersion` is the basis of the preview — a client that re-derived the count from a
   * paginated cache would be confirming its own measurement against a version it never saw.
   */
  it('surfaces the typed confirmation and echoes it back on the confirmed call', async () => {
    const confirmation = {
      fromBehaviour: 'collection' as const,
      toBehaviour: 'watch' as const,
      itemVersion: 12,
      itemCount: 4,
      fields: ['checked', 'note'],
    };

    const { client, calls } = makeClient([
      {
        status: 409,
        body: {
          error: {
            code: 'conflict',
            message: 'This will remove some fields.',
            requestId: REQUEST_ID,
          },
          confirmation,
        },
      },
      ok({ list: { ...LIST, behaviour: 'watch' } }),
    ]);

    const refused = await changeListBehaviour(
      client,
      LIST_ID,
      { behaviour: 'watch' },
      'v1',
      'key-1',
    ).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ApiError);
    const surfaced = behaviourConfirmationFrom(refused);
    expect(surfaced).toEqual(confirmation);

    // The user confirmed. A NEW key, and the whole object echoed.
    await changeListBehaviour(
      client,
      LIST_ID,
      { behaviour: 'watch', confirmation: surfaced },
      'v1',
      'key-2',
    );

    expect(calls[1]?.headers['Idempotency-Key']).toBe('key-2');
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({
      behaviour: 'watch',
      confirmation,
    });
    // The removed flag is not resurrected as a query parameter.
    expect(calls[1]?.url).not.toContain('confirmDataLoss');
  });

  it('reads no confirmation off an unrelated error', () => {
    // The field is only meaningful on a 409 from this route; a reader that ignored the status
    // would compile everywhere and be right in one place.
    expect(
      behaviourConfirmationFrom(new ApiError('conflict', 'stale', 412, REQUEST_ID)),
    ).toBeUndefined();
    expect(behaviourConfirmationFrom(new Error('boom'))).toBeUndefined();
  });
});

describe('undoListOperation', () => {
  it('sends only the token, under its own idempotency key', async () => {
    const { client, calls } = makeClient([ok({ outcome: 'applied', affectedCount: 3 })]);

    const result = await undoListOperation(client, LIST_ID, 'tok-1', 'undo-key');

    expect(calls[0]?.url).toBe(`https://api.test/v1/lists/${LIST_ID}/undo`);
    // Strictly the token. A client never sends deleted row contents back as authority.
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ undoToken: 'tok-1' });
    expect(calls[0]?.headers['Idempotency-Key']).toBe('undo-key');
    expect(result).toEqual({ outcome: 'applied', affectedCount: 3 });
  });

  it.each(['expired', 'no_longer_applicable'] as const)(
    'returns %s as data, not as a thrown error',
    async (outcome) => {
      // All three outcomes are 200: each is a true answer to the question asked.
      const { client } = makeClient([ok({ outcome })]);

      await expect(undoListOperation(client, LIST_ID, 'tok', 'k')).resolves.toEqual({
        outcome,
      });
    },
  );
});

describe('deleteList', () => {
  it('names what was removed', async () => {
    const { client, calls } = makeClient([ok({ listId: LIST_ID })]);

    await expect(deleteList(client, LIST_ID)).resolves.toEqual({ listId: LIST_ID });
    expect(calls[0]?.method).toBe('DELETE');
  });
});

describe('list items', () => {
  it('creates with the stable id and the key', async () => {
    const { client, calls } = makeClient([ok(ITEM)]);

    await createListItem(client, LIST_ID, { itemId: ITEM_ID, title: 'Milk' }, 'key-1');

    expect(calls[0]?.url).toBe(`https://api.test/v1/lists/${LIST_ID}/items`);
    expect(calls[0]?.headers['Idempotency-Key']).toBe('key-1');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      itemId: ITEM_ID,
      title: 'Milk',
    });
  });

  it('bulk-creates one ordered sequence, every member keeping its own id', async () => {
    const second = { ...ITEM, itemId: 'itm_01J0000000000000000000000D', title: 'Eggs' };
    const { client, calls } = makeClient([ok([ITEM, second])]);

    const items = await bulkCreateListItems(
      client,
      LIST_ID,
      {
        items: [
          { itemId: ITEM.itemId, title: 'Milk', afterItemId: undefined },
          { itemId: second.itemId, title: 'Eggs' },
        ],
      },
      'bulk-key',
    );

    expect(calls[0]?.url).toBe(`https://api.test/v1/lists/${LIST_ID}/items/bulk`);
    expect(calls[0]?.headers['Idempotency-Key']).toBe('bulk-key');
    expect(items.map((item) => item.itemId)).toEqual([ITEM.itemId, second.itemId]);
  });

  it('reorders with afterItemId, folding fields into the same write', async () => {
    const { client, calls } = makeClient([ok({ ...ITEM, checked: true })]);

    await patchListItem(client, LIST_ID, ITEM_ID, {
      checked: true,
      afterItemId: null,
    });

    expect(calls[0]?.method).toBe('PATCH');
    // `null` moves the item to the front; no rank is involved on the wire.
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      checked: true,
      afterItemId: null,
    });
    expect(calls[0]?.headers['If-Match']).toBeUndefined();
  });

  it('pages items and keeps the rank-bound cursor', async () => {
    const { client, calls } = makeClient([okPage([ITEM], 'page-2')]);

    const page = await getListItems(client, LIST_ID, 'page-1');

    expect(calls[0]?.url).toBe(
      `https://api.test/v1/lists/${LIST_ID}/items?cursor=page-1`,
    );
    expect(page.meta.nextCursor).toBe('page-2');
  });

  it('answers the delete with the reversible triple', async () => {
    const { client } = makeClient([
      ok({
        affectedCount: 1,
        undoToken: 'tok',
        undoExpiresAt: '2026-08-26T10:00:06.000Z',
      }),
    ]);

    await expect(deleteListItem(client, LIST_ID, ITEM_ID)).resolves.toEqual({
      affectedCount: 1,
      undoToken: 'tok',
      undoExpiresAt: '2026-08-26T10:00:06.000Z',
    });
  });

  describe('the exact read used for collision reconciliation', () => {
    it('adopts the server row when the lost create had landed', async () => {
      const { client, calls } = makeClient([ok(ITEM)]);

      await expect(getListItem(client, LIST_ID, ITEM_ID)).resolves.toMatchObject({
        itemId: ITEM_ID,
      });
      expect(calls[0]?.url).toBe(`https://api.test/v1/lists/${LIST_ID}/items/${ITEM_ID}`);
    });

    it('returns undefined on 404, because absence here is ambiguous', async () => {
      // A tombstoned id answers 404 exactly as a missing one does, so the client cannot
      // resolve it and must park the intent for explicit Retry or Discard. No auto re-mint.
      const { client } = makeClient([
        {
          status: 404,
          body: {
            error: { code: 'not_found', message: 'Gone.', requestId: REQUEST_ID },
          },
        },
      ]);

      await expect(
        getListItemForReplay(client, LIST_ID, ITEM_ID),
      ).resolves.toBeUndefined();
    });

    it('still throws a 503 fence, which is a retry rather than an absence', async () => {
      const { client } = makeClient([
        {
          status: 503,
          body: {
            error: { code: 'internal', message: 'Fenced.', requestId: REQUEST_ID },
          },
        },
      ]);

      await expect(getListItemForReplay(client, LIST_ID, ITEM_ID)).rejects.toBeInstanceOf(
        ApiError,
      );
    });
  });

  /**
   * The bridge sends `ScheduleListItemInput` exactly. Both halves of the user's choice travel
   * as given: nothing here supplies `creationTarget` or `audience`, and nothing derives either
   * from the item, the list or the title (`CLAUDE.md` rule 2).
   */
  it('schedules an item without inferring a kind or an audience', async () => {
    const activityId = 'act_01J0000000000000000000000E';
    const { client, calls } = makeClient([
      ok({
        activity: {
          activityId,
          ownerId: LIST.ownerId,
          objectKind: 'plan',
          type: 'watch',
          status: 'saved',
          title: 'Milk',
          participantCount: 0,
          childCount: 0,
          expenseTotalCents: 0,
          visibility: 'private',
          details: { kind: 'watch', mediaTitle: 'Milk' },
          icsSequence: 0,
          createdAt: LIST.updatedAt,
          lastActivityAt: LIST.updatedAt,
          updatedAt: LIST.updatedAt,
          schemaVersion: 1,
        },
        item: ITEM,
        viewerLink: {
          listId: LIST_ID,
          itemId: ITEM_ID,
          viewerUserId: LIST.ownerId,
          activityId,
          linkedAt: LIST.updatedAt,
        },
      }),
    ]);

    await scheduleListItem(
      client,
      LIST_ID,
      ITEM_ID,
      {
        activityId,
        creationTarget: { objectKind: 'plan', type: 'watch' },
        audience: { mode: 'just_me' },
      },
      'sched-key',
    );

    expect(calls[0]?.url).toBe(
      `https://api.test/v1/lists/${LIST_ID}/items/${ITEM_ID}/schedule`,
    );
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      activityId,
      creationTarget: { objectKind: 'plan', type: 'watch' },
      audience: { mode: 'just_me' },
    });
  });
});

describe('getListTemplates', () => {
  it('sends no cache header of its own and rides the client conditional GET', async () => {
    const { client, calls } = makeClient([ok([])]);

    await getListTemplates(client);

    expect(calls[0]?.url).toBe('https://api.test/v1/list-templates');
    // The ETag pairing belongs to `createHttpClient`; a header here would be stripped anyway.
    expect(
      Object.keys(calls[0]?.headers ?? {}).map((name) => name.toLowerCase()),
    ).not.toContain('if-none-match');
  });
});

/**
 * **No exported client function takes a `rank`** (P3-03, `phase-03` §P3-24).
 *
 * Asserted over the real compiled signatures rather than by grepping the source, because a
 * source grep cannot tell a parameter from the word "rank" in a comment — and these files
 * discuss `rankVersion` and lexo ranks at length. Reading the parameter list is the precise
 * question: position is `afterItemId`, and the rank keyspace is the server's.
 */
describe('the rank rule', () => {
  const parameterNames = (fn: (...args: never[]) => unknown): string[] => {
    const source = fn.toString();
    const open = source.indexOf('(');
    const close = source.indexOf(')', open);
    return source
      .slice(open + 1, close)
      .split(',')
      .map((part) => part.trim().split(/[:=]/)[0]?.trim() ?? '')
      .filter((name) => name !== '');
  };

  it('holds across every exported endpoint function', async () => {
    const modules = await Promise.all([
      import('./lists.js'),
      import('./listItems.js'),
      import('./listTemplates.js'),
      import('./updates.js'),
      import('./attachments.js'),
      import('./plans.js'),
    ]);

    const functions = modules
      .flatMap((module) => Object.entries(module))
      .filter(
        (entry): entry is [string, (...args: never[]) => unknown] =>
          typeof entry[1] === 'function',
      );

    expect(functions.length).toBeGreaterThan(15);
    for (const [name, fn] of functions) {
      expect(parameterNames(fn), `${name} takes a rank`).not.toContain('rank');
    }
  });
});
