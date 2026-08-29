import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { documents, TEST_TABLE, useTestTable } from './harness.js';

useTestTable();

/**
 * Lists CRUD end to end against DynamoDB Local (§P3-05's test list): template copy
 * semantics, the owned-list cap, the source-Plan projection, the delete cascade's profile
 * and provenance cleanup, and durable-create reconciliation.
 *
 * Exercised through the real app where a status code is the assertion, and through the
 * repositories where seeding or storage inspection is.
 *
 * **Deferred here, deliberately:** §P3-05's "explicit Retry atomically remaps a locally
 * populated list and its whole dependent intent chain" is the native client's SQLite
 * transaction (P3-25/P3-27) and cannot be exercised from the API side; it is recorded in
 * the PR rather than dropped silently.
 */

type AppModule = typeof import('../../src/app.js');
type Repository = typeof import('../../src/repositories/listRepository.js');
type UserRepository = typeof import('../../src/repositories/userRepository.js');
type Lists = typeof import('@od/shared/lists');

let createApp: AppModule['createApp'];
let repository: Repository;
let userRepository: UserRepository;
let LIST_TEMPLATES: Lists['LIST_TEMPLATES'];

const DEV = 'usr_local_dev';
const BEN = 'usr_int_lists_ben';
const NOW = instant.parse('2026-08-24T09:00:00.000Z');

beforeAll(async () => {
  createApp = (await import('../../src/app.js')).createApp;
  repository = await import('../../src/repositories/listRepository.js');
  userRepository = await import('../../src/repositories/userRepository.js');
  LIST_TEMPLATES = (await import('@od/shared/lists')).LIST_TEMPLATES;
});

const app = () => createApp();
const asBen = () =>
  createApp({ identityProvider: { resolve: () => Promise.resolve(BEN) } });

const post = (
  application: ReturnType<AppModule['createApp']>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  application.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );

const get = (application: ReturnType<AppModule['createApp']>, path: string) =>
  application.fetch(new Request(`http://localhost${path}`));

