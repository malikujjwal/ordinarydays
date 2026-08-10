import { describe, expect, it } from 'vitest';
import type { FetchLike, HttpClientConfig } from '../http.js';
import { ApiError, createHttpClient, nullTokenProvider } from '../http.js';
import {
  createActivity,
  deleteActivity,
  duplicateActivity,
  listActivities,
} from './activities.js';
import {
  assertTargetEcho,
  type CreationTarget,
  captureExtract,
  captureLink,
  captureParse,
} from './capture.js';
import { getMe, patchMe, registerDevice, unregisterDevice } from './me.js';

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
   * **Amended in P1-20**, which is the task that specifies the behaviour: the three capture
   * functions "handle `not_implemented` as a **first-class outcome, not an error to
   * surface**".
   *
   * This previously asserted a thrown `ApiError`, and the reasoning in its own comment is
   * what argues against it: a caller applying `ai-capture.md` §6.1's degraded path — *silence*
   * on the text path — should not have to reach that path through a `catch`. Until Phase 8
   * this is the normal case, not a failure, and an error branch attracts error treatment.
   *
   * The full outcome matrix lives in `capture degrades rather than failing` below; this keeps
   * the case here so the amendment is visible where the old assertion was.
   */
  it('surfaces the Phase 1 501 stub as an outcome rather than throwing', async () => {
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

    const outcome = await captureParse(client, {
      text: 'dentist tuesday',
      tz: 'Europe/London',
      creationTarget: TASK_TARGET,
    });

    expect(outcome).toEqual({ status: 'unavailable' });
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
        { objectKind: 'plan', type: 'event' },
      ),
    ).toThrow();
  });
});

/**
 * The `/v1/me` functions (P1-20).
 *
 * The shape worth asserting is that **none of them knows whether a token exists**: `getMe()`
 * is the same call in Phase 1 and Phase 4, and the difference lives entirely inside the
 * provider handed to the client. There is no branch here to test — its absence is the point,
 * and the request assertions below are what would fail if one appeared.
 */
describe('the me endpoints', () => {
  const PROFILE = {
    data: {
      userId: 'usr_local_dev',
      displayName: 'Dev',
      timezone: 'America/New_York',
      currency: 'USD',
      weekStartsOn: 0,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      schemaVersion: 1,
    },
    meta: { requestId: REQUEST_ID },
  };

  it('gets the profile, parsed by the shared schema', async () => {
    const { client, calls } = makeClient([{ status: 200, body: PROFILE }]);

    const me = await getMe(client);

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe('https://api.test/v1/me');
    expect(me.userId).toBe('usr_local_dev');
  });

  it('patches only what it was given', async () => {
    const { client, calls } = makeClient([{ status: 200, body: PROFILE }]);

    await patchMe(client, { displayName: 'Ada' });

    expect(calls[0]?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ displayName: 'Ada' });
  });

  /**
   * `null` clears the default to Off and `0` is a real *at the time* reminder. The client
   * must put both on the wire as themselves — collapsing either would silently turn one
   * setting into the other (ADR-047).
   */
  it.each([
    ['null, which is Off', null],
    ['zero, which is at the time', 0],
  ])('sends defaultReminderOffset %s as itself', async (_why, value) => {
    const { client, calls } = makeClient([{ status: 200, body: PROFILE }]);

    await patchMe(client, { defaultReminderOffset: value });

    expect(JSON.parse(String(calls[0]?.body))).toEqual({ defaultReminderOffset: value });
  });

  it('registers a device with an idempotency key, and returns the minted id', async () => {
    const body = {
      data: {
        deviceId: 'dev_01J0000000000000000000000A',
        expoPushToken: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
        platform: 'ios',
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
        schemaVersion: 1,
      },
      meta: { requestId: REQUEST_ID },
    };
    const { client, calls } = makeClient([{ status: 201, body }]);

    const device = await registerDevice(
      client,
      { expoPushToken: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]', platform: 'ios' },
      'e6f2b0a4-0f3f-4f9e-9c1a-0d8f2a3b4c5d',
    );

    expect(calls[0]?.headers['Idempotency-Key']).toBe(
      'e6f2b0a4-0f3f-4f9e-9c1a-0d8f2a3b4c5d',
    );
    // The only way the caller can ever remove this registration.
    expect(device.deviceId).toBe('dev_01J0000000000000000000000A');
  });

  it('unregisters by id', async () => {
    const body = {
      data: { deviceId: 'dev_01J0000000000000000000000A' },
      meta: { requestId: REQUEST_ID },
    };
    const { client, calls } = makeClient([{ status: 200, body }]);

    await unregisterDevice(client, 'dev_01J0000000000000000000000A');

    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe(
      'https://api.test/v1/me/devices/dev_01J0000000000000000000000A',
    );
  });
});

