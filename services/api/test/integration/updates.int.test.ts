import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { beforeAll, describe, expect, it } from 'vitest';
import { documents, TEST_TABLE, useTestTable } from './harness.js';

useTestTable();

/**
 * The plan's activity feed against DynamoDB Local (§P3-19).
 *
 * What only a database shows here is ordering and paging over a real sort key — that reading
 * the `UPD#` prefix backwards *is* newest-first, and that a cursor minted at fifty resumes
 * exactly where it stopped — and the transaction shape: that a post moves `lastActivityAt`
 * while leaving `updatedAt` byte-identical, which is the difference between a comment
 * resorting the Needs-a-date stage and a comment `409`ing somebody's open edit sheet.
 */

type AppModule = typeof import('../../src/app.js');
type ActivityRepository = typeof import('../../src/repositories/activityRepository.js');
type Tx = typeof import('../../src/repositories/tx.js');

let createApp: AppModule['createApp'];
let activityRepository: ActivityRepository;
let tx: Tx;

beforeAll(async () => {
  createApp = (await import('../../src/app.js')).createApp;
  activityRepository = await import('../../src/repositories/activityRepository.js');
  tx = await import('../../src/repositories/tx.js');
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

const get = (path: string) => app().fetch(new Request(`http://localhost${path}`));

const del = (path: string) =>
  app().fetch(new Request(`http://localhost${path}`, { method: 'DELETE' }));

const patch = (path: string, body: unknown, ifMatch: string) =>
  app().fetch(
    new Request(`http://localhost${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': ifMatch },
      body: JSON.stringify(body),
    }),
  );

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

const postUpdate = async (activityId: string, body: string) =>
  post(`/v1/activities/${activityId}/updates`, { body });

const metaOf = async (activityId: string) =>
  (
    await documents.send(
      new GetCommand({
        TableName: TEST_TABLE,
        Key: { pk: `ACT#${activityId}`, sk: 'META' },
        ConsistentRead: true,
      }),
    )
  ).Item;

/** Every stored feed row, read straight from the partition. */
const feedRowsOf = async (activityId: string) =>
  (
    await documents.send(
      new QueryCommand({
        TableName: TEST_TABLE,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': `ACT#${activityId}`, ':prefix': 'UPD#' },
        ConsistentRead: true,
      }),
    )
  ).Items ?? [];

