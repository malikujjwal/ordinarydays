import type { User } from '@od/shared/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestTable } from './harness.js';

useTestTable();

/**
 * The nested per-slot `PATCH /v1/me` end to end against DynamoDB Local (`phase-03` §P3-12).
 *
 * The exact three-attempt retry sequence inside `patchProfile` is pinned in
 * `src/repositories/userRepository.test.ts`, where the command input is observable. What is
 * here is what only a real table can settle: that a document-path `SET` and `REMOVE` really
 * leave the sibling keys alone, that a `REMOVE` deletes the key rather than storing a null,
 * that the map is genuinely created on a profile that has none, and that concurrent writers
 * do not lose each other's slots.
 *
 * **What resolving a destination no longer needs from this file:** this suite used to also
 * cover `resolveListSlot` — the four-step rule read back over lists this table actually held
 * — but Option B1 (`docs/reports/destination-flow-simplification-20260916.md`) moved
 * destination resolution onto the client alone and deleted the server-side mirror as dead
 * code (it had no caller outside its own tests). The nested profile write this suite proves
 * is exactly the wire shape the client's `remember()` still calls; only the resolution half
 * left with the function it tested.
 */

type AppModule = typeof import('../../src/app.js');
type UserRepository = typeof import('../../src/repositories/userRepository.js');

let createApp: AppModule['createApp'];
let userRepository: UserRepository;

const DEV = 'usr_local_dev';
const NOW = '2026-08-24T09:00:00.000Z';
/** A well-formed id for a list this table has never held. */
const GONE = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X9';

beforeAll(async () => {
  createApp = (await import('../../src/app.js')).createApp;
  userRepository = await import('../../src/repositories/userRepository.js');
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
