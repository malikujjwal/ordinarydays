import type { List, User } from '@od/shared/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestTable } from './harness.js';

useTestTable();

/**
 * Default slots end to end against DynamoDB Local (`phase-03` §P3-12): the nested per-slot
 * `PATCH /v1/me`, and slot resolution over lists the API actually created.
 *
 * The four-step rule itself is proved pure in
 * `packages/shared/src/lists/__tests__/resolveSlot.test.ts`, and the exact three-attempt
 * sequence inside `patchProfile` in `src/repositories/userRepository.test.ts`. What is here
 * is what only a real table can settle: that a document-path `SET` and `REMOVE` really leave
 * the sibling keys alone, that a `REMOVE` deletes the key rather than storing a null, that
 * the map is genuinely created on a profile that has none, and that concurrent writers do
 * not lose each other's slots.
 *
 * **Deferred here, deliberately:** §P3-12's test line "passing the visibly chosen `listId` to
 * the ingredient action uses that list and leaves `defaultLists` unchanged" needs the
 * activity-scoped ingredient action, which is P3-17's endpoint. The per-operation override is
 * a parameter to that request, so there is nothing on this task's surface to point it at; it
 * is recorded in the PR rather than dropped silently.
 */

type AppModule = typeof import('../../src/app.js');
type UserRepository = typeof import('../../src/repositories/userRepository.js');
type SlotService = typeof import('../../src/services/listSlotService.js');

let createApp: AppModule['createApp'];
let userRepository: UserRepository;
let resolveListSlot: SlotService['resolveListSlot'];

const DEV = 'usr_local_dev';
const NOW = '2026-08-24T09:00:00.000Z';
/** A well-formed id for a list this table has never held. */
const GONE = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X9';

beforeAll(async () => {
  createApp = (await import('../../src/app.js')).createApp;
  userRepository = await import('../../src/repositories/userRepository.js');
  resolveListSlot = (await import('../../src/services/listSlotService.js'))
    .resolveListSlot;
});

const app = () => createApp();

const request = (method: string, path: string, body?: unknown, headers = {}) =>
  app().fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const patchMe = (body: unknown) => request('PATCH', '/v1/me', body);

/** A profile carrying whatever slot map the case needs — or none at all. */
const seedProfile = (defaultLists?: User['defaultLists']) =>
  userRepository.putProfile({
    userId: DEV,
    displayName: 'Dev',
    timezone: 'America/New_York',
    currency: 'USD',
    weekStartsOn: 0,
    ...(defaultLists === undefined ? {} : { defaultLists }),
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  });

const createList = async (title: string, templateKey = 'groceries') => {
  const res = await request('POST', '/v1/lists', { title, templateKey });
  expect(res.status).toBe(201);
  return (await res.json()).data as List;
};

const storedDefaults = async () => (await userRepository.getProfile(DEV))?.defaultLists;

const A = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const B = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const C = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X4';

describe('PATCH /v1/me — every request preserves every slot it did not name', () => {
  /**
   * The §P3-12 profile test, exactly: start with all three, set one, clear another with
   * `null`, and check after **each** request that the slots neither named survived. A
   * whole-map assignment passes the first half of this and fails the second.
   */
  it('sets one slot and clears another without disturbing the third', async () => {
    await seedProfile({ groceries: A, watch: B, meals: C });

    const set = await patchMe({ defaultLists: { groceries: GONE } });
    expect(set.status).toBe(200);
    expect(await storedDefaults()).toEqual({ groceries: GONE, watch: B, meals: C });

    const cleared = await patchMe({ defaultLists: { watch: null } });
    expect(cleared.status).toBe(200);
    expect(await storedDefaults()).toEqual({ groceries: GONE, meals: C });
  });

  /** Clearing removes the key. A stored null would be a third state no reader expects. */
  it('removes the key rather than storing a null', async () => {
    await seedProfile({ groceries: A, watch: B });

    await patchMe({ defaultLists: { watch: null } });

    const defaults = await storedDefaults();
    expect(defaults).not.toHaveProperty('watch');
    expect(defaults).toEqual({ groceries: A });
  });

  it('applies a set and a clear from one request', async () => {
    await seedProfile({ groceries: A, watch: B, meals: C });

    await patchMe({ defaultLists: { groceries: GONE, meals: null } });

    expect(await storedDefaults()).toEqual({ groceries: GONE, watch: B });
  });

  it('leaves the map alone entirely when the patch names another field', async () => {
    await seedProfile({ groceries: A, watch: B });

    const res = await patchMe({ displayName: 'Ada' });

    expect(res.status).toBe(200);
    expect((await res.json()).data.displayName).toBe('Ada');
    expect(await storedDefaults()).toEqual({ groceries: A, watch: B });
  });

  it('rejects a value that is not a list id, naming the field', async () => {
    await seedProfile({ groceries: A });

    const res = await patchMe({ defaultLists: { groceries: 'Groceries' } });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(await storedDefaults()).toEqual({ groceries: A });
  });

  it('is 404 against a profile that does not exist', async () => {
    const res = await patchMe({ defaultLists: { groceries: A } });

    expect(res.status).toBe(404);
  });
});

