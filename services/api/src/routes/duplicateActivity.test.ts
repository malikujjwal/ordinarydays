import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { MAX_TITLE_LEN } from '@od/shared/constants';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';

import type { createApp as CreateApp } from '../app.js';

/** `POST /v1/activities/:id/duplicate` (P1-15). */
const ddbMock = mockClient(DynamoDBDocumentClient);

let createApp: typeof CreateApp;

const DEV = 'usr_local_dev';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';

/**
 * A source with **every** droppable field populated, so a copy that carried one by accident
 * fails rather than passing because the fixture was thin.
 */
const source = (overrides: Record<string, unknown> = {}) => ({
  pk: `ACT#${ACT}`,
  sk: 'META',
  entity: 'Activity',
  activityId: ACT,
  ownerId: DEV,
  status: 'completed',
  completedAt: '2026-08-10T00:00:00.000Z',
  outcome: 'watched',
  objectKind: 'plan',
  type: 'watch',
  title: 'Severance',
  notes: 'Start from the beginning',
  details: { kind: 'watch', mediaTitle: 'Severance', season: 2, episode: 4 },
  location: { label: 'Living room' },
  schedule: {
    date: '2026-08-15',
    time: '19:30',
    timezone: 'UTC',
    scheduledAtUtc: '2026-08-15T19:30:00.000Z',
  },
  recurrence: {
    mode: 'fixed',
    segments: [{ freq: 'weekly', effectiveFrom: '2026-08-01' }],
  },
  sourceUrl: 'https://example.com',
  parentActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1XB',
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1XC',
  listItemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1XD',
  primaryAttachmentId: 'att_01J8XKQ2M4N5P6R7S8T9V0W1XE',
  participantCount: 3,
  childCount: 2,
  expenseTotalCents: 4500,
  visibility: 'shared',
  icsSequence: 7,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
  schemaVersion: 1,
  ...overrides,
});

const seed = (row: Record<string, unknown> = source()) => {
  ddbMock.on(GetCommand).resolves({ Item: row as never });
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(TransactWriteCommand).resolves({});
};

beforeEach(async () => {
  ddbMock.reset();
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

const duplicate = (
  app: ReturnType<typeof CreateApp>,
  headers: Record<string, string> = { 'Idempotency-Key': crypto.randomUUID() },
) =>
  app.fetch(
    new Request(`http://localhost/v1/activities/${ACT}/duplicate`, {
      method: 'POST',
      headers,
    }),
  );

const asUser = (userId: string) =>
  createApp({ identityProvider: { resolve: () => Promise.resolve(userId) } });

/** The copy as it was written, picked out of the transaction. */
const writtenCopy = () => {
  const items = (ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0]?.input
    .TransactItems ?? []) as Array<{ Put?: { Item?: Record<string, unknown> } }>;
  return items.find((entry) => entry.Put?.Item?.entity === 'Activity')?.Put?.Item;
};

describe('what the copy carries', () => {
  it('returns 201 with a new activity', async () => {
    seed();

    const res = await duplicate(createApp());
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.activityId).toMatch(/^act_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(body.data.activityId).not.toBe(ACT);
    expect(body.meta.requestId).toMatch(/^req_/);
  });

  it('copies the six fields §7.1 names', async () => {
    seed();

    const body = await (await duplicate(createApp())).json();

    expect(body.data).toMatchObject({
      objectKind: 'plan',
      type: 'watch',
      notes: 'Start from the beginning',
      location: { label: 'Living room' },
      details: { kind: 'watch', mediaTitle: 'Severance', season: 2, episode: 4 },
    });
  });

  it('suffixes the title', async () => {
    seed();

    const body = await (await duplicate(createApp())).json();

    expect(body.data.title).toBe('Severance (copy)');
  });

  it('is owned by the caller and starts private', async () => {
    seed();

    const body = await (await duplicate(createApp())).json();

    expect(body.data.ownerId).toBe(DEV);
    expect(body.data.visibility).toBe('private');
  });

  it('returns a body the shared activity schema accepts', async () => {
    const { activity } = await import('@od/shared/schemas');
    seed();

    const body = await (await duplicate(createApp())).json();

    expect(activity.safeParse(body.data).success).toBe(true);
  });

  it('never returns the storage attributes', async () => {
    seed();

    const body = await (await duplicate(createApp())).json();

    expect(body.data).not.toHaveProperty('pk');
    expect(body.data).not.toHaveProperty('sk');
    expect(body.data).not.toHaveProperty('entity');
  });
});

/**
 * **The list that matters.** Each of these is a decision in `activities.md` §7.1, not an
 * omission: participants because re-inviting is a deliberate act, reminders because the copy
 * has no schedule to offset one from, prep children and lists because copying structure is
 * auto-creation by another name.
 */
describe('what the copy deliberately drops', () => {
  it.each([
    'schedule',
    'recurrence',
    'sourceUrl',
    'parentActivityId',
    'listId',
    'listItemId',
    'primaryAttachmentId',
    'completedAt',
    'outcome',
  ])('does not carry %s', async (field) => {
    seed();

    const body = await (await duplicate(createApp())).json();

    expect(body.data).not.toHaveProperty(field);
  });

  it('resets the counters rather than copying them', async () => {
    seed();

    const body = await (await duplicate(createApp())).json();

    expect(body.data).toMatchObject({
      participantCount: 0,
      childCount: 0,
      expenseTotalCents: 0,
      icsSequence: 0,
    });
  });

  /** Completion state is not copied, so a copy of a finished thing is not finished. */
  it('is saved, whatever the source status was', async () => {
    seed();

    const body = await (await duplicate(createApp())).json();

    expect(body.data.status).toBe('saved');
  });

  /** No schedule means no reminder to offset from — nothing but the two rows is written. */
  it('writes no reminder rows', async () => {
    seed();

    await duplicate(createApp());

    const items = (ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0]?.input
      .TransactItems ?? []) as Array<{ Put?: { Item?: Record<string, unknown> } }>;

    // The `undefined` a ConditionCheck would contribute is filtered: it writes no item.
    expect(
      items
        .map((entry) => entry.Put?.Item?.entity)
        .filter((entity) => entity !== undefined)
        .sort(),
    ).toEqual(['Activity', 'ActivityIndex', 'Idempotency']);
  });

  /** No `parentActivityId`, so no `SUB#` pointer on somebody else's plan. */
  it('does not attach itself to the source’s parent plan', async () => {
    seed();

    await duplicate(createApp());

    expect(writtenCopy()).not.toHaveProperty('parentActivityId');
  });

  it('gets its own timestamps', async () => {
    seed();

    const body = await (await duplicate(createApp())).json();

    expect(body.data.createdAt).not.toBe('2026-08-01T00:00:00.000Z');
    expect(body.data.createdAt).toBe(body.data.updatedAt);
  });
});

