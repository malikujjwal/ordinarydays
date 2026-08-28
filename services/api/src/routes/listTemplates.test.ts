import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { LIST_TEMPLATES } from '@od/shared/lists';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';

import type { createApp as CreateApp } from '../app.js';

/** `GET /v1/list-templates` (P3-06). */
const ddbMock = mockClient(DynamoDBDocumentClient);

let createApp: typeof CreateApp;

beforeEach(async () => {
  ddbMock.reset();
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

const get = (app: ReturnType<typeof CreateApp>, headers: Record<string, string> = {}) =>
  app.fetch(new Request('http://localhost/v1/list-templates', { headers }));

describe('the catalogue payload', () => {
  it('returns every template, in catalogue order, in the standard envelope', async () => {
    const res = await get(createApp());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual(LIST_TEMPLATES);
    expect(body.data.map((entry: { templateKey: string }) => entry.templateKey)).toEqual(
      LIST_TEMPLATES.map((entry) => entry.templateKey),
    );
    expect(body.meta.requestId).toMatch(/^req_/);
  });

  it('returns every field of every record — a client previews what it will produce', async () => {
    const body = await (await get(createApp())).json();

    for (const template of body.data) {
      expect(Object.keys(template).sort()).toEqual([
        'chooserLabel',
        'defaultTitle',
        'emptyStateCopy',
        'featureConfig',
        'icon',
        'itemStateMode',
        'slot',
        'summary',
        'templateKey',
      ]);
    }
  });

  it('validates against the shared ListTemplate schema', async () => {
    const { listTemplate } = await import('@od/shared/schemas');
    const body = await (await get(createApp())).json();

    for (const template of body.data) {
      expect(listTemplate.safeParse(template).success).toBe(true);
    }
  });

  /**
   * Acceptance criterion 2's half of the path that this route owns: a record added to the
   * array reaches the response through the same code, with no schema change and no branch.
   */
  it('serves a fixture template appended to the catalogue with no branch anywhere', async () => {
    const { listTemplatesHandler } = await import('../handlers/listTemplates.js');
    const { weakEntityTag } = await import('../lib/etag.js');
    // A key the shipped catalogue does not use, so the fixture cannot collide with a real
    // record and quietly assert nothing.
    const fixture = {
      templateKey: 'plants-to-water',
      chooserLabel: 'Plants to water',
      summary: 'A watering checklist',
      defaultTitle: 'Plants to water',
      icon: 'leaf',
      itemStateMode: { mode: 'checkbox' },
      featureConfig: {},
      slot: null,
      emptyStateCopy: 'Add a plant to water.',
    } as const;
    const extended = [...LIST_TEMPLATES, fixture];

    const app = createApp();
    app.get('/probe', (c) => listTemplatesHandler(c, extended, weakEntityTag(extended)));
    const body = await (await app.fetch(new Request('http://localhost/probe'))).json();

    expect(body.data).toHaveLength(LIST_TEMPLATES.length + 1);
    expect(body.data.at(-1)).toEqual(fixture);
  });
});

describe('caching', () => {
  it('sets a public 24-hour cache policy and a weak ETag', async () => {
    const res = await get(createApp());

    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(res.headers.get('ETag')).toMatch(/^W\/"[A-Za-z0-9_-]{43}"$/);
  });

  /**
   * **Why the validator must be weak** (P3-06 review). The catalogue never changes between
   * these two responses, but `meta.requestId` does — so the bodies differ byte for byte
   * while sharing a tag. A strong validator would assert they are identical, and a cache
   * could then serve request A's body as request B's response (RFC 9110 §8.8.1).
   */
  it('serves byte-different bodies under one tag, which is why it is not strong', async () => {
    const first = await get(createApp(), { 'X-Request-Id': 'req_first' });
    const second = await get(createApp(), { 'X-Request-Id': 'req_second' });

    const firstBody = await first.text();
    const secondBody = await second.text();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstBody).not.toBe(secondBody);
    expect(JSON.parse(firstBody).meta.requestId).toBe('req_first');
    expect(JSON.parse(secondBody).meta.requestId).toBe('req_second');

    expect(first.headers.get('ETag')).toBe(second.headers.get('ETag'));
    expect(first.headers.get('ETag')).toMatch(/^W\//);
  });

  it('answers 304 with no body for a matching If-None-Match', async () => {
    const first = await get(createApp());
    const etag = String(first.headers.get('ETag'));

    const second = await get(createApp(), { 'If-None-Match': etag });

    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    expect(second.headers.get('ETag')).toBe(etag);
    expect(second.headers.get('Cache-Control')).toBe('public, max-age=86400');
  });

  it('serves the payload again when the validator does not match', async () => {
    const res = await get(createApp(), { 'If-None-Match': '"stale"' });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual(LIST_TEMPLATES);
  });

  /** A shipped change to the array must invalidate every cached copy. */
  it('produces a different tag for a mutated catalogue', async () => {
    const { weakEntityTag } = await import('../lib/etag.js');
    const current = String((await get(createApp())).headers.get('ETag'));

    const reordered = [...LIST_TEMPLATES].reverse();
    const relabelled = LIST_TEMPLATES.map((entry, index) =>
      index === 0 ? { ...entry, chooserLabel: 'Renamed' } : entry,
    );

    expect(weakEntityTag(LIST_TEMPLATES)).toBe(current);
    expect(weakEntityTag(reordered)).not.toBe(current);
    expect(weakEntityTag(relabelled)).not.toBe(current);
  });

  /**
   * A client still holding the strong tag issued before this fix must not be forced into a
   * full refetch — the weak comparison function accepts either form.
   */
  it('honours a client echoing either the weak or the strong form', async () => {
    const weak = String((await get(createApp())).headers.get('ETag'));
    const strong = weak.replace(/^W\//, '');

    expect((await get(createApp(), { 'If-None-Match': weak })).status).toBe(304);
    expect((await get(createApp(), { 'If-None-Match': strong })).status).toBe(304);
  });
});

describe('the route contract', () => {
  it('is registered as an authenticated GET', async () => {
    const { ROUTE_REGISTRY } = await import('../middleware/routeRegistry.js');

    expect(ROUTE_REGISTRY).toContainEqual({
      method: 'GET',
      pattern: '/v1/list-templates',
      auth: 'authenticated',
    });
  });

  /**
   * P3-07's API half: the catalogue is served, and **nothing ranks it**. No route proposes
   * a style from a title, and an unmounted path answers `501` rather than guessing
   * (acceptance criterion 6). The repo-wide symbol half is
   * `scripts/check-forbidden.mjs no-template-suggester`.
   */
  it('registers no route that would propose a style', async () => {
    const { ROUTE_REGISTRY } = await import('../middleware/routeRegistry.js');

    expect(
      ROUTE_REGISTRY.filter((entry) => /suggest|recommend|match/i.test(entry.pattern)),
    ).toEqual([]);

    const res = await createApp().fetch(
      new Request('http://localhost/v1/lists/suggest-template', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ title: 'Costco run' }),
      }),
    );

    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe('not_implemented');
  });

  it('401s when identity resolution fails', async () => {
    const { AppError } = await import('../lib/errors.js');
    const app = createApp({
      identityProvider: {
        resolve: () =>
          Promise.reject(new AppError('unauthenticated', 'Authentication required.')),
      },
    });

    const res = await get(app);

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
  });

  /**
   * The layering rules already forbid a repository import here; this asserts the
   * consequence a reader cares about — serving the catalogue reads no stored data.
   *
   * The one command that does fire is the **rate-limit counter**, which every authenticated
   * route writes at chain position 9 and which belongs to the middleware rather than to
   * this handler. It is asserted by name rather than excused, so a future read added to
   * this path fails here instead of hiding behind a loosened count.
   */
  it('reads nothing from storage; the only call is the rate-limit counter', async () => {
    const { GetCommand, QueryCommand, BatchGetCommand, TransactWriteCommand } =
      await import('@aws-sdk/lib-dynamodb');
    await get(createApp());

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);

    const keys = ddbMock
      .calls()
      .map(
        (call) =>
          (call.args[0]?.input as { Key?: { pk?: string } } | undefined)?.Key?.pk ?? '',
      );
    expect(keys.every((pk) => pk.startsWith('RATE#'))).toBe(true);
  });
});