describe('posting and reading the feed', () => {
  it('returns entries newest first', async () => {
    const plan = await createPlan();

    for (const body of ['First', 'Second', 'Third']) {
      expect((await postUpdate(plan.activityId, body)).status).toBe(201);
    }

    const page = await dataOf(await get(`/v1/activities/${plan.activityId}/updates`));

    expect(page.updates.map((entry: { body: string }) => entry.body)).toEqual([
      'Third',
      'Second',
      'First',
    ]);
  });

  it('authors the kind, the author and the timestamp', async () => {
    const plan = await createPlan();

    const created = await dataOf(await postUpdate(plan.activityId, 'Booked it.'));

    expect(created.update).toMatchObject({
      kind: 'user',
      authorUserId: 'usr_local_dev',
      body: 'Booked it.',
      activityId: plan.activityId,
    });
    expect(created.update.updateId).toMatch(/^upd_/);
    expect(Date.parse(created.update.createdAt)).not.toBeNaN();
  });

  /** Each of these is a field the server owns; a silent drop would be the wrong answer. */
  it.each([
    ['kind', { kind: 'system' }],
    ['authorUserId', { authorUserId: 'usr_someone_else' }],
    ['createdAt', { createdAt: '2020-01-01T00:00:00.000Z' }],
  ])('400s a client-supplied %s, and writes nothing', async (_field, extra) => {
    const plan = await createPlan();

    const res = await post(`/v1/activities/${plan.activityId}/updates`, {
      body: 'Hi',
      ...extra,
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(await feedRowsOf(plan.activityId)).toEqual([]);
  });

  it.each([
    ['an empty body', ''],
    ['a body past the cap', 'x'.repeat(2001)],
  ])('400s %s', async (_why, body) => {
    const plan = await createPlan();
    expect((await postUpdate(plan.activityId, body)).status).toBe(400);
  });
});

/**
 * The two timestamps, and the whole reason they are two
 * (`feature-to-schema-map.md`, "two timestamps, two jobs").
 */
describe('which timestamp a post moves', () => {
  it('moves lastActivityAt, leaves updatedAt byte-identical, and returns the new value', async () => {
    const plan = await createPlan();
    const before = await metaOf(plan.activityId);

    const created = await dataOf(await postUpdate(plan.activityId, 'Any thoughts?'));

    const after = await metaOf(plan.activityId);
    expect(after?.lastActivityAt).not.toBe(before?.lastActivityAt);
    expect(after?.lastActivityAt).toBe(created.lastActivityAt);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.icsSequence).toBe(before?.icsSequence);
  });

  /**
   * The consequence the split exists for: an owner holding a version from before somebody
   * else's comment must still be able to commit an edit against it.
   */
  it('leaves an open editor’s If-Match still valid', async () => {
    const plan = await createPlan();
    const version = plan.updatedAt;

    await postUpdate(plan.activityId, 'Comment from someone else.');

    const patched = await app().fetch(
      new Request(`http://localhost/v1/activities/${plan.activityId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'If-Match': version },
        body: JSON.stringify({ title: 'Poconos trip, revised' }),
      }),
    );

    expect(patched.status).toBe(200);
  });

  it('does not roll back a prep-task count from META captured before the attach', async () => {
    const plan = await createPlan();
    const before = await activityRepository.getActivityMeta(plan.activityId, {
      consistentRead: true,
    });
    if (before === undefined) throw new Error('Expected the created Plan META row');

    const items: Parameters<typeof activityRepository.touchLastActivity>[3] = [];
    activityRepository.touchLastActivity(
      before,
      '2026-08-26T15:00:00.000Z',
      ['usr_local_dev'],
      items,
    );

    const child = await post('/v1/activities', {
      objectKind: 'task',
      type: 'task',
      title: 'Pack chargers',
      parentActivityId: plan.activityId,
    });
    expect(child.status).toBe(201);

    await tx.transactWrite(items, { operation: 'staleDiscussionTouchTest' });

    expect(await metaOf(plan.activityId)).toMatchObject({
      childCount: 1,
      lastActivityAt: '2026-08-26T15:00:00.000Z',
    });
  });

  /**
   * `#P` sorts on `lastActivityAt`, so the projection has to carry it too — otherwise the
   * Needs-a-date stage stays in the order it had before anyone said anything.
   */
  it('moves the plan to the head of the needs-a-date bucket', async () => {
    const older = await createPlan('Older plan');
    const newer = await createPlan('Newer plan');

    await postUpdate(older.activityId, 'Bumping this one.');

    const bucket = await documents.send(
      new QueryCommand({
        TableName: TEST_TABLE,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :pk',
        ExpressionAttributeValues: { ':pk': 'U#usr_local_dev#P' },
        ScanIndexForward: false,
      }),
    );

    expect((bucket.Items ?? [])[0]?.activityId).toBe(older.activityId);
    expect((bucket.Items ?? [])[1]?.activityId).toBe(newer.activityId);
  });
});

describe('paging', () => {
  it('retains and pages a 60-entry feed after Plan to Task conversion', async () => {
    const plan = await createPlan();
    for (let index = 0; index < 60; index += 1) {
      expect((await postUpdate(plan.activityId, `Entry ${index}`)).status).toBe(201);
    }

    const converted = await patch(
      `/v1/activities/${plan.activityId}`,
      { objectKind: 'task', type: 'task' },
      plan.updatedAt,
    );
    expect(converted.status).toBe(200);

    const detail = await dataOf(await get(`/v1/activities/${plan.activityId}`));
    expect(detail.updates).toHaveLength(50);
    expect(detail.updatesCursor).toBeDefined();

    const first = await dataOf(await get(`/v1/activities/${plan.activityId}/updates`));
    expect(first.updates).toHaveLength(50);
    expect(first.cursor).toBeDefined();
    expect(first.updates[0].body).toBe('Entry 59');

    const second = await dataOf(
      await get(
        `/v1/activities/${plan.activityId}/updates?cursor=${encodeURIComponent(first.cursor)}`,
      ),
    );
    expect(second.updates).toHaveLength(10);
    expect(second.cursor).toBeUndefined();
    expect(second.updates[0].body).toBe('Entry 9');

    // No row appears twice and none is missing: 60 distinct ids across the two pages.
    const ids = [...first.updates, ...second.updates].map(
      (entry: { updateId: string }) => entry.updateId,
    );
    expect(new Set(ids).size).toBe(60);

    const refused = await postUpdate(plan.activityId, 'A new Task entry');
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.message).toBe('Only a plan has an updates feed.');

    const deleted = await del(`/v1/activities/${plan.activityId}/updates/${ids[0]}`);
    expect(deleted.status).toBe(204);
  });

  it('embeds the newest page in activity detail, so opening a plan is one request', async () => {
    const plan = await createPlan();
    for (const body of ['One', 'Two']) await postUpdate(plan.activityId, body);

    const detail = await dataOf(await get(`/v1/activities/${plan.activityId}`));

    expect(detail.updates.map((entry: { body: string }) => entry.body)).toEqual([
      'Two',
      'One',
    ]);
    expect(detail.updatesCursor).toBeUndefined();
  });

  it('embeds a cursor when the feed is longer than a page', async () => {
    const plan = await createPlan();
    for (let index = 0; index < 51; index += 1) {
      await postUpdate(plan.activityId, `Entry ${index}`);
    }

    const detail = await dataOf(await get(`/v1/activities/${plan.activityId}`));

    expect(detail.updates).toHaveLength(50);
    expect(detail.updatesCursor).toBeDefined();
  });
});

describe('deleting an entry', () => {
  it('lets the author delete their own', async () => {
    const plan = await createPlan();
    const created = await dataOf(await postUpdate(plan.activityId, 'Never mind.'));

    const res = await del(
      `/v1/activities/${plan.activityId}/updates/${created.update.updateId}`,
    );

    expect(res.status).toBe(204);
    expect(await feedRowsOf(plan.activityId)).toEqual([]);
  });

  /**
   * A system entry is the record of what happened. `404`, not `403`: the refusal reports
   * nothing about a row the caller may not act on.
   */
  it('404s a system entry and leaves it in place', async () => {
    const plan = await createPlan();
    await app().fetch(
      new Request(`http://localhost/v1/activities/${plan.activityId}/schedule`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ date: '2026-09-05', timezone: 'America/New_York' }),
      }),
    );

    const rows = await feedRowsOf(plan.activityId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('system');

    const res = await del(
      `/v1/activities/${plan.activityId}/updates/${rows[0]?.updateId}`,
    );

    expect(res.status).toBe(404);
    expect(await feedRowsOf(plan.activityId)).toHaveLength(1);
  });

  it('404s an id that does not exist', async () => {
    const plan = await createPlan();
    const res = await del(
      `/v1/activities/${plan.activityId}/updates/upd_01J8XKQ2M4N5P6R7S8T9V0W1X9`,
    );
    expect(res.status).toBe(404);
  });

  it('404s a malformed id rather than failing', async () => {
    const plan = await createPlan();
    expect((await del(`/v1/activities/${plan.activityId}/updates/nonsense`)).status).toBe(
      404,
    );
  });

  it('does not move lastActivityAt', async () => {
    const plan = await createPlan();
    const created = await dataOf(await postUpdate(plan.activityId, 'Never mind.'));
    const before = await metaOf(plan.activityId);

    await del(`/v1/activities/${plan.activityId}/updates/${created.update.updateId}`);

    expect((await metaOf(plan.activityId))?.lastActivityAt).toBe(before?.lastActivityAt);
  });
});

/**
 * System entries: written by the services that own the events, exactly once each, and never
 * by a client (§P3-19, `plans-and-lists.md` §1.4).
 */
describe('system entries', () => {
  const schedule = (activityId: string, body: unknown) =>
    app().fetch(
      new Request(`http://localhost/v1/activities/${activityId}/schedule`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      }),
    );

  it('writes exactly one per date set, date change and time change', async () => {
    const plan = await createPlan();
    const tz = 'America/New_York';

    expect(
      (await schedule(plan.activityId, { date: '2026-09-05', timezone: tz })).status,
    ).toBe(200);
    expect(
      (await schedule(plan.activityId, { date: '2026-09-06', timezone: tz })).status,
    ).toBe(200);
    expect(
      (
        await schedule(plan.activityId, {
          date: '2026-09-06',
          time: '20:00',
          timezone: tz,
        })
      ).status,
    ).toBe(200);

    const bodies = (await feedRowsOf(plan.activityId)).map((row) => row.body);
    expect(bodies).toEqual([
      'Date set to 2026-09-05.',
      'Date changed to 2026-09-06.',
      'Time changed to 20:00.',
    ]);
  });

  /** An idempotent replay writes the same schedule back and must not narrate it twice. */
  it('writes nothing when a schedule write changes nothing', async () => {
    const plan = await createPlan();
    const tz = 'America/New_York';
    await schedule(plan.activityId, { date: '2026-09-05', timezone: tz });

    await schedule(plan.activityId, { date: '2026-09-05', timezone: tz });

    expect(await feedRowsOf(plan.activityId)).toHaveLength(1);
  });

  it('records a completion once, in the same transaction', async () => {
    const plan = await createPlan();

    expect((await post(`/v1/activities/${plan.activityId}/complete`, {})).status).toBe(
      200,
    );

    const rows = await feedRowsOf(plan.activityId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'system', body: 'Marked attended.' });
    expect(rows[0]).not.toHaveProperty('authorUserId');
  });

  /**
   * A system entry is not discussion, so it does not resort Needs a date — the edit that
   * caused it has already moved `updatedAt` through its own path (§3.5, argued in P3-19).
   */
  it('moves neither timestamp', async () => {
    const plan = await createPlan();
    const before = await metaOf(plan.activityId);

    await post(`/v1/activities/${plan.activityId}/complete`, {});

    const after = await metaOf(plan.activityId);
    expect(after?.lastActivityAt).toBe(before?.lastActivityAt);
  });
});