describe('the remaining activity endpoints', () => {
  it('deletes by id and reports what went', async () => {
    const body = {
      data: { activityId: 'act_01J0000000000000000000000A' },
      meta: { requestId: REQUEST_ID },
    };
    const { client, calls } = makeClient([{ status: 200, body }]);

    const gone = await deleteActivity(client, 'act_01J0000000000000000000000A');

    expect(calls[0]?.method).toBe('DELETE');
    expect(gone.activityId).toBe('act_01J0000000000000000000000A');
  });

  it('duplicates with an idempotency key and no body', async () => {
    const { client, calls } = makeClient([{ status: 201, body: CREATED }]);

    await duplicateActivity(
      client,
      'act_01J0000000000000000000000A',
      'e6f2b0a4-0f3f-4f9e-9c1a-0d8f2a3b4c5d',
    );

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(
      'https://api.test/v1/activities/act_01J0000000000000000000000A/duplicate',
    );
    expect(calls[0]?.headers['Idempotency-Key']).toBe(
      'e6f2b0a4-0f3f-4f9e-9c1a-0d8f2a3b4c5d',
    );
    // There is nothing to send, and accepting fields would be a second create path.
    expect(calls[0]?.body).toBeUndefined();
  });

  const PAGE = {
    data: [
      {
        activityId: 'act_01J0000000000000000000000A',
        type: 'task',
        title: 'Buy milk',
        status: 'saved',
        isRecurring: false,
        participantCount: 0,
      },
    ],
    meta: { requestId: REQUEST_ID, nextCursor: 'ZXlKd2F5STZJbTFo' },
  };

  it('returns the whole envelope, because a list caller needs the cursor', async () => {
    const { client } = makeClient([{ status: 200, body: PAGE }]);

    const page = await listActivities(client, { filter: 'saved' });

    expect(page.data).toHaveLength(1);
    expect(page.meta.nextCursor).toBe('ZXlKd2F5STZJbTFo');
  });

  it('sends the filter and omits the parameters it was not given', async () => {
    const { client, calls } = makeClient([{ status: 200, body: PAGE }]);

    await listActivities(client, { filter: 'upcoming' });

    expect(calls[0]?.url).toBe('https://api.test/v1/activities?filter=upcoming');
  });

  /**
   * `URLSearchParams` would render a missing `type` as the literal string `undefined`, which
   * the server's strict schema rejects — a `400` whose cause is three layers from where it
   * appears to come from.
   */
  it('never serialises an absent parameter as the word undefined', async () => {
    const { client, calls } = makeClient([{ status: 200, body: PAGE }]);

    await listActivities(client, { filter: 'past', limit: 25 });

    expect(calls[0]?.url).not.toContain('undefined');
    expect(calls[0]?.url).toContain('filter=past');
    expect(calls[0]?.url).toContain('limit=25');
  });

  it('passes a cursor back, encoded', async () => {
    const { client, calls } = makeClient([{ status: 200, body: PAGE }]);

    await listActivities(client, { filter: 'saved', cursor: 'a+b/c=' });

    expect(calls[0]?.url).toContain('cursor=a%2Bb%2Fc%3D');
  });
});

/**
 * **`not_implemented` is an outcome, not an error.**
 *
 * Until Phase 8 every capture endpoint returns `501`, and the product has to be complete and
 * pleasant without any of it (`ai-capture.md` §6.2). A thrown `ApiError` would put the normal
 * Phase 1–7 path down an error branch, and error branches get error treatment — a toast, a
 * banner, a `Try again` — when §6.1 asks for *nothing at all* on the text path.
 */
describe('capture degrades rather than failing', () => {
  const TARGET: CreationTarget = { objectKind: 'task', type: 'task' };
  const STUB = {
    error: {
      code: 'not_implemented',
      message: 'Capture is not available yet.',
      requestId: REQUEST_ID,
    },
  };

  const PARSE_INPUT = {
    text: 'Dinner on Friday',
    tz: 'Europe/London',
    creationTarget: TARGET,
  };

  it('parse surfaces unavailable as a value the caller can branch on', async () => {
    const { client } = makeClient([{ status: 501, body: STUB }]);

    expect(await captureParse(client, PARSE_INPUT)).toEqual({ status: 'unavailable' });
  });

  it('extract surfaces unavailable', async () => {
    const { client } = makeClient([{ status: 501, body: STUB }]);

    expect(
      await captureExtract(client, {
        attachmentId: 'att_01J0000000000000000000000A',
        creationTarget: TARGET,
      }),
    ).toEqual({ status: 'unavailable' });
  });

  it('link surfaces unavailable', async () => {
    const { client } = makeClient([{ status: 501, body: STUB }]);

    expect(
      await captureLink(client, { url: 'https://example.com', creationTarget: TARGET }),
    ).toEqual({ status: 'unavailable' });
  });

  /**
   * Everything else still throws. Swallowing a `500` would make a broken model provider
   * indistinguishable from a feature that has not shipped — each has its own row and its own
   * copy in §6.1.
   */
  it.each([
    ['a server failure', 500, 'internal'],
    ['a rate limit', 429, 'rate_limited'],
  ])('still throws on %s', async (_why, status, code) => {
    const { client } = makeClient([
      { status, body: { error: { code, message: 'no', requestId: REQUEST_ID } } },
    ]);

    await expect(captureParse(client, PARSE_INPUT)).rejects.toBeInstanceOf(ApiError);
  });

  it('returns the parse as a parsed outcome when it succeeds', async () => {
    const body = {
      data: {
        creationTarget: TARGET,
        confidence: 0.9,
        fields: { title: { value: 'Dinner', confidence: 0.9 } },
      },
      meta: { requestId: REQUEST_ID },
    };
    const { client } = makeClient([{ status: 200, body }]);

    const outcome = await captureParse(client, PARSE_INPUT);

    expect(outcome.status).toBe('parsed');
    expect(outcome.status === 'parsed' && outcome.capture.confidence).toBe(0.9);
  });
});
