import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';

import type { createApp as CreateApp } from '../app.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
let createApp: typeof CreateApp;

const USER = 'usr_local_dev';
const OWNER = 'usr_list_owner';
const LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const PLAN = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const NOW = '2026-08-23T00:00:00.000Z';

const pointerRow = (role: 'owner' | 'member' = 'owner') => ({
  pk: `USER#${USER}`,
  sk: `LIST#${LIST}`,
  entity: 'ListIndex',
  schemaVersion: 1,
  listId: LIST,
  userId: USER,
  role,
  addedAt: NOW,
});

const listRow = (overrides: Record<string, unknown> = {}) => ({
  pk: `LIST#${LIST}`,
  sk: 'META',
  entity: 'List',
  schemaVersion: 2,
  createdAt: NOW,
  listId: LIST,
  ownerId: OWNER,
  templateKey: 'watch-later',
  title: 'Watch later',
  icon: 'play',
  emptyStateCopy: 'Add something to watch.',
  itemStateMode: {
    mode: 'stages',
    labels: { open: 'Want', active: 'Watching', done: 'Watched' },
    groupByState: true,
  },
  featureConfig: {
    progress: { enabled: true, kind: 'episode' },
    place: { enabled: false },
  },
  slot: null,
  itemCount: 2,
  doneCount: 1,
  memberCount: 1,
  rankVersion: 3,
  itemVersion: 4,
  archived: false,
  updatedAt: NOW,
  lastItemActivityAt: NOW,
  ...overrides,
});

function seed(role: 'owner' | 'member' = 'owner', overrides = {}) {
  const rows = [pointerRow(role), listRow(overrides)];
  const byKey = new Map(rows.map((row) => [`${row.pk}|${row.sk}`, row]));
  ddbMock.on(GetCommand).callsFake((input) => ({
    Item: byKey.get(`${String(input.Key?.pk)}|${String(input.Key?.sk)}`),
  }));
}

function seedWithPlan(role: 'owner' | 'member' = 'owner', overrides = {}) {
  const rows = [
    pointerRow(role),
    listRow(overrides),
    {
      pk: `ACT#${PLAN}`,
      sk: 'META',
      entity: 'Activity',
      activityId: PLAN,
      ownerId: USER,
      objectKind: 'plan',
      type: 'custom',
      status: 'saved',
      title: 'New York Trip',
      participantCount: 0,
      childCount: 0,
      expenseTotalCents: 0,
      visibility: 'private',
      details: { kind: 'custom' },
      icsSequence: 0,
      createdAt: NOW,
      lastActivityAt: NOW,
      updatedAt: NOW,
      schemaVersion: 1,
    },
  ];
  const byKey = new Map(rows.map((row) => [`${row.pk}|${row.sk}`, row]));
  ddbMock.on(GetCommand).callsFake((input) => ({
    Item: byKey.get(`${String(input.Key?.pk)}|${String(input.Key?.sk)}`),
  }));
}