/**
 * Only Plans accept new entries. A Task can still expose retained conversion history, so
 * reading an ordinary Task is an empty successful page rather than a kind error.
 */
describe('only a plan has a feed', () => {
  const createTask = async () => {
    const res = await post('/v1/activities', {
      objectKind: 'task',
      type: 'task',
      title: 'Buy milk',
      schedule: { date: '2026-09-05', timezone: 'America/New_York' },
    });
    expect(res.status).toBe(201);
    return dataOf(res);
  };

  it('400s a post to a task and writes nothing', async () => {
    const task = await createTask();

    const res = await postUpdate(task.activityId, 'Note on a task.');

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Only a plan has an updates feed.');
    expect(await feedRowsOf(task.activityId)).toEqual([]);
  });

  it('returns an empty page when reading a task’s retained-history endpoint', async () => {
    const task = await createTask();
    const res = await get(`/v1/activities/${task.activityId}/updates`);
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toEqual({ updates: [] });
  });

  it('404s an unknown retained-history entry on a task', async () => {
    const task = await createTask();
    const res = await del(
      `/v1/activities/${task.activityId}/updates/upd_01J8XKQ2M4N5P6R7S8T9V0W1X9`,
    );
    expect(res.status).toBe(404);
  });

  it('writes no system entry when a task is rescheduled or completed', async () => {
    const task = await createTask();

    await app().fetch(
      new Request(`http://localhost/v1/activities/${task.activityId}/schedule`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ date: '2026-09-09', timezone: 'America/New_York' }),
      }),
    );
    await post(`/v1/activities/${task.activityId}/complete`, {});

    expect(await feedRowsOf(task.activityId)).toEqual([]);
  });
});

