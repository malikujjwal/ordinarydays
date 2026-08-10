import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
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

/** `PATCH /v1/activities/:id` (P1-13). */
const ddbMock = mockClient(DynamoDBDocumentClient);

let createApp: typeof CreateApp;

const DEV = 'usr_local_dev';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const VERSION = '2026-08-09T00:00:00.000Z';

const meta = (overrides: Record<string, unknown> = {}) => ({
  pk: `ACT#${ACT}`,
  sk: 'META',
  entity: 'Activity',
  activityId: ACT,
  ownerId: DEV,
  status: 'saved',
  objectKind: 'task',
  type: 'task',
  title: 'Buy milk',
  details: { kind: 'task' },
  participantCount: 0,
  childCount: 0,
  expenseTotalCents: 0,
  visibility: 'private',
  icsSequence: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  lastActivityAt: '2026-08-05T00:00:00.000Z',
  updatedAt: VERSION,
  schemaVersion: 1,
  ...overrides,
});

const seed = (row: Record<string, unknown> = meta()) => {
  ddbMock.on(GetCommand).resolves({ Item: row as never });
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(TransactWriteCommand).resolves({});
};

beforeEach(async () => {
  ddbMock.reset();
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

const patch = (
  app: ReturnType<typeof CreateApp>,
  body: unknown,
  headers: Record<string, string> = { 'If-Match': VERSION },
) =>
  app.fetch(
    new Request(`http://localhost/v1/activities/${ACT}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );

const asUser = (userId: string) =>
  createApp({ identityProvider: { resolve: () => Promise.resolve(userId) } });

/** The canonical row as it was written, picked out of the transaction. */
const written = () => {
  const items = (ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0]?.input
    .TransactItems ?? []) as Array<{
    Put?: { Item?: Record<string, unknown>; ConditionExpression?: string };
  }>;
  return items.find((entry) => entry.Put?.Item?.entity === 'Activity')?.Put;
};

const indexEntry = () => {
  const items = (ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0]?.input
    .TransactItems ?? []) as Array<{ Put?: { Item?: Record<string, unknown> } }>;
  return items.find((entry) => entry.Put?.Item?.entity === 'ActivityIndex')?.Put?.Item;
};

describe('an ordinary patch', () => {
  it.each(['lastActivityAt', 'updatedAt'])(
    '400s client-supplied server-derived %s',
    async (field) => {
      seed();

      const res = await patch(createApp(), {
        [field]: '2026-08-10T00:00:00.000Z',
      });

      expect(res.status).toBe(400);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    },
  );

  it('applies the change and returns the updated activity', async () => {
    seed();

    const res = await patch(createApp(), { title: 'Buy oat milk' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.title).toBe('Buy oat milk');
    expect(body.meta.requestId).toMatch(/^req_/);
  });

  it('bumps updatedAt', async () => {
    seed();

    const body = await (await patch(createApp(), { title: 'Buy oat milk' })).json();

    expect(body.data.updatedAt).not.toBe(VERSION);
    expect(Date.parse(body.data.updatedAt)).toBeGreaterThan(Date.parse(VERSION));
  });

  it('leaves the fields it was not given alone', async () => {
    seed(meta({ notes: 'Semi-skimmed' }));

    const body = await (await patch(createApp(), { title: 'Buy oat milk' })).json();

    expect(body.data.notes).toBe('Semi-skimmed');
    expect(body.data.createdAt).toBe('2026-08-01T00:00:00.000Z');
    expect(body.data.lastActivityAt).toBe('2026-08-05T00:00:00.000Z');
  });

  /**
   * **A conditional write, not a read-then-write.** The condition on the item itself is the
   * only thing that closes the window between this request reading and writing; without it,
   * two overlapping edits silently overwrite each other.
   */
  it('writes conditionally on the version the client sent', async () => {
    seed();

    await patch(createApp(), { title: 'Buy oat milk' });

    expect(written()?.ConditionExpression).toContain('updatedAt');
    expect(
      ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0]?.input.TransactItems?.[0],
    ).toBeDefined();
  });

  it('never returns the storage attributes', async () => {
    seed();

    const body = await (await patch(createApp(), { title: 'x' })).json();

    expect(body.data).not.toHaveProperty('pk');
    expect(body.data).not.toHaveProperty('sk');
    expect(body.data).not.toHaveProperty('entity');
  });
});

describe('If-Match', () => {
  it('400s when the header is missing, and writes nothing', async () => {
    seed();

    const res = await patch(createApp(), { title: 'x' }, {});
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(JSON.stringify(body.error.details)).toContain('If-Match');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('400s on an empty header', async () => {
    seed();

    const res = await patch(createApp(), { title: 'x' }, { 'If-Match': '   ' });

    expect(res.status).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  /** The `409` carries the current value, so the client can refetch and re-apply. */
  it('409s on a stale version and names the current one', async () => {
    seed();

    const res = await patch(
      createApp(),
      { title: 'x' },
      { 'If-Match': '2026-08-01T00:00:00.000Z' },
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('conflict');
    expect(body.error.details).toEqual([{ path: 'updatedAt', message: VERSION }]);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  /** RFC 9110 quotes an entity tag; our own client sends the raw value. Both work. */
  it.each([
    ['bare', VERSION],
    ['quoted', `"${VERSION}"`],
    ['weak', `W/"${VERSION}"`],
  ])('accepts a %s entity tag', async (_form, header) => {
    seed();

    expect(
      (await patch(createApp(), { title: 'x' }, { 'If-Match': header })).status,
    ).toBe(200);
  });
});

describe('who may patch what', () => {
  /** A stranger gets `404`, never `403` — a guessed id must not confirm anything exists. */
  it('404s for a caller with no relationship', async () => {
    seed();

    const res = await patch(asUser('usr_stranger'), { title: 'x' });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('404s for an activity that does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});

    expect((await patch(createApp(), { title: 'x' })).status).toBe(404);
  });

  /**
   * A participant may not rename or reschedule somebody else's plan — refused in `authz.ts`,
   * and `403` rather than `404` because they can already see it.
   */
  it.each(['title', 'schedule', 'location', 'objectKind', 'type'])(
    '403s a participant patching %s',
    async (field) => {
      const bodies: Record<string, unknown> = {
        title: { title: 'Renamed' },
        schedule: { schedule: { date: '2026-09-01', timezone: 'UTC' } },
        location: { location: { label: 'Elsewhere' } },
        objectKind: { objectKind: 'plan', type: 'event' },
        type: { objectKind: 'plan', type: 'meal' },
      };

      ddbMock.on(GetCommand).resolves({
        Item: meta({
          objectKind: 'plan',
          type: 'event',
          details: { kind: 'event' },
        }) as never,
      });
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { entity: 'Participant', personId: 'psn_x', userId: 'usr_participant' },
        ] as never,
      });
      ddbMock.on(TransactWriteCommand).resolves({});

      const res = await patch(asUser('usr_participant'), bodies[field]);

      expect(res.status).toBe(403);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    },
  );

  it('lets a participant patch a field that is not restricted', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: meta({
        objectKind: 'plan',
        type: 'event',
        details: { kind: 'event' },
      }) as never,
    });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { entity: 'Participant', personId: 'psn_x', userId: 'usr_participant' },
      ] as never,
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    const res = await patch(asUser('usr_participant'), { notes: 'Running late' });

    expect(res.status).toBe(200);
  });
});

/**
 * A patch that adds or clears a date moves the activity between GSI1 buckets, so the index
 * entry is rewritten as a whole item in the same transaction (P1-09).
 */
describe('a schedule change moves the bucket', () => {
  it('sets status to scheduled and puts the entry in #S', async () => {
    seed();

    const body = await (
      await patch(createApp(), {
        schedule: { date: '2026-08-15', time: '19:30', timezone: 'America/New_York' },
      })
    ).json();

    expect(body.data.status).toBe('scheduled');
    expect(body.data.schedule.scheduledAtUtc).toBe('2026-08-15T23:30:00.000Z');
    expect(indexEntry()?.gsi1pk).toBe(`U#${DEV}#S`);
  });

  /** `schedule: null` is the unschedule path, and it returns a Task to Anytime. */
  it('clearing the date sets status to saved and moves a task to #N', async () => {
    seed(
      meta({
        status: 'scheduled',
        schedule: { date: '2026-08-15', timezone: 'America/New_York' },
      }),
    );

    const body = await (await patch(createApp(), { schedule: null })).json();

    expect(body.data.status).toBe('saved');
    expect(body.data).not.toHaveProperty('schedule');
    expect(indexEntry()?.gsi1pk).toBe(`U#${DEV}#N`);
  });

  /** An undated **plan** goes to Needs a date, not Anytime — the same clear, a different bucket. */
  it('clearing the date on a plan moves it to #P', async () => {
    seed(
      meta({
        objectKind: 'plan',
        type: 'custom',
        details: { kind: 'custom' },
        status: 'scheduled',
        schedule: { date: '2026-08-15', timezone: 'UTC' },
      }),
    );

    await patch(createApp(), { schedule: null });

    expect(indexEntry()?.gsi1pk).toBe(`U#${DEV}#P`);
  });

  /** `time: null` clears the time and keeps the date — a timed activity becomes all-day. */
  it('clearing just the time leaves the date and derives no instant', async () => {
    seed(
      meta({
        status: 'scheduled',
        schedule: {
          date: '2026-08-15',
          time: '19:30',
          timezone: 'UTC',
          scheduledAtUtc: '2026-08-15T19:30:00.000Z',
        },
      }),
    );

    const body = await (
      await patch(createApp(), {
        schedule: { date: '2026-08-15', time: null, timezone: 'UTC' },
      })
    ).json();

    expect(body.data.schedule).toEqual({ date: '2026-08-15', timezone: 'UTC' });
    expect(body.data.status).toBe('scheduled');
  });
});