const patch = (
  application: ReturnType<AppModule['createApp']>,
  path: string,
  body: unknown,
) =>
  application.fetch(
    new Request(`http://localhost${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const del = (application: ReturnType<AppModule['createApp']>, listId: string) =>
  application.fetch(
    new Request(`http://localhost/v1/lists/${listId}`, { method: 'DELETE' }),
  );

const rawItem = async (pk: string, sk: string) =>
  (
    await documents.send(
      new GetCommand({ TableName: TEST_TABLE, Key: { pk, sk }, ConsistentRead: true }),
    )
  ).Item;

const createListVia = async (
  application: ReturnType<AppModule['createApp']>,
  body: Record<string, unknown>,
) => {
  const res = await post(application, '/v1/lists', {
    title: 'Groceries',
    templateKey: 'groceries',
    ...body,
  });
  expect(res.status).toBe(201);
  return (await res.json()).data as List;
};

const createPlanVia = async (application: ReturnType<AppModule['createApp']>) => {
  const res = await post(application, '/v1/activities', {
    objectKind: 'plan',
    type: 'custom',
    title: 'New York Trip',
  });
  expect(res.status).toBe(201);
  return (await res.json()).data as { activityId: string; updatedAt: string };
};

describe('template resolution at creation', () => {
  it('copies every seeded field as a value — mutating the template later changes nothing', async () => {
    const created = await createListVia(app(), { title: 'Trader Joe’s' });
    expect(created).toMatchObject({
      schemaVersion: 2,
      templateKey: 'groceries',
      icon: 'cart',
      emptyStateCopy: 'Add something to buy.',
      itemStateMode: { mode: 'checkbox' },
      featureConfig: {},
      slot: 'groceries',
      itemCount: 0,
      doneCount: 0,
      memberCount: 1,
      archived: false,
    });

    // Acceptance criterion 3: mutate the in-memory catalogue record, then re-read.
    const template = LIST_TEMPLATES.find((entry) => entry.templateKey === 'groceries');
    if (template === undefined) throw new Error('groceries template missing');
    const original = {
      itemStateMode: template.itemStateMode,
      featureConfig: template.featureConfig,
      slot: template.slot,
      icon: template.icon,
      emptyStateCopy: template.emptyStateCopy,
    };
    try {
      (template as { itemStateMode: List['itemStateMode'] }).itemStateMode = {
        mode: 'none',
      };
      (template as { featureConfig: List['featureConfig'] }).featureConfig = {
        place: { enabled: true },
      };
      (template as { slot: string | null }).slot = null;
      (template as { icon: string }).icon = 'mutated';
      (template as { emptyStateCopy: string }).emptyStateCopy = 'Mutated.';

      const reread = await (await get(app(), `/v1/lists/${created.listId}`)).json();
      expect(reread.data.list).toMatchObject({
        itemStateMode: { mode: 'checkbox' },
        featureConfig: {},
        slot: 'groceries',
        icon: 'cart',
        emptyStateCopy: 'Add something to buy.',
        templateKey: 'groceries',
      });
    } finally {
      (template as { itemStateMode: List['itemStateMode'] }).itemStateMode =
        original.itemStateMode;
      (template as { featureConfig: List['featureConfig'] }).featureConfig =
        original.featureConfig;
      (template as { slot: string | null }).slot = original.slot;
      (template as { icon: string }).icon = original.icon;
      (template as { emptyStateCopy: string }).emptyStateCopy = original.emptyStateCopy;
    }
  });

  it('rejects client-supplied seeded fields with 400 and writes nothing', async () => {
    const listId = repository.newListId();
    const res = await post(app(), '/v1/lists', {
      listId,
      title: 'Groceries',
      templateKey: 'groceries',
      behaviour: 'watch',
    });

    expect(res.status).toBe(400);
    expect(await rawItem(`LIST#${listId}`, 'META')).toBeUndefined();
    expect(await repository.getListPointer(DEV, listId)).toBeUndefined();
  });

  it.each([
    { title: 'Costco run', templateKey: 'not-a-style' },
    { title: 'Costco run' },
    { title: '', templateKey: 'groceries' },
    { title: '   ', templateKey: 'groceries' },
  ])('400s %j and writes nothing', async (body) => {
    const listId = repository.newListId();
    const res = await post(app(), '/v1/lists', { listId, ...body });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(await rawItem(`LIST#${listId}`, 'META')).toBeUndefined();
  });

  it('400s a malformed client-minted id', async () => {
    const res = await post(app(), '/v1/lists', {
      listId: 'lst_not-a-ulid',
      title: 'Groceries',
      templateKey: 'groceries',
    });

    expect(res.status).toBe(400);
  });

  it('refuses the 101st owned list with 400', async () => {
    for (let index = 0; index < 100; index += 1) {
      const list: List = {
        schemaVersion: 2,
        listId: repository.newListId(),
        ownerId: DEV,
        templateKey: 'simple-list',
        title: `List ${index}`,
        icon: 'list',
        emptyStateCopy: 'Add the first item.',
        itemStateMode: { mode: 'none' },
        featureConfig: {},
        slot: null,
        itemCount: 0,
        doneCount: 0,
        memberCount: 1,
        rankVersion: 0,
        archived: false,
        updatedAt: NOW,
        lastItemActivityAt: NOW,
      };
      await repository.createList(DEV, list, { now: NOW });
    }

    const res = await post(app(), '/v1/lists', {
      title: 'One more',
      templateKey: 'groceries',
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
  });
});

describe('aggregate repair on read', () => {
  const corruptDoneCount = (listId: string) =>
    documents.send(
      new UpdateCommand({
        TableName: TEST_TABLE,
        Key: { pk: `LIST#${listId}`, sk: 'META' },
        UpdateExpression: 'SET #doneCount = :negative',
        ExpressionAttributeNames: { '#doneCount': 'doneCount' },
        ExpressionAttributeValues: { ':negative': -1 },
      }),
    );

  it('repairs a negative doneCount before returning list detail', async () => {
    const created = await createListVia(app(), { title: 'Repair detail' });
    const item = await post(app(), `/v1/lists/${created.listId}/items`, {
      title: 'Already done',
    });
    expect(item.status).toBe(201);
    const itemBody = await item.json();
    const marked = await patch(
      app(),
      `/v1/lists/${created.listId}/items/${itemBody.data.itemId}`,
      { state: 'done' },
    );
    expect(marked.status).toBe(200);
    await corruptDoneCount(created.listId);

    const response = await get(app(), `/v1/lists/${created.listId}?includeItems=true`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.list.doneCount).toBe(1);
    expect((await rawItem(`LIST#${created.listId}`, 'META'))?.doneCount).toBe(1);
  });

  it('repairs a negative doneCount before returning the list index', async () => {
    const created = await createListVia(app(), { title: 'Repair index' });
    await corruptDoneCount(created.listId);

    const response = await get(app(), '/v1/lists');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      body.data.find((list: List) => list.listId === created.listId)?.doneCount,
    ).toBe(0);
    expect((await rawItem(`LIST#${created.listId}`, 'META'))?.doneCount).toBe(0);
  });
});

describe('a list created from a Plan', () => {
  it('stores sourceActivityId with slot null and writes the id-only projection', async () => {
    const plan = await createPlanVia(app());
    const created = await createListVia(app(), {
      title: 'Groceries · New York Trip',
      sourceActivityId: plan.activityId,
    });

    // The groceries template seeds a standing slot; the per-occasion list must not.
    expect(created.slot).toBeNull();
    expect(created.sourceActivityId).toBe(plan.activityId);

    const projection = await rawItem(
      `ACT#${plan.activityId}`,
      `SOURCE_LIST#${created.listId}`,
    );
    expect(projection).toMatchObject({
      activityId: plan.activityId,
      listId: created.listId,
    });
    expect(projection).not.toHaveProperty('title');
    expect(projection).not.toHaveProperty('itemCount');
  });

  it('deleting the list removes the projection and leaves the Plan intact', async () => {
    const plan = await createPlanVia(app());
    const created = await createListVia(app(), {
      sourceActivityId: plan.activityId,
    });

    expect((await del(app(), created.listId)).status).toBe(200);

    expect(
      await rawItem(`ACT#${plan.activityId}`, `SOURCE_LIST#${created.listId}`),
    ).toBeUndefined();
    expect(await rawItem(`ACT#${plan.activityId}`, 'META')).toBeDefined();
  });

  it('re-asserts the source Plan at commit time, not only at the service pre-read', async () => {
    // The service's authorisation read can go stale between the check and the write; the
    // create transaction's own condition is what closes the deletion/conversion race.
    const task = await post(app(), '/v1/activities', {
      objectKind: 'task',
      type: 'task',
      title: 'Buy milk',
    });
    const taskId = (await task.json()).data.activityId as string;

    const withConvertedSource: List = {
      schemaVersion: 2,
      listId: repository.newListId(),
      ownerId: DEV,
      templateKey: 'groceries',
      title: 'Groceries',
      icon: 'cart',
      emptyStateCopy: 'Add something to buy.',
      itemStateMode: { mode: 'checkbox' },
      featureConfig: {},
      slot: null,
      sourceActivityId: taskId,
      itemCount: 0,
      doneCount: 0,
      memberCount: 1,
      rankVersion: 0,
      archived: false,
      updatedAt: NOW,
      lastItemActivityAt: NOW,
    };
    await expect(
      repository.createList(DEV, withConvertedSource, { now: NOW }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await rawItem(`LIST#${withConvertedSource.listId}`, 'META')).toBeUndefined();
    expect(
      await rawItem(`ACT#${taskId}`, `SOURCE_LIST#${withConvertedSource.listId}`),
    ).toBeUndefined();

    const withDeletedSource: List = {
      ...withConvertedSource,
      listId: repository.newListId(),
      sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X9',
    };
    await expect(
      repository.createList(DEV, withDeletedSource, { now: NOW }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await rawItem(`LIST#${withDeletedSource.listId}`, 'META')).toBeUndefined();
  });

  it('rejects a source that is not an owned Plan', async () => {
    const task = await post(app(), '/v1/activities', {
      objectKind: 'task',
      type: 'task',
      title: 'Buy milk',
    });
    const taskId = (await task.json()).data.activityId as string;

    const notAPlan = await post(app(), '/v1/lists', {
      title: 'Groceries',
      templateKey: 'groceries',
      sourceActivityId: taskId,
    });
    expect(notAPlan.status).toBe(400);

    const plan = await createPlanVia(app());
    const stranger = await post(asBen(), '/v1/lists', {
      title: 'Groceries',
      templateKey: 'groceries',
      sourceActivityId: plan.activityId,
    });
    expect(stranger.status).toBe(404);
  });
});

describe('deleting a list', () => {
  it('answers 200 with the id, then 404 on the second call', async () => {
    const created = await createListVia(app(), {});

    const first = await del(app(), created.listId);
    expect(first.status).toBe(200);
    expect((await first.json()).data).toEqual({ listId: created.listId });

    const second = await del(app(), created.listId);
    expect(second.status).toBe(404);
  });

  it('clears the profile default that pointed at it, preserving other slots', async () => {
    const created = await createListVia(app(), {});
    await userRepository.putProfile({
      userId: DEV,
      displayName: 'Dev',
      timezone: 'America/New_York',
      currency: 'USD',
      weekStartsOn: 'monday',
      defaultLists: {
        groceries: created.listId,
        watch: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X9',
      },
      createdAt: NOW,
      updatedAt: NOW,
      schemaVersion: 1,
    } as never);

    expect((await del(app(), created.listId)).status).toBe(200);

    const profile = await userRepository.getProfile(DEV);
    expect(profile?.defaultLists?.groceries).toBeUndefined();
    // The nested REMOVE touches exactly one key; the sibling slot survives.
    expect(profile?.defaultLists?.watch).toBe('lst_01J8XKQ2M4N5P6R7S8T9V0W1X9');
  });

  it('leaves a default that names a different list untouched', async () => {
    const created = await createListVia(app(), {});
    await userRepository.putProfile({
      userId: DEV,
      displayName: 'Dev',
      timezone: 'America/New_York',
      currency: 'USD',
      weekStartsOn: 'monday',
      defaultLists: { groceries: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X9' },
      createdAt: NOW,
      updatedAt: NOW,
      schemaVersion: 1,
    } as never);

    expect((await del(app(), created.listId)).status).toBe(200);

    const profile = await userRepository.getProfile(DEV);
    expect(profile?.defaultLists?.groceries).toBe('lst_01J8XKQ2M4N5P6R7S8T9V0W1X9');
  });

  it('clears Activity provenance from LNK rows without deleting the Activity, and bumps updatedAt', async () => {
    const created = await createListVia(app(), {});
    const plan = await createPlanVia(app());
    const itemId = repository.newItemId();

    // Seed what P3-13's bridge will write: provenance on the Activity, and the caller's
    // viewer pointer in the List partition. Nothing else writes these yet.
    await documents.send(
      new UpdateCommand({
        TableName: TEST_TABLE,
        Key: { pk: `ACT#${plan.activityId}`, sk: 'META' },
        UpdateExpression: 'SET listId = :listId, listItemId = :itemId',
        ExpressionAttributeValues: { ':listId': created.listId, ':itemId': itemId },
      }),
    );
    await documents.send(
      new PutCommand({
        TableName: TEST_TABLE,
        Item: {
          pk: `LIST#${created.listId}`,
          sk: `LNK#${DEV}#${itemId}`,
          entity: 'ListItemActivityLink',
          listId: created.listId,
          itemId,
          viewerUserId: DEV,
          activityId: plan.activityId,
          linkedAt: NOW,
        },
      }),
    );
    const before = await rawItem(`ACT#${plan.activityId}`, 'META');

    expect((await del(app(), created.listId)).status).toBe(200);

    const after = await rawItem(`ACT#${plan.activityId}`, 'META');
    expect(after).toBeDefined();
    expect(after).not.toHaveProperty('listId');
    expect(after).not.toHaveProperty('listItemId');
    // The reverse link is versioned Activity state, even though its projection is access-filtered.
    expect(after?.updatedAt).not.toBe(before?.updatedAt);
    // The pointer went with the partition.
    expect(
      await rawItem(`LIST#${created.listId}`, `LNK#${DEV}#${itemId}`),
    ).toBeUndefined();
  });

  it('iterates every pointer rather than assuming a single owner', async () => {
    const created = await createListVia(app(), {});
    // Seed what Phase 6 will write: an active member row and their pointer.
    await documents.send(
      new PutCommand({
        TableName: TEST_TABLE,
        Item: {
          pk: `LIST#${created.listId}`,
          sk: 'MEMBER#psn_01J8XKQ2M4N5P6R7S8T9V0W1X7',
          entity: 'ListMember',
          listId: created.listId,
          personId: 'psn_01J8XKQ2M4N5P6R7S8T9V0W1X7',
          userId: BEN,
          reciprocalPersonId: 'psn_01J8XKQ2M4N5P6R7S8T9V0W1X8',
          displayName: 'Ben',
          role: 'member',
          status: 'active',
          invitedBy: DEV,
          addedAt: NOW,
        },
      }),
    );
    await documents.send(
      new PutCommand({
        TableName: TEST_TABLE,
        Item: {
          pk: `USER#${BEN}`,
          sk: `LIST#${created.listId}`,
          entity: 'ListIndex',
          listId: created.listId,
          userId: BEN,
          role: 'member',
          addedAt: NOW,
        },
      }),
    );

    expect((await del(app(), created.listId)).status).toBe(200);

    expect(await rawItem(`USER#${DEV}`, `LIST#${created.listId}`)).toBeUndefined();
    expect(await rawItem(`USER#${BEN}`, `LIST#${created.listId}`)).toBeUndefined();
    expect(await rawItem(`LIST#${created.listId}`, 'META')).toBeUndefined();
  });

  /**
   * The two states a crash can actually leave behind under the paired cascade, each
   * reconstructed directly and driven through a retried `DELETE`. The state the review
   * feared — a roster row gone while its pointer survives — is unreachable by
   * construction, because the two leave in one transaction.
   */
  describe('resuming a crashed cascade', () => {
    const tombstoneRow = (listId: string) => ({
      pk: `LIST#${listId}`,
      sk: 'TOMBSTONE',
      entity: 'ListTombstone',
      listId,
      ownerId: DEV,
      deletedAt: NOW,
      ttl: Math.floor(Date.parse(NOW) / 1000) + 30 * 24 * 60 * 60,
      createdAt: NOW,
      updatedAt: NOW,
      schemaVersion: 1,
    });

    const seedMemberPair = async (listId: string) => {
      await documents.send(
        new PutCommand({
          TableName: TEST_TABLE,
          Item: {
            pk: `LIST#${listId}`,
            sk: 'MEMBER#psn_01J8XKQ2M4N5P6R7S8T9V0W1X7',
            entity: 'ListMember',
            listId,
            personId: 'psn_01J8XKQ2M4N5P6R7S8T9V0W1X7',
            userId: BEN,
            reciprocalPersonId: 'psn_01J8XKQ2M4N5P6R7S8T9V0W1X8',
            displayName: 'Ben',
            role: 'member',
            status: 'active',
            invitedBy: DEV,
            addedAt: NOW,
          },
        }),
      );
      await documents.send(
        new PutCommand({
          TableName: TEST_TABLE,
          Item: {
            pk: `USER#${BEN}`,
            sk: `LIST#${listId}`,
            entity: 'ListIndex',
            listId,
            userId: BEN,
            role: 'member',
            addedAt: NOW,
          },
        }),
      );
    };

    it('after the tombstone landed but before anything else, stranding no pointer', async () => {
      const created = await createListVia(app(), {});
      await seedMemberPair(created.listId);
      await documents.send(
        new PutCommand({ TableName: TEST_TABLE, Item: tombstoneRow(created.listId) }),
      );

      expect((await del(app(), created.listId)).status).toBe(200);

      expect(
        await rawItem(`LIST#${created.listId}`, 'MEMBER#psn_01J8XKQ2M4N5P6R7S8T9V0W1X7'),
      ).toBeUndefined();
      expect(await rawItem(`USER#${BEN}`, `LIST#${created.listId}`)).toBeUndefined();
      expect(await rawItem(`USER#${DEV}`, `LIST#${created.listId}`)).toBeUndefined();
      expect(await rawItem(`LIST#${created.listId}`, 'META')).toBeUndefined();
    });

    it('after the member pairs left but before the final transaction', async () => {
      const created = await createListVia(app(), {});
      await documents.send(
        new PutCommand({ TableName: TEST_TABLE, Item: tombstoneRow(created.listId) }),
      );

      expect((await del(app(), created.listId)).status).toBe(200);

      expect(await rawItem(`USER#${DEV}`, `LIST#${created.listId}`)).toBeUndefined();
      expect(await rawItem(`LIST#${created.listId}`, 'META')).toBeUndefined();
      // Once complete, a further retry is the honest 404.
      expect((await del(app(), created.listId)).status).toBe(404);
    });
  });
});

describe('durable creation (ADR-055)', () => {
  it('reconciles a lost response by the exact read: 200 adopts the canonical row', async () => {
    const listId = repository.newListId();
    await createListVia(app(), { listId, title: 'Groceries' });

    // The client that never saw the 201 reads its own id.
    const res = await get(app(), `/v1/lists/${listId}`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.list.listId).toBe(listId);
    expect(body.data.list.ownerId).toBe(DEV);
  });

  it('answers 404 for a foreign or tombstoned id on the reconciliation read', async () => {
    const listId = repository.newListId();
    await createListVia(app(), { listId });

    // Foreign: another account probing the id learns nothing.
    expect((await get(asBen(), `/v1/lists/${listId}`)).status).toBe(404);

    // Tombstoned: deleted on another device parks the intent.
    expect((await del(app(), listId)).status).toBe(200);
    expect((await get(app(), `/v1/lists/${listId}`)).status).toBe(404);
  });

  it('create → delete → replay does not resurrect the list', async () => {
    const listId = repository.newListId();
    const key = crypto.randomUUID();
    const first = await post(
      app(),
      '/v1/lists',
      { listId, title: 'Groceries', templateKey: 'groceries' },
      { 'Idempotency-Key': key },
    );
    expect(first.status).toBe(201);
    expect((await del(app(), listId)).status).toBe(200);

    // A replay of the original key returns the stored receipt and writes nothing…
    const replay = await post(
      app(),
      '/v1/lists',
      { listId, title: 'Groceries', templateKey: 'groceries' },
      { 'Idempotency-Key': key },
    );
    expect(replay.status).toBe(201);
    expect(await rawItem(`LIST#${listId}`, 'META')).toBeUndefined();

    // …and a fresh logical attempt after the receipt (a new key) hits the tombstone.
    const fresh = await post(app(), '/v1/lists', {
      listId,
      title: 'Groceries',
      templateKey: 'groceries',
    });
    expect(fresh.status).toBe(409);
    expect(await rawItem(`LIST#${listId}`, 'META')).toBeUndefined();
  });

  it('a foreign collision is metadata-free', async () => {
    const listId = repository.newListId();
    const bensCreate = await post(asBen(), '/v1/lists', {
      listId,
      title: 'Ben’s groceries',
      templateKey: 'groceries',
    });
    expect(bensCreate.status).toBe(201);

    const res = await post(app(), '/v1/lists', {
      listId,
      title: 'Groceries',
      templateKey: 'groceries',
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toBe('That id is already in use. Try again.');
    expect(body.error.details).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(BEN);
    expect(JSON.stringify(body)).not.toContain('Ben’s groceries');
  });
});