/**
 * A maximum-length title plus the suffix exceeds the schema's bound, so the copy would be
 * unsaveable. The base is truncated and the suffix kept — it is what tells the user which one
 * is the copy. No doc covers this.
 */
describe('a title at the length limit', () => {
  it('truncates the base so the suffix still fits', async () => {
    seed(source({ title: 'x'.repeat(MAX_TITLE_LEN) }));

    const body = await (await duplicate(createApp())).json();

    expect(body.data.title.length).toBe(MAX_TITLE_LEN);
    expect(body.data.title.endsWith(' (copy)')).toBe(true);
  });

  it('leaves a short title alone apart from the suffix', async () => {
    seed(source({ title: 'Gym' }));

    const body = await (await duplicate(createApp())).json();

    expect(body.data.title).toBe('Gym (copy)');
  });
});

describe('who may duplicate', () => {
  /**
   * `read`, not `owner`. The copy belongs to the caller, carries no participants and has no
   * relationship to the original, so copying something you can see costs its owner nothing.
   * `api-contract.md` §2.3 leaves this row's notes empty — flagged in the pull request.
   */
  it('lets a participant copy a plan they are on, into their own partition', async () => {
    seed();
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { entity: 'Participant', personId: 'psn_x', userId: 'usr_participant' },
      ] as never,
    });

    const res = await duplicate(asUser('usr_participant'));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.ownerId).toBe('usr_participant');
    expect(body.data.participantCount).toBe(0);
  });

  it('404s a stranger, and writes nothing', async () => {
    seed();

    const res = await duplicate(asUser('usr_stranger'));

    expect(res.status).toBe(404);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('404s an activity that does not exist', async () => {
    // Not `seed(undefined)`: passing `undefined` explicitly still takes the default
    // parameter, so that would have seeded the full source and quietly asserted nothing.
    seed();
    ddbMock.on(GetCommand).resolves({});

    expect((await duplicate(createApp())).status).toBe(404);
  });
});

/**
 * The registry entry carries `mutates: true`. A retried duplicate is precisely the request where
 * "it worked but I did not hear back" produces two identical activities.
 */
describe('the Idempotency-Key', () => {
  it('is required', async () => {
    seed();

    const res = await duplicate(createApp(), {});

    expect(res.status).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('is rejected when it is not a UUID', async () => {
    seed();

    const res = await duplicate(createApp(), { 'Idempotency-Key': 'not-a-uuid' });

    expect(res.status).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
