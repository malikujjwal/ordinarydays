import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';

import type { createApp as CreateApp } from '../app.js';

/**
 * `/v1/capture/*` — the `501` stubs (P1-18).
 *
 * The assertion that carries this file is the **ordering**: a malformed body is `400` and a
 * well-formed one is `501`. That is what proves validation ran, and validation running from
 * Phase 1 is the entire reason these stubs exist rather than the paths being left unmounted.
 */
const ddbMock = mockClient(DynamoDBDocumentClient);

let createApp: typeof CreateApp;

beforeEach(async () => {
  ddbMock.reset();
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

const TASK_TARGET = { objectKind: 'task', type: 'task' } as const;

/** One well-formed body per route, so each can be varied independently. */
const VALID = {
  parse: {
    text: 'Dinner with Sam on Friday',
    tz: 'America/New_York',
    creationTarget: TASK_TARGET,
  },
  extract: {
    attachmentId: 'att_01J8XKQ2M4N5P6R7S8T9V0W1X2',
    creationTarget: TASK_TARGET,
  },
  link: { url: 'https://example.com/recipe', creationTarget: TASK_TARGET },
} as const;

type Route = keyof typeof VALID;
const ROUTES = Object.keys(VALID) as Route[];

const post = (route: Route, body: unknown) =>
  createApp().fetch(
    new Request(`http://localhost/v1/capture/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('a well-formed request', () => {
  it.each(ROUTES)('%s answers 501 with the closed-enum code', async (route) => {
    const res = await post(route, VALID[route]);
    const body = await res.json();

    expect(res.status).toBe(501);
    expect(body.error.code).toBe('not_implemented');
    expect(body.error.requestId).toMatch(/^req_/);
  });

  /** The message says *not yet*, and never names a phase — a user does not know what Phase 8 is. */
  it.each(ROUTES)('%s says it is not available yet, in plain words', async (route) => {
    const body = await (await post(route, VALID[route])).json();

    expect(body.error.message).toBe('Capture is not available yet.');
    expect(body.error.message).not.toMatch(/phase|stub|todo/i);
  });

  it.each(ROUTES)('%s touches nothing but the rate-limit counter', async (route) => {
    await post(route, VALID[route]);

    const keys = ddbMock
      .calls()
      .map((call) => (call.args[0].input as { Key?: { pk?: string } }).Key?.pk)
      .filter((pk): pk is string => typeof pk === 'string');

    // Asserted non-empty first, so this cannot pass by the route having made no calls at
    // all and `every` being vacuously true — the point is that the *only* write is the
    // limiter's, not that nothing ran.
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((pk) => !pk.startsWith('RATE#'))).toEqual([]);
  });

  /** Every valid target reaches the stub unchanged — the stub judges none of them. */
  it.each([
    ['a task', { objectKind: 'task', type: 'task' }],
    ['a plan', { objectKind: 'plan', type: 'event' }],
    ['a list item', { objectKind: 'listItem', listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2' }],
  ])('reaches the 501 for %s', async (_why, creationTarget) => {
    const res = await post('parse', { ...VALID.parse, creationTarget });

    expect(res.status).toBe(501);
  });
});

/**
 * **`400` before `501`.** Each of these would answer `501` if the stub refused before
 * looking, so every case here is really an assertion that the body was parsed.
 */
describe('a malformed request is rejected before the stub', () => {
  it.each(ROUTES)('%s 400s a body with no creationTarget', async (route) => {
    const { creationTarget: _omitted, ...withoutTarget } = VALID[route];

    const res = await post(route, withoutTarget);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(JSON.stringify(body.error.details)).toContain('creationTarget');
  });

  it.each(ROUTES)('%s 400s an empty body', async (route) => {
    expect((await post(route, {})).status).toBe(400);
  });

  it.each([
    ['half a target', { objectKind: 'plan' }],
    ['an incompatible pair', { objectKind: 'task', type: 'event' }],
    ['a list item with no list', { objectKind: 'listItem' }],
    ['an unknown kind', { objectKind: 'note', type: 'task' }],
  ])('400s %s', async (_why, creationTarget) => {
    const res = await post('parse', { ...VALID.parse, creationTarget });

    expect(res.status).toBe(400);
  });

  it('400s parse with no text, and with text past the bound', async () => {
    const { text: _dropped, ...noText } = VALID.parse;
    expect((await post('parse', noText)).status).toBe(400);
    expect((await post('parse', { ...VALID.parse, text: '' })).status).toBe(400);
    expect((await post('parse', { ...VALID.parse, text: 'x'.repeat(4001) })).status).toBe(
      400,
    );
  });

  it('400s parse with a malformed timezone', async () => {
    expect((await post('parse', { ...VALID.parse, tz: 'Nowhere' })).status).toBe(400);
  });

  it('400s extract with an id that is not an attachment', async () => {
    expect(
      (
        await post('extract', {
          ...VALID.extract,
          attachmentId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
        })
      ).status,
    ).toBe(400);
  });

  it('400s link with something that is not a URL', async () => {
    expect((await post('link', { ...VALID.link, url: 'not a url' })).status).toBe(400);
  });
});

/**
 * **The fields that must never be model output, rejected by name.**
 *
 * Capture fills fields inside a destination the user already chose; it never chooses the
 * destination, adds a person, shares anything, or sets a reminder (`CLAUDE.md` rule 2,
 * `security-privacy.md` §1 row 7, ADR-046). Every input is a `strictObject`, so a client — or
 * a hostile poster whose text somehow reached a request body — cannot smuggle one in.
 *
 * Asserted here, in Phase 1, rather than left for Phase 8 to remember.
 */
describe('what a capture request may never carry', () => {
  it.each([
    'objectKind',
    'type',
    'listId',
    'participants',
    'audience',
    'visibility',
    'reminder',
    'reminders',
    'offsetMinutes',
    'notify',
  ])('400s a top-level %s, naming it', async (field) => {
    const res = await post('parse', { ...VALID.parse, [field]: 'anything' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(JSON.stringify(body.error.details)).toContain(field);
  });

  /**
   * The one that would be easiest to get wrong, and the one that matters most: the words are
   * accepted as *text* and the control is untouched, because there is no field to touch it
   * with. The request is well-formed, so it reaches the stub.
   */
  it('accepts "remind me an hour before" as text, since it cannot become a reminder', async () => {
    const res = await post('parse', {
      ...VALID.parse,
      text: 'Dinner with Sam on Friday, remind me an hour before',
    });

    expect(res.status).toBe(501);
  });

  /** Likewise "with Alice": source text, never a participant. */
  it('accepts "with Alice" as text, since it cannot become a person', async () => {
    const res = await post('parse', {
      ...VALID.parse,
      text: 'Dinner with Alice',
    });

    expect(res.status).toBe(501);
  });

  /** A target arm is strict too, so nothing rides in beside a legitimate one. */
  it('400s an extra field inside the target', async () => {
    const res = await post('parse', {
      ...VALID.parse,
      creationTarget: { objectKind: 'task', type: 'task', listId: 'lst_x' },
    });

    expect(res.status).toBe(400);
  });
});

describe('the routes themselves', () => {
  /**
   * A fourth capture path is `501` too, but for a different reason: `routeSplit` answers for
   * any `/v1/` path the registry does not carry. Worth pinning so the two `501`s are not
   * confused — this one never reaches a handler, and so never validates anything.
   */
  it('answers 501 from routeSplit for a capture path that is not one of the three', async () => {
    const res = await createApp().fetch(
      new Request('http://localhost/v1/capture/audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // A body this malformed would be a `400` from any of the three real routes.
        body: JSON.stringify({ nonsense: true }),
      }),
    );

    expect(res.status).toBe(501);
  });

  /** Capture writes nothing, so there is no duplicate for an `Idempotency-Key` to prevent. */
  it.each(ROUTES)('%s needs no Idempotency-Key', async (route) => {
    expect((await post(route, VALID[route])).status).toBe(501);
  });
});