beforeEach(async () => {
  ddbMock.reset();
  ddbMock.on(TransactWriteCommand).resolves({});
  ddbMock.on(PutCommand).resolves({});
  seed();
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

const patch = (
  body: unknown,
  headers: Record<string, string> = {
    'If-Match': NOW,
    'Idempotency-Key': crypto.randomUUID(),
  },
) =>
  createApp().fetch(
    new Request(`http://localhost/v1/lists/${LIST}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );

describe('PATCH /v1/lists/:id', () => {
  it.each([
    [{ 'Idempotency-Key': crypto.randomUUID() }, 'If-Match'],
    [{ 'If-Match': NOW }, 'Idempotency-Key'],
  ])('requires its concurrency and replay headers', async (headers, path) => {
    const res = await patch({ title: 'Queue' }, headers);
    expect(res.status).toBe(400);
    expect((await res.json()).error.details?.[0]?.path).toBe(path);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it.each(['templateKey', 'behaviour', 'capabilities'])(
    'rejects legacy or immutable field %s',
    async (field) => {
      const res = await patch({ [field]: field === 'templateKey' ? 'blank' : {} });
      expect(res.status).toBe(400);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    },
  );

  it('applies presentation and feature settings immediately with a six-second Undo', async () => {
    const before = Date.now();
    const res = await patch({
      itemStateMode: { mode: 'checkbox' },
      featureConfig: { place: { enabled: true } },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.list).toMatchObject({
      itemStateMode: { mode: 'checkbox' },
      featureConfig: {
        progress: { enabled: true, kind: 'episode' },
        place: { enabled: true },
      },
    });
    expect(Date.parse(body.data.undoExpiresAt)).toBeGreaterThanOrEqual(before + 5_000);
    expect(Date.parse(body.data.undoExpiresAt)).toBeLessThanOrEqual(Date.now() + 7_000);
    expect(body.data.undoToken).toEqual(expect.any(String));
  });

  it('patches one feature key without replacing its siblings', async () => {
    const body = await (
      await patch({
        featureConfig: { place: { enabled: true } },
      })
    ).json();
    expect(body.data.list.featureConfig).toEqual({
      progress: { enabled: true, kind: 'episode' },
      place: { enabled: true },
    });
  });

  it('renames immediately and offers the same six-second Undo', async () => {
    const res = await patch({ title: 'Shared queue' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.list.title).toBe('Shared queue');
    expect(body.data.undoToken).toEqual(expect.any(String));
  });

  it('attaches an existing owned List to an owned Plan without an Undo offer', async () => {
    seedWithPlan();

    const res = await patch({ sourceActivityId: PLAN });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      list: expect.objectContaining({ listId: LIST, sourceActivityId: PLAN }),
    });
    const writes =
      ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems;
    expect(
      writes?.some(
        (entry) =>
          entry.Put?.Item?.pk === `ACT#${PLAN}` &&
          entry.Put?.Item?.sk === `SOURCE_LIST#${LIST}`,
      ),
    ).toBe(true);
  });

  it('keeps Plan attachment owner-only and separate from ordinary settings', async () => {
    seedWithPlan('member');
    expect((await patch({ sourceActivityId: PLAN })).status).toBe(403);
    expect((await patch({ sourceActivityId: PLAN, title: 'Packing' })).status).toBe(400);
  });

  it('rejects an empty update', async () => {
    expect((await patch({})).status).toBe(400);
  });

  it('returns current truth without Undo when the patch changes nothing', async () => {
    const res = await patch({ title: 'Watch later' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.list).toMatchObject({ title: 'Watch later', listId: LIST });
    expect(body.data.undoToken).toBeUndefined();
    expect(body.data.undoExpiresAt).toBeUndefined();
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand).length).toBeGreaterThan(0);
  });

  it('returns a conflict for a stale If-Match', async () => {
    const res = await patch(
      { title: 'Queue' },
      { 'If-Match': '2026-08-22T00:00:00.000Z', 'Idempotency-Key': crypto.randomUUID() },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.details?.[0]?.path).toBe('updatedAt');
  });

  it('lets a member rename but rejects owner-only settings', async () => {
    seed('member');
    expect((await patch({ title: 'Shared queue' })).status).toBe(200);
    expect((await patch({ itemStateMode: { mode: 'none' } })).status).toBe(403);
    expect((await patch({ featureConfig: { place: { enabled: true } } })).status).toBe(
      403,
    );
    expect((await patch({ archived: true })).status).toBe(403);
  });

  it('returns 404 when the caller has no pointer', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect((await patch({ title: 'Queue' })).status).toBe(404);
  });
});

describe('the route registry', () => {
  it('contains only the canonical settings PATCH and no behavior action', async () => {
    const { ROUTE_REGISTRY } = await import('../middleware/routeRegistry.js');
    expect(
      ROUTE_REGISTRY.find(
        (entry) => entry.method === 'PATCH' && entry.pattern === '/v1/lists/:id',
      ),
    ).toMatchObject({ mutates: true, auth: 'authenticated' });
    expect(ROUTE_REGISTRY.some((entry) => entry.pattern.includes('behaviour'))).toBe(
      false,
    );
  });
});