describe('PATCH /v1/me — a legacy profile with no slot map', () => {
  it('creates the map holding just that slot', async () => {
    await seedProfile();

    const res = await patchMe({ defaultLists: { groceries: A } });

    expect(res.status).toBe(200);
    expect(await storedDefaults()).toEqual({ groceries: A });
  });

  it('creates no map when the patch only clears, and still applies its other fields', async () => {
    await seedProfile();

    const res = await patchMe({ displayName: 'Ada', defaultLists: { watch: null } });

    expect(res.status).toBe(200);
    expect((await res.json()).data.displayName).toBe('Ada');
    expect(await storedDefaults()).toBeUndefined();
  });

  /**
   * The concurrent-creator case, against real conditional writes: three requests start with
   * no map to write into, one wins the create, and the losers retry the nested operation
   * rather than assigning a map of their own. Every slot survives — which is the property
   * the retry exists for, and the property a whole-map write destroys.
   *
   * The interleaving is real rather than forced, so this asserts the outcome; the exact
   * attempt sequence a loser follows is pinned in the repository's unit suite.
   */
  it('loses no slot when three devices choose different slots at once', async () => {
    await seedProfile();

    const responses = await Promise.all([
      patchMe({ defaultLists: { groceries: A } }),
      patchMe({ defaultLists: { watch: B } }),
      patchMe({ defaultLists: { meals: C } }),
    ]);

    expect(responses.map((res) => res.status)).toEqual([200, 200, 200]);
    expect(await storedDefaults()).toEqual({ groceries: A, watch: B, meals: C });
  });

  /** The same, against a profile that already has one slot: it must not be overwritten. */
  it('loses no slot when two devices choose different slots at once', async () => {
    await seedProfile({ meals: C });

    await Promise.all([
      patchMe({ defaultLists: { groceries: A } }),
      patchMe({ defaultLists: { watch: B } }),
    ]);

    expect(await storedDefaults()).toEqual({ groceries: A, watch: B, meals: C });
  });
});