/**
 * Two posts that read the same META. `updatedAt` cannot serialise them — neither moves it,
 * which is the entire point of the split — so the write pins `lastActivityAt` too and the
 * loser retries from fresh truth (P3-19 review).
 */
describe('concurrent posts', () => {
  it('never walks lastActivityAt backwards, and keeps both entries', async () => {
    const plan = await createPlan();

    const [a, b] = await Promise.all([
      postUpdate(plan.activityId, 'First writer'),
      postUpdate(plan.activityId, 'Second writer'),
    ]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const bodies = (await feedRowsOf(plan.activityId)).map((row) => row.body).sort();
    expect(bodies).toEqual(['First writer', 'Second writer']);

    // META holds the later of the two responses, and its index projection agrees.
    const responses = await Promise.all([a.json(), b.json()]);
    const latest = responses
      .map((body) => body.data.lastActivityAt as string)
      .sort()
      .at(-1);
    const meta = await metaOf(plan.activityId);
    expect(meta?.lastActivityAt).toBe(latest);

    const bucket = await documents.send(
      new QueryCommand({
        TableName: TEST_TABLE,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :pk',
        ExpressionAttributeValues: { ':pk': 'U#usr_local_dev#P' },
      }),
    );
    /**
     * Read off `gsi1sk`, not a projected attribute: the `#P` bucket's ordering **is** the sort
     * key `<lastActivityAt>#<activityId>`, and the index's INCLUDE list does not carry the
     * field separately. Asserting the key is asserting the thing that actually orders Plans.
     */
    expect((bucket.Items ?? [])[0]?.gsi1sk).toBe(`${latest}#${plan.activityId}`);
  });

  /** Both deletes get past the read; the loser must answer 404, not the 409 §2.5 has no room for. */
  it('answers 204 then 404 for two deletes of the same entry', async () => {
    const plan = await createPlan();
    const created = await dataOf(await postUpdate(plan.activityId, 'Never mind.'));
    const path = `/v1/activities/${plan.activityId}/updates/${created.update.updateId}`;

    const [first, second] = await Promise.all([del(path), del(path)]);

    expect([first.status, second.status].sort()).toEqual([204, 404]);
    expect(await feedRowsOf(plan.activityId)).toEqual([]);
  });
});

describe('authorisation', () => {
  const asStranger = () =>
    createApp({
      identityProvider: { resolve: () => Promise.resolve('usr_stranger') },
    });

  it('404s the feed of a plan the caller cannot read, and never reads it', async () => {
    const plan = await createPlan();
    await postUpdate(plan.activityId, 'Private note.');

    const res = await asStranger().fetch(
      new Request(`http://localhost/v1/activities/${plan.activityId}/updates`),
    );

    expect(res.status).toBe(404);
  });

  it('404s a post from a stranger and writes nothing', async () => {
    const plan = await createPlan();

    const res = await asStranger().fetch(
      new Request(`http://localhost/v1/activities/${plan.activityId}/updates`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ body: 'Hello' }),
      }),
    );

    expect(res.status).toBe(404);
    expect(await feedRowsOf(plan.activityId)).toEqual([]);
  });
});
