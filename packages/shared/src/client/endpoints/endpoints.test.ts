import { describe, expect, it } from 'vitest';
import type { FetchLike, HttpClientConfig } from '../http.js';
import { ApiError, createHttpClient, nullTokenProvider } from '../http.js';
import { createActivity } from './activities.js';
import {
  assertTargetEcho,
  type CreationTarget,
  captureExtract,
  captureLink,
  captureParse,
} from './capture.js';

/**
 * The Activity and capture endpoint functions (P1-20).
 *
 * What is worth asserting here is not "it calls fetch" — `http.test.ts` covers the transport
 * exhaustively. It is the two contracts these functions exist to keep:
 *
 * 1. **The request body carries the target the caller fixed, verbatim.** Serialising
 *    `objectKind` and `type` onto the wire is the last point at which `CLAUDE.md` rule 2 can
 *    be broken by code rather than by a user, so the body is asserted field by field.
 * 2. **A capture response naming a different destination is rejected**, not reconciled.
 */

const REQUEST_ID = 'req_test';

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}

function makeClient(
  outcomes: Array<{ status: number; body?: unknown }>,
  overrides: Partial<HttpClientConfig> = {},
) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    if (outcome === undefined) throw new Error('no outcome');
    return Promise.resolve({
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      headers: { get: () => null },
      json: () => Promise.resolve(outcome.body),
      text: () =>
        Promise.resolve(outcome.body === undefined ? '' : JSON.stringify(outcome.body)),
    });
  };

  const client = createHttpClient({
    baseUrl: 'https://api.test',
    fetch,
    tokenProvider: nullTokenProvider,
    timezone: 'Europe/London',
    clientVersion: 'ios/0.1.0',
    strictResponses: true,
    sleep: () => Promise.resolve(),
    newRequestId: () => REQUEST_ID,
    onWarning: () => {},
    ...overrides,
  });
  return { client, calls };
}

const CREATED = {
  data: {
    activityId: 'act_01J0000000000000000000000A',
    ownerId: 'usr_01J0000000000000000000000B',
    objectKind: 'task',
    type: 'task',
    status: 'saved',
    title: 'Call the dentist',
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    details: { kind: 'task' },
    icsSequence: 0,
    createdAt: '2026-08-08T10:00:00.000Z',
    updatedAt: '2026-08-08T10:00:00.000Z',
    schemaVersion: 1,
  },
  meta: { requestId: REQUEST_ID },
};

describe('createActivity', () => {
  it('sends objectKind and type exactly as the caller fixed them', async () => {
    const { client, calls } = makeClient([{ status: 201, body: CREATED }]);

    await createActivity(
      client,
      { objectKind: 'task', type: 'task', title: 'Call the dentist' },
      'idem-1',
    );

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://api.test/v1/activities');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      objectKind: 'task',
      type: 'task',
      title: 'Call the dentist',
    });
  });

  it('sends the Plan kind the user chose, not a default', async () => {
    const { client, calls } = makeClient([
      {
        status: 201,
        body: {
          ...CREATED,
          data: {
            ...CREATED.data,
            objectKind: 'plan',
            type: 'watch',
            title: 'Severance',
            details: { kind: 'watch', mediaTitle: 'Severance' },
          },
        },
      },
    ]);

    await createActivity(
      client,
      {
        objectKind: 'plan',
        type: 'watch',
        title: 'Severance',
        details: { kind: 'watch', mediaTitle: 'Severance' },
      },
      'idem-2',
    );

    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({
      objectKind: 'plan',
      type: 'watch',
    });
  });

  /**
   * The header is what makes the create retryable *and* what makes the retry safe. Without
   * it the client's own predicate refuses to retry a POST at all, so a dropped response on a
   * flaky connection becomes a failed save rather than a recovered one.
   */
  it('carries the caller-supplied Idempotency-Key', async () => {
    const { client, calls } = makeClient([{ status: 201, body: CREATED }]);

    await createActivity(
      client,
      { objectKind: 'task', type: 'task', title: 'Call the dentist' },
      'idem-3',
    );

    expect(calls[0]?.headers['Idempotency-Key']).toBe('idem-3');
  });

  it('reuses one key across retries so a retried save cannot double-write', async () => {
    const { client, calls } = makeClient([
      { status: 503 },
      { status: 201, body: CREATED },
    ]);

    await createActivity(
      client,
      { objectKind: 'task', type: 'task', title: 'Call the dentist' },
      'idem-4',
    );

    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.headers['Idempotency-Key'])).toEqual(['idem-4', 'idem-4']);
  });

  it('surfaces a validation failure as an ApiError with its per-field details', async () => {
    const { client } = makeClient([
      {
        status: 400,
        body: {
          error: {
            code: 'validation_failed',
            message: 'A title is required',
            requestId: REQUEST_ID,
            details: [{ path: 'title', message: 'A title is required' }],
          },
        },
      },
    ]);

    const error = await createActivity(
      client,
      { objectKind: 'task', type: 'task', title: 'x' },
      'idem-5',
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('validation_failed');
    expect((error as ApiError).details).toEqual([
      { path: 'title', message: 'A title is required' },
    ]);
  });
});