/** The conversion runs P1-17 server-side; the handler never re-derives the mapping. */
describe('changing the object or Plan kind', () => {
  const watch = () =>
    meta({
      objectKind: 'plan',
      type: 'watch',
      title: 'Severance',
      notes: 'Start from the beginning',
      schedule: { date: '2026-08-15', timezone: 'UTC' },
      details: {
        kind: 'watch',
        mediaTitle: 'Severance',
        season: 2,
        episode: 4,
        service: 'Apple TV+',
      },
    });

  it('drops the type-specific payload and keeps the common fields', async () => {
    seed(watch());

    const body = await (
      await patch(createApp(), { objectKind: 'task', type: 'task' })
    ).json();

    expect(body.data.objectKind).toBe('task');
    expect(body.data.type).toBe('task');
    expect(body.data.details).toEqual({ kind: 'task' });
    expect(body.data.title).toBe('Severance');
    expect(body.data.notes).toBe('Start from the beginning');
    expect(body.data.schedule.date).toBe('2026-08-15');
  });

  /** §6.3 point 8: a conversion never touches these three. */
  it('leaves status, completedAt and outcome untouched', async () => {
    seed(
      meta({
        objectKind: 'plan',
        type: 'event',
        details: { kind: 'event' },
        status: 'completed',
        completedAt: '2026-08-10T00:00:00.000Z',
        outcome: 'attended',
      }),
    );

    const body = await (
      await patch(createApp(), { objectKind: 'plan', type: 'custom' })
    ).json();

    expect(body.data.status).toBe('completed');
    expect(body.data.completedAt).toBe('2026-08-10T00:00:00.000Z');
    expect(body.data.outcome).toBe('attended');
  });

  /**
   * §6.3 point 3: blocked while the plan has coordinated data, and it names what must go
   * first rather than deleting it.
   */
  it('409s a Plan → Task conversion with a participant, and writes nothing', async () => {
    seed(
      meta({
        objectKind: 'plan',
        type: 'custom',
        details: { kind: 'custom' },
        participantCount: 1,
      }),
    );

    const res = await patch(createApp(), { objectKind: 'task', type: 'task' });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.message).toBe('Remove 1 person before changing this to a Task.');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('409s on prep tasks and expenses too, naming each', async () => {
    seed(
      meta({
        objectKind: 'plan',
        type: 'custom',
        details: { kind: 'custom' },
        participantCount: 2,
        expenseTotalCents: 1500,
        childCount: 1,
      }),
    );

    const body = await (
      await patch(createApp(), { objectKind: 'task', type: 'task' })
    ).json();

    expect(body.error.message).toBe(
      'Remove 2 people, the expenses on it and 1 prep task before changing this to a Task.',
    );
  });

  /** `objectKind` alone never lets the server choose a type. */
  it.each([
    ['objectKind alone', { objectKind: 'plan' }],
    ['type alone', { type: 'meal' }],
  ])('400s %s', async (_why, body) => {
    seed();

    const res = await patch(createApp(), body);

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  /** Re-sending the current pair alongside an edit is ordinary, and must not drop anything. */
  it('does not touch details when the kind is unchanged', async () => {
    seed(watch());

    const body = await (
      await patch(createApp(), {
        objectKind: 'plan',
        type: 'watch',
        title: 'Severance S2',
      })
    ).json();

    expect(body.data.title).toBe('Severance S2');
    expect(body.data.details).toEqual({
      kind: 'watch',
      mediaTitle: 'Severance',
      season: 2,
      episode: 4,
      service: 'Apple TV+',
    });
  });
});

describe('what a patch may not set', () => {
  it.each([
    'ownerId',
    'activityId',
    'createdAt',
    'participantCount',
    'visibility',
    'icsSequence',
  ])('400s a client-supplied %s', async (field) => {
    seed();

    const res = await patch(createApp(), { [field]: 'anything' });

    expect(res.status).toBe(400);
    expect(JSON.stringify((await res.json()).error.details)).toContain(field);
  });

  it.each(['completed', 'skipped', 'saved', 'scheduled'])(
    '400s status: %s',
    async (status) => {
      seed();

      expect((await patch(createApp(), { status })).status).toBe(400);
    },
  );

  it('accepts cancelled, the one status a client may set', async () => {
    seed();

    const body = await (await patch(createApp(), { status: 'cancelled' })).json();

    expect(body.data.status).toBe('cancelled');
  });
});
