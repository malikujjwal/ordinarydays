import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { List } from '@od/shared/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { documents, TEST_TABLE, useTestTable } from './harness.js';

useTestTable();

/**
 * Deleting a Plan that sourced Lists, against DynamoDB Local (§P3-49).
 *
 * The property is a two-way link staying symmetric across a destructive write. The List half
 * already shipped — deleting a List removes its `SOURCE_LIST#` projection — and the Plan half
 * did not, so a deleted Plan left a List whose provenance named an activity that no longer
 * existed, with the reverse pointer that could have found it destroyed in the same pass.
 *
 * Only a database shows this: it needs the real cascade, in its real order, over rows that
 * have to survive it. And they do have to survive it — a trip being cancelled is not a reason
 * to lose the packing list.
 */

type AppModule = typeof import('../../src/app.js');

let createApp: AppModule['createApp'];

beforeAll(async () => {
  createApp = (await import('../../src/app.js')).createApp;
});

const app = () => createApp();

const post = (path: string, body: unknown) =>
  app().fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    }),
  );

const del = (path: string) =>
  app().fetch(new Request(`http://localhost${path}`, { method: 'DELETE' }));

const dataOf = async (response: Response) => (await response.json()).data;

const createPlan = async (title = 'Poconos trip') => {
  const res = await post('/v1/activities', {
    objectKind: 'plan',
    type: 'event',
    title,
  });
  expect(res.status).toBe(201);
  return dataOf(res);
};

const createSourcedList = async (
  sourceActivityId: string,
  title = 'Packing',
): Promise<List> => {
  const res = await post('/v1/lists', {
    title,
    templateKey: 'packing',
    sourceActivityId,
  });
  expect(res.status).toBe(201);
  return dataOf(res);
};

const addItem = async (listId: string, title: string) => {
  const res = await post(`/v1/lists/${listId}/items`, { title });
  expect(res.status).toBe(201);
  return dataOf(res);
};

/** The stored List META, read strongly and without going through an access grant. */
const listMetaOf = async (listId: string) =>
  (
    await documents.send(
      new GetCommand({
        TableName: TEST_TABLE,
        Key: { pk: `LIST#${listId}`, sk: 'META' },
        ConsistentRead: true,
      }),
    )
  ).Item;

/** The id-only reverse projections in the Activity's own partition. */
const projectionsOf = async (activityId: string) =>
  (
    await documents.send(
      new QueryCommand({
        TableName: TEST_TABLE,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `ACT#${activityId}`,
          ':prefix': 'SOURCE_LIST#',
        },
        ConsistentRead: true,
      }),
    )
  ).Items ?? [];

describe('deleting a plan that sourced lists', () => {
  it('leaves the list and its items intact, with the back-link and projection gone', async () => {
    const plan = await createPlan();
    const list = await createSourcedList(plan.activityId);
    await addItem(list.listId, 'Boots');
    await addItem(list.listId, 'Passport');

    expect((await listMetaOf(list.listId))?.sourceActivityId).toBe(plan.activityId);
    expect(await projectionsOf(plan.activityId)).toHaveLength(1);

    expect((await del(`/v1/activities/${plan.activityId}`)).status).toBe(200);

    const survivor = await listMetaOf(list.listId);
    expect(survivor).toBeDefined();
    expect(survivor).not.toHaveProperty('sourceActivityId');
    expect(survivor?.title).toBe('Packing');
    expect(survivor?.itemCount).toBe(2);
    expect(await projectionsOf(plan.activityId)).toEqual([]);
  });

  it('clears every list a plan sourced, not just the first', async () => {
    const plan = await createPlan();
    const packing = await createSourcedList(plan.activityId, 'Packing');
    const shopping = await createSourcedList(plan.activityId, 'Trip shopping');

    expect(await projectionsOf(plan.activityId)).toHaveLength(2);

    expect((await del(`/v1/activities/${plan.activityId}`)).status).toBe(200);

    for (const listId of [packing.listId, shopping.listId]) {
      const survivor = await listMetaOf(listId);
      expect(survivor).toBeDefined();
      expect(survivor).not.toHaveProperty('sourceActivityId');
    }
  });

  /**
   * Why the condition names the Plan rather than merely asserting the attribute is present: a
   * List re-sourced to another Plan belongs to that one now, and the first Plan's deletion has
   * no business clearing it.
   */
  it('leaves a list that has since been re-sourced to another plan', async () => {
    const first = await createPlan('Poconos trip');
    const second = await createPlan('Catskills trip');
    const list = await createSourcedList(first.activityId);

    // Re-sourced by hand: this phase has no detach route, and what is under test is the
    // condition on the clear rather than the endpoint that would move the pointer.
    const stored = await listMetaOf(list.listId);
    await documents.send(
      new PutCommand({
        TableName: TEST_TABLE,
        Item: { ...stored, sourceActivityId: second.activityId },
      }),
    );

    // Asserted, not fired and forgotten: a cascade that 500s would leave the pointer alone
    // too, and this test would pass for the opposite of the reason it exists.
    expect((await del(`/v1/activities/${first.activityId}`)).status).toBe(200);

    expect((await listMetaOf(list.listId))?.sourceActivityId).toBe(second.activityId);
  });

  /**
   * The clear must not freshen the List's concurrency token. The behaviour-migration finisher
   * pins `expectedUpdatedAt` in its durable work record, so a bumped version fails that
   * condition **permanently** — the retry re-reads the same stored value — stranding the
   * marker and gating every item read and mutation into `503` for ever. Byte-identical is the
   * assertion, not "near enough".
   */
  it('leaves updatedAt, rankVersion and itemVersion byte-identical', async () => {
    const plan = await createPlan();
    const list = await createSourcedList(plan.activityId);
    await addItem(list.listId, 'Boots');

    const before = await listMetaOf(list.listId);

    expect((await del(`/v1/activities/${plan.activityId}`)).status).toBe(200);

    const after = await listMetaOf(list.listId);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.rankVersion).toBe(before?.rankVersion);
    expect(after?.itemVersion).toBe(before?.itemVersion);
  });

  it('is safe to replay: a second delete changes nothing', async () => {
    const plan = await createPlan();
    const list = await createSourcedList(plan.activityId);

    expect((await del(`/v1/activities/${plan.activityId}`)).status).toBe(200);
    const afterFirst = await listMetaOf(list.listId);

    expect((await del(`/v1/activities/${plan.activityId}`)).status).toBe(404);
    expect(await listMetaOf(list.listId)).toEqual(afterFirst);
  });

  it('writes nothing extra for a plan that sourced no lists', async () => {
    const plan = await createPlan();

    expect(await projectionsOf(plan.activityId)).toEqual([]);
    expect((await del(`/v1/activities/${plan.activityId}`)).status).toBe(200);
  });

  /** The other direction, unchanged by this task and asserted so it stays that way. */
  it('still removes the projection when the list is the one deleted', async () => {
    const plan = await createPlan();
    const list = await createSourcedList(plan.activityId);

    expect((await del(`/v1/lists/${list.listId}`)).status).toBe(200);

    expect(await projectionsOf(plan.activityId)).toEqual([]);
    const survivingPlan = await documents.send(
      new GetCommand({
        TableName: TEST_TABLE,
        Key: { pk: `ACT#${plan.activityId}`, sk: 'META' },
        ConsistentRead: true,
      }),
    );
    expect(survivingPlan.Item?.activityId).toBe(plan.activityId);
  });
});