const TASK_TARGET: CreationTarget = { objectKind: 'task', type: 'task' };

function parsed(target: CreationTarget) {
  return {
    data: {
      creationTarget: target,
      confidence: 0.9,
      fields: { title: { value: 'Dentist', confidence: 0.95 } },
    },
    meta: { requestId: REQUEST_ID },
  };
}

describe('capture', () => {
  it.each([
    [
      'parse',
      '/v1/capture/parse',
      () => ({ text: 'dentist tuesday', tz: 'Europe/London' }),
    ],
    [
      'extract',
      '/v1/capture/extract',
      () => ({ attachmentId: 'att_01J0000000000000000000000C' }),
    ],
    ['link', '/v1/capture/link', () => ({ url: 'https://example.com/x' })],
  ])('%s sends the caller-fixed creationTarget', async (name, path, rest) => {
    const { client, calls } = makeClient([{ status: 200, body: parsed(TASK_TARGET) }]);
    const input = { ...rest(), creationTarget: TASK_TARGET };

    const call =
      name === 'parse'
        ? captureParse(client, input as Parameters<typeof captureParse>[1])
        : name === 'extract'
          ? captureExtract(client, input as Parameters<typeof captureExtract>[1])
          : captureLink(client, input as Parameters<typeof captureLink>[1]);
    await call;

    expect(calls[0]?.url).toBe(`https://api.test${path}`);
    expect(JSON.parse(calls[0]?.body ?? '{}').creationTarget).toEqual(TASK_TARGET);
  });

  /**
   * P1-18 stubs all three at `501`. The client must surface that as an ordinary `ApiError`
   * so the caller can apply `ai-capture.md` §6.1's degraded path — silence on the text path,
   * the manual-entry line on the image and link paths — rather than treating it as a crash.
   */
  it('surfaces the Phase 1 501 stub as an ApiError the caller can degrade on', async () => {
    const { client } = makeClient([
      {
        status: 501,
        body: {
          error: {
            code: 'not_implemented',
            message: 'Capture arrives in a later release.',
            requestId: REQUEST_ID,
          },
        },
      },
    ]);

    const error = await captureParse(client, {
      text: 'dentist tuesday',
      tz: 'Europe/London',
      creationTarget: TASK_TARGET,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('not_implemented');
  });

  it('rejects a response that names a different destination', async () => {
    const { client } = makeClient([
      { status: 200, body: parsed({ objectKind: 'plan', type: 'event' }) },
    ]);

    await expect(
      captureParse(client, {
        text: 'dentist tuesday',
        tz: 'Europe/London',
        creationTarget: TASK_TARGET,
      }),
    ).rejects.toThrow('named a different destination');
  });

  it('accepts an echo that matches', () => {
    expect(() =>
      assertTargetEcho(TASK_TARGET, { objectKind: 'task', type: 'task' }),
    ).not.toThrow();
  });

  it('rejects a Plan kind swapped for another', () => {
    expect(() =>
      assertTargetEcho(
        { objectKind: 'plan', type: 'meal' },
        { objectKind: 'plan', type: 'outing' },
      ),
    ).toThrow();
  });
});