describe('slot resolution over real lists', () => {
  it('uses the only grocery list silently, and still names it', async () => {
    await seedProfile();
    const only = await createList('Trader Joe’s');

    expect(await resolveListSlot(DEV, 'groceries')).toEqual({
      kind: 'use',
      listId: only.listId,
      wasDefault: false,
    });
  });

  /**
   * The §P3-12 round trip: two eligible lists and no default ask; the answer is stored
   * through the ordinary profile patch; the next resolve uses it and says it was the
   * default.
   */
  it('asks once, then uses the stored answer', async () => {
    await seedProfile();
    const traderJoes = await createList('Trader Joe’s');
    const cornerShop = await createList('Corner shop');

    const asked = await resolveListSlot(DEV, 'groceries');
    expect(asked.kind).toBe('ask');
    expect(
      asked.kind === 'ask' && asked.candidates.map((row) => row.listId).sort(),
    ).toEqual([traderJoes.listId, cornerShop.listId].sort());

    const stored = await patchMe({ defaultLists: { groceries: cornerShop.listId } });
    expect(stored.status).toBe(200);

    expect(await resolveListSlot(DEV, 'groceries')).toEqual({
      kind: 'use',
      listId: cornerShop.listId,
      wasDefault: true,
    });
  });

  /**
   * ADR-033: opening a list writes nothing at all, so browsing cannot redirect tomorrow's
   * ingredients. Asserted on the profile row specifically — the request does touch storage,
   * because every authenticated request writes a rate-limit counter.
   */
  it('opening the non-default list writes no profile row and changes no answer', async () => {
    await seedProfile();
    const traderJoes = await createList('Trader Joe’s');
    const cornerShop = await createList('Corner shop');
    await patchMe({ defaultLists: { groceries: cornerShop.listId } });
    const before = await userRepository.getProfile(DEV);

    const opened = await request('GET', `/v1/lists/${traderJoes.listId}`);
    expect(opened.status).toBe(200);

    expect(await userRepository.getProfile(DEV)).toEqual(before);
    expect(await resolveListSlot(DEV, 'groceries')).toEqual({
      kind: 'use',
      listId: cornerShop.listId,
      wasDefault: true,
    });
  });

  it('falls back to asking when the default list is deleted', async () => {
    await seedProfile();
    const traderJoes = await createList('Trader Joe’s');
    await createList('Corner shop');
    await createList('Costco');
    await patchMe({ defaultLists: { groceries: traderJoes.listId } });

    const deleted = await request('DELETE', `/v1/lists/${traderJoes.listId}`);
    expect(deleted.status).toBe(200);

    expect((await resolveListSlot(DEV, 'groceries')).kind).toBe('ask');
    /**
     * P3-05 clears the pointer in the delete transaction, so nothing stale is left pointing
     * anywhere. Removing the last key leaves the parent map behind as an empty one rather
     * than deleting the attribute — which reads identically to absent, because every slot is
     * unset either way, and is why the stored map is `Partial` rather than required.
     */
    expect(await storedDefaults()).toEqual({});
  });

  /**
   * The belt to those braces. A pointer at a list this table has never held must produce the
   * question, not a destination the user cannot reach (§P3-12 edge cases).
   */
  it('treats a default naming a list that does not exist as unset', async () => {
    await seedProfile({ groceries: GONE });
    await createList('Trader Joe’s');
    await createList('Corner shop');

    expect((await resolveListSlot(DEV, 'groceries')).kind).toBe('ask');
  });

  /**
   * Archiving does not clear the profile pointer — only a slot change or a delete does — so
   * this is the read-side guard doing the whole job on its own.
   */
  it('treats a default naming an archived list as unset', async () => {
    await seedProfile();
    const traderJoes = await createList('Trader Joe’s');
    await createList('Corner shop');
    await createList('Costco');
    await patchMe({ defaultLists: { groceries: traderJoes.listId } });

    const archived = await request(
      'PATCH',
      `/v1/lists/${traderJoes.listId}`,
      { archived: true },
      { 'If-Match': traderJoes.updatedAt },
    );
    expect(archived.status).toBe(200);

    const result = await resolveListSlot(DEV, 'groceries');
    expect(result.kind).toBe('ask');
    expect(
      result.kind === 'ask' &&
        result.candidates.some((row) => row.listId === traderJoes.listId),
    ).toBe(false);
    // The pointer is still stored; the read is what refuses to follow it.
    expect(await storedDefaults()).toEqual({ groceries: traderJoes.listId });
  });

  it('returns exactly none, with no template or title, when no list holds the slot', async () => {
    await seedProfile();
    await createList('Packing', 'packing');

    const result = await resolveListSlot(DEV, 'groceries');

    expect(result).toEqual({ kind: 'none', slot: 'groceries' });
  });

  /** A Watch destination with nowhere to go is the same shape, naming its own slot. */
  it('returns none for a watch destination with no watch list', async () => {
    await seedProfile();
    await createList('Trader Joe’s');

    expect(await resolveListSlot(DEV, 'watch')).toEqual({ kind: 'none', slot: 'watch' });
  });

  it('ignores a list holding a different slot', async () => {
    await seedProfile();
    const watchlist = await createList('Watchlist', 'watchlist');
    await createList('Trader Joe’s');

    expect(await resolveListSlot(DEV, 'watch')).toEqual({
      kind: 'use',
      listId: watchlist.listId,
      wasDefault: false,
    });
  });
});
