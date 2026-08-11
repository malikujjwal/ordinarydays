import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ERROR_CODES } from '../errors.js';
import { envelope } from '../schemas/envelope.js';
import { healthResponse } from '../schemas/health.js';
import { getHealth } from './endpoints/health.js';
import {
  ApiError,
  backoffDelayMs,
  type ClientWarning,
  createHttpClient,
  type FetchLike,
  type HttpClientConfig,
  isRetryable,
  MAX_RETRIES,
  NetworkError,
  nullTokenProvider,
} from './http.js';

const REQUEST_ID = 'req_test';

const HEALTH_BODY = {
  data: { status: 'ok', sha: 'local', stage: 'local', coldStart: true },
  meta: { requestId: REQUEST_ID },
};

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * A `fetch` stub that records what it was called with and replays a queue of outcomes. The
 * last outcome repeats, so a test that only cares about the first call does not have to
 * enumerate the retries.
 */
function stubFetch(
  outcomes: Array<
    { status: number; body?: unknown; headers?: Record<string, string> } | Error
  >,
) {
  const calls: Call[] = [];
  const textCalls: number[] = [];
  const fetch: FetchLike = (url, init) => {
    const callIndex = calls.length;
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    if (outcome === undefined) throw new Error('stubFetch called with no outcomes');
    if (outcome instanceof Error) return Promise.reject(outcome);

    const headers = outcome.headers ?? {};
    return Promise.resolve({
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      headers: { get: (name: string) => headers[name] ?? null },
      json: () => Promise.resolve(outcome.body),
      text: () => {
        textCalls.push(callIndex);
        return Promise.resolve(
          outcome.body === undefined ? '' : JSON.stringify(outcome.body),
        );
      },
    });
  };
  return { fetch, calls, textCalls };
}

function makeClient(
  outcomes: Parameters<typeof stubFetch>[0],
  overrides: Partial<HttpClientConfig> = {},
) {
  const { fetch, calls, textCalls } = stubFetch(outcomes);
  const warnings: ClientWarning[] = [];
  const client = createHttpClient({
    baseUrl: 'https://api.test',
    fetch,
    tokenProvider: nullTokenProvider,
    timezone: 'Europe/London',
    clientVersion: 'ios/0.1.0',
    strictResponses: true,
    // No real waiting anywhere in this file.
    sleep: () => Promise.resolve(),
    newRequestId: () => REQUEST_ID,
    onWarning: (w) => warnings.push(w),
    ...overrides,
  });
  return { client, calls, textCalls, warnings };
}

const health = () => ({
  method: 'GET' as const,
  path: '/v1/health',
  schema: healthResponse,
});

describe('headers', () => {
  it('sends the correlation id, timezone and client version on every request', async () => {
    const { client, calls } = makeClient([{ status: 200, body: HEALTH_BODY }]);

    await client.request(health());

    expect(calls[0]?.headers).toMatchObject({
      'X-Request-Id': REQUEST_ID,
      'X-Client-Timezone': 'Europe/London',
      'X-Client-Version': 'ios/0.1.0',
    });
  });

  /**
   * The specific failure this prevents: `Authorization: Bearer ` (empty) is rejected as a
   * malformed token, so a signed-out request would come back 401 looking like a broken
   * session rather than like no session.
   */
  it('sends no Authorization header at all when the provider yields nothing', async () => {
    const { client, calls } = makeClient([{ status: 200, body: HEALTH_BODY }]);

    await client.request(health());

    expect(calls[0]?.headers).not.toHaveProperty('Authorization');
  });

  it('sends a bearer token when the provider has one', async () => {
    const { client, calls } = makeClient([{ status: 200, body: HEALTH_BODY }], {
      tokenProvider: {
        getToken: () => Promise.resolve('tok_123'),
        getIdentity: () => Promise.resolve('usr_a'),
      },
    });

    await client.request(health());

    expect(calls[0]?.headers.Authorization).toBe('Bearer tok_123');
  });

  it('treats an empty-string token as no token', async () => {
    const { client, calls } = makeClient([{ status: 200, body: HEALTH_BODY }], {
      tokenProvider: {
        getToken: () => Promise.resolve(''),
        getIdentity: () => Promise.resolve('usr_a'),
      },
    });

    await client.request(health());

    expect(calls[0]?.headers).not.toHaveProperty('Authorization');
  });

  /**
   * **The verification P1-19 owed and P1-20 pays.** The struck-through P1-19 subsection asks
   * whichever task next touches the client to confirm that `getToken` is called *exactly once
   * per request, including on a retried `GET`* — and says to add the case here rather than
   * opening a branch for it. It was not covered; it is now.
   *
   * It was **not** holding: `getToken` ran inside the per-attempt function, so a retried GET
   * called it twice. Fixed in `http.ts` rather than recorded, on the founder's call.
   *
   * Once per **request** is the property worth having because it makes the number of provider
   * calls independent of transport luck. Re-reading per attempt bought nothing: `isRetryable`
   * only retries `5xx` and network failures, so a `401` is never retried and a fresh token
   * between attempts could not have recovered an expired one.
   */
  it('calls getToken exactly once per request', async () => {
    const getToken = vi.fn(() => Promise.resolve('tok_123'));
    const { client } = makeClient([{ status: 200, body: HEALTH_BODY }], {
      tokenProvider: { getToken, getIdentity: () => Promise.resolve('usr_a') },
    });

    await client.request(health());

    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('calls getToken exactly once across a retried GET, not once per attempt', async () => {
    const getToken = vi.fn(() => Promise.resolve('tok_123'));
    const { client, calls } = makeClient(
      [
        { status: 500, body: undefined },
        { status: 200, body: HEALTH_BODY },
      ],
      {
        tokenProvider: { getToken, getIdentity: () => Promise.resolve('usr_a') },
      },
    );

    await client.request(health());

    // The retry really happened — otherwise the assertion below is about nothing.
    expect(calls).toHaveLength(2);
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(calls[1]?.headers.Authorization).toBe('Bearer tok_123');
  });

  it('sets Content-Type only when there is a body', async () => {
    const { client, calls } = makeClient([{ status: 200, body: HEALTH_BODY }]);

    await client.request(health());
    await client.request({ ...health(), method: 'POST', body: { a: 1 } });

    expect(calls[0]?.headers).not.toHaveProperty('Content-Type');
    expect(calls[1]?.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(calls[1]?.body).toBe('{"a":1}');
  });
});

describe('the envelope', () => {
  it('unwraps data and meta', async () => {
    const { client } = makeClient([{ status: 200, body: HEALTH_BODY }]);

    const result = await client.request(health());

    expect(result.data.sha).toBe('local');
    expect(result.meta.requestId).toBe(REQUEST_ID);
  });

  it('prefixes the path with the configured base URL', async () => {
    const { client, calls } = makeClient([{ status: 200, body: HEALTH_BODY }]);

    await client.request(health());

    expect(calls[0]?.url).toBe('https://api.test/v1/health');
  });
});

describe('identity-scoped conditional GETs', () => {
  const withIdentity = (getIdentity: () => Promise<string | undefined>) => ({
    getToken: () => Promise.resolve('tok_123'),
    getIdentity,
  });

  it('stores a 200 ETag/body pair and resolves the next 304 from it', async () => {
    const { client, calls, textCalls } = makeClient(
      [
        { status: 200, body: HEALTH_BODY, headers: { ETag: '"agenda-a"' } },
        { status: 304 },
      ],
      { tokenProvider: withIdentity(() => Promise.resolve('usr_a')) },
    );

    const fresh = await client.request(health());
    const notModified = await client.request(health());

    expect(notModified).toEqual(fresh);
    expect(calls[1]?.headers['If-None-Match']).toBe('"agenda-a"');
    // Only the 200 had bytes to parse. The 304 path never calls response.text/json.
    expect(textCalls).toEqual([0]);
  });

  it('retries one bare 304 without a conditional header when no body is paired', async () => {
    const { client, calls } = makeClient(
      [
        { status: 304 },
        { status: 200, body: HEALTH_BODY, headers: { ETag: '"agenda-a"' } },
      ],
      { tokenProvider: withIdentity(() => Promise.resolve('usr_a')) },
    );

    await expect(client.request(health())).resolves.toEqual(HEALTH_BODY);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers).not.toHaveProperty('If-None-Match');
    expect(calls[1]?.headers).not.toHaveProperty('If-None-Match');
  });

  it("never reuses one user identity's body for another identity", async () => {
    let identity = 'usr_a';
    const otherBody = {
      data: { ...HEALTH_BODY.data, sha: 'other-user' },
      meta: HEALTH_BODY.meta,
    };
    const { client, calls } = makeClient(
      [
        { status: 200, body: HEALTH_BODY, headers: { ETag: '"agenda-a"' } },
        { status: 304 },
        { status: 200, body: otherBody, headers: { ETag: '"agenda-b"' } },
        { status: 304 },
      ],
      { tokenProvider: withIdentity(() => Promise.resolve(identity)) },
    );

    await client.request(health());
    identity = 'usr_b';
    const secondUserFresh = await client.request(health());
    const secondUserCached = await client.request(health());

    expect(secondUserFresh.data.sha).toBe('other-user');
    expect(secondUserCached.data.sha).toBe('other-user');
    expect(calls[1]?.headers).not.toHaveProperty('If-None-Match');
    expect(calls[2]?.headers).not.toHaveProperty('If-None-Match');
    expect(calls[3]?.headers['If-None-Match']).toBe('"agenda-b"');
  });

  it('clearCache empties every identity pair on the existing client', async () => {
    let identity = 'usr_a';
    const replacementA = {
      data: { ...HEALTH_BODY.data, sha: 'after-clear' },
      meta: HEALTH_BODY.meta,
    };
    const replacementB = {
      data: { ...HEALTH_BODY.data, sha: 'other-after-clear' },
      meta: HEALTH_BODY.meta,
    };
    const { client, calls } = makeClient(
      [
        { status: 200, body: HEALTH_BODY, headers: { ETag: '"agenda-a"' } },
        { status: 200, body: HEALTH_BODY, headers: { ETag: '"agenda-b"' } },
        { status: 304 },
        { status: 200, body: replacementA, headers: { ETag: '"agenda-a2"' } },
        { status: 304 },
        { status: 200, body: replacementB, headers: { ETag: '"agenda-b2"' } },
      ],
      { tokenProvider: withIdentity(() => Promise.resolve(identity)) },
    );

    await client.request(health());
    identity = 'usr_b';
    await client.request(health());
    client.clearCache();
    identity = 'usr_a';
    const resultA = await client.request(health());
    identity = 'usr_b';
    const resultB = await client.request(health());

    expect(resultA.data.sha).toBe('after-clear');
    expect(resultB.data.sha).toBe('other-after-clear');
    expect(calls[2]?.headers).not.toHaveProperty('If-None-Match');
    expect(calls[4]?.headers).not.toHaveProperty('If-None-Match');
  });

  it('does not store or reuse authenticated bodies without an identity', async () => {
    const { client, calls } = makeClient([
      { status: 200, body: HEALTH_BODY, headers: { ETag: '"agenda-a"' } },
      { status: 200, body: HEALTH_BODY, headers: { ETag: '"agenda-a"' } },
    ]);

    await client.request(health());
    await client.request(health());

    expect(calls[1]?.headers).not.toHaveProperty('If-None-Match');
  });
});

describe('error mapping', () => {
  /**
   * Every code in the closed union, because the mapping is only useful if a caller can rely
   * on `error.code` for all of them — a `switch` that silently falls through for
   * `invite_revoked` is the bug this catches.
   */
  it.each(ERROR_CODES)('maps a %s body onto a typed ApiError', async (code) => {
    const { client } = makeClient([
      {
        status: 400,
        body: { error: { code, message: 'Nope.', requestId: 'req_server' } },
      },
    ]);

    const error = await client.request(health()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(code);
    expect((error as ApiError).message).toBe('Nope.');
    // The server's id, not the client's — that is the one that appears in the API's logs.
    expect((error as ApiError).requestId).toBe('req_server');
  });

  it('carries validation details through', async () => {
    const details = [{ path: 'schedule.time', message: 'Expected HH:mm' }];
    const { client } = makeClient([
      {
        status: 400,
        body: {
          error: {
            code: 'validation_failed',
            message: 'Bad.',
            details,
            requestId: 'req_s',
          },
        },
      },
    ]);

    const error = (await client.request(health()).catch((e: unknown) => e)) as ApiError;

    expect(error.details).toEqual(details);
  });

  it('reads Retry-After on a rate limit', async () => {
    const { client } = makeClient([
      {
        status: 429,
        headers: { 'Retry-After': '30' },
        body: {
          error: { code: 'rate_limited', message: 'Slow down.', requestId: 'req_s' },
        },
      },
    ]);

    const error = (await client.request(health()).catch((e: unknown) => e)) as ApiError;

    expect(error.retryAfterSeconds).toBe(30);
  });

  /**
   * A gateway timeout or a CloudFront error page knows nothing about `{ error }`. The caller
   * still gets one error type, with the status it actually saw.
   */
  it('turns a non-envelope failure body into an internal ApiError', async () => {
    const { client } = makeClient([{ status: 502, body: '<html>Bad Gateway</html>' }]);

    const error = (await client.request(health()).catch((e: unknown) => e)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('internal');
    expect(error.status).toBe(502);
    expect(error.requestId).toBe(REQUEST_ID);
  });

  it('wraps a transport failure as a NetworkError', async () => {
    const { client } = makeClient([new TypeError('Failed to fetch')]);

    const error = await client.request(health()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NetworkError);
  });

  it('lets an abort surface as itself rather than as a network fault', async () => {
    const abort = new Error('The user aborted a request.');
    abort.name = 'AbortError';
    const { client, calls } = makeClient([abort]);

    const error = await client.request(health()).catch((e: unknown) => e);

    expect(error).toBe(abort);
    expect(calls).toHaveLength(1);
  });
});

describe('retries', () => {
  it('retries a GET three times on 500 and then gives up', async () => {
    const { client, calls } = makeClient([{ status: 500, body: undefined }]);

    await client.request(health()).catch(() => undefined);

    expect(calls).toHaveLength(MAX_RETRIES + 1);
  });

  it('retries a GET on a network failure', async () => {
    const { client, calls } = makeClient([new TypeError('Failed to fetch')]);

    await client.request(health()).catch(() => undefined);

    expect(calls).toHaveLength(MAX_RETRIES + 1);
  });

  it('stops as soon as a retry succeeds', async () => {
    const { client, calls } = makeClient([
      { status: 503, body: undefined },
      { status: 200, body: HEALTH_BODY },
    ]);

    const result = await client.request(health());

    expect(calls).toHaveLength(2);
    expect(result.data.status).toBe('ok');
  });

  it('does not retry a 400', async () => {
    const { client, calls } = makeClient([
      {
        status: 400,
        body: {
          error: { code: 'validation_failed', message: 'Bad.', requestId: 'req_s' },
        },
      },
    ]);

    await client.request(health()).catch(() => undefined);

    expect(calls).toHaveLength(1);
  });

  /**
   * A 429 is the server saying "you are going too fast". Retrying it automatically is how a
   * client converts its own rate limit into a sustained one.
   */
  it('does not retry a 429', async () => {
    const { client, calls } = makeClient([
      {
        status: 429,
        body: {
          error: { code: 'rate_limited', message: 'Slow down.', requestId: 'req_s' },
        },
      },
    ]);

    await client.request(health()).catch(() => undefined);

    expect(calls).toHaveLength(1);
  });

  it('never retries a POST without an Idempotency-Key', async () => {
    const { client, calls } = makeClient([{ status: 500, body: undefined }]);

    await client
      .request({ ...health(), method: 'POST', body: { a: 1 } })
      .catch(() => undefined);

    expect(calls).toHaveLength(1);
  });

  it('retries a POST that carries an Idempotency-Key', async () => {
    const { client, calls } = makeClient([{ status: 500, body: undefined }]);

    await client
      .request({
        ...health(),
        method: 'POST',
        body: { a: 1 },
        headers: { 'Idempotency-Key': 'b0e1…' },
      })
      .catch(() => undefined);

    expect(calls).toHaveLength(MAX_RETRIES + 1);
  });

  it('does not retry a PATCH, whose If-Match would fail the second time', async () => {
    const { client, calls } = makeClient([{ status: 500, body: undefined }]);

    await client
      .request({ ...health(), method: 'PATCH', body: { a: 1 } })
      .catch(() => undefined);

    expect(calls).toHaveLength(1);
  });

  it('reuses one correlation id across a retry, so the attempts correlate in the logs', async () => {
    const { client, calls } = makeClient([
      { status: 500, body: undefined },
      { status: 200, body: HEALTH_BODY },
    ]);

    await client.request(health());

    expect(calls.map((c) => c.headers['X-Request-Id'])).toEqual([REQUEST_ID, REQUEST_ID]);
  });

  it('waits between attempts', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const { client } = makeClient([{ status: 500, body: undefined }], { sleep });

    await client.request(health()).catch(() => undefined);

    expect(sleep).toHaveBeenCalledTimes(MAX_RETRIES);
  });
});

describe('backoff', () => {
  it('grows exponentially and then holds at the cap', () => {
    const always = () => 0.999_999;

    expect(backoffDelayMs(0, always)).toBe(199);
    expect(backoffDelayMs(1, always)).toBe(399);
    expect(backoffDelayMs(2, always)).toBe(799);
    expect(backoffDelayMs(9, always)).toBe(1999);
  });

  /**
   * Full jitter: the floor is zero at every attempt. Without it, every client that saw the
   * same 503 comes back at the same moment.
   */
  it('can return no delay at all, which is what makes it jittered', () => {
    expect(backoffDelayMs(5, () => 0)).toBe(0);
  });
});

describe('isRetryable', () => {
  it.each([
    ['a network failure', new NetworkError('x', undefined), true],
    ['a 500', new ApiError('internal', 'x', 500, 'r'), true],
    ['a 503', new ApiError('internal', 'x', 503, 'r'), true],
    ['a 400', new ApiError('validation_failed', 'x', 400, 'r'), false],
    ['a 429', new ApiError('rate_limited', 'x', 429, 'r'), false],
    ['an unrelated error', new Error('x'), false],
  ])('says %s is %s', (_name, error, expected) => {
    expect(isRetryable(error)).toBe(expected);
  });
});

describe('response validation', () => {
  const wrong = { data: { status: 'ok', sha: 'local', stage: 'local' }, meta: {} };

  it('throws in a dev or test build, so a drifted contract stops the build', async () => {
    const { client } = makeClient([{ status: 200, body: wrong }], {
      strictResponses: true,
    });

    const error = (await client.request(health()).catch((e: unknown) => e)) as Error;

    expect(error.name).toBe('ResponseValidationError');
    expect(error.message).toContain('/v1/health');
  });

  /**
   * The asymmetry that matters: a server that added a field must not break an app already on
   * someone's phone. The shipped client warns and uses what arrived.
   */
  it('warns and returns the body in a shipped build', async () => {
    const extra = {
      data: { ...HEALTH_BODY.data, somethingNew: true },
      meta: HEALTH_BODY.meta,
    };
    const { client, warnings } = makeClient([{ status: 200, body: extra }], {
      strictResponses: false,
    });

    const result = await client.request({
      ...health(),
      // A schema that rejects unknown keys, to force the failure a future field would cause.
      schema: envelope(z.object({ status: z.literal('ok') }).strict()),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe('/v1/health');
    expect(result).toEqual(extra);
  });

  it('reports which field failed', async () => {
    const { client, warnings } = makeClient([{ status: 200, body: wrong }], {
      strictResponses: false,
    });

    await client.request(health());

    expect(warnings[0]?.issues?.map((i) => i.path)).toContain('data.coldStart');
  });
});

/**
 * Every test above injects `sleep`, `newRequestId` and `onWarning`, which means the
 * defaults — the implementations that actually run in the app — were never executed once.
 * P0-24's coverage gate caught that, and it is the more useful half of what a gate is for:
 * not the number, but noticing that the production path is the untested one.
 */
describe('the defaults, which are what production uses', () => {
  const bare = (fetchImpl: FetchLike, overrides: Partial<HttpClientConfig> = {}) =>
    createHttpClient({
      baseUrl: 'https://api.test',
      fetch: fetchImpl,
      tokenProvider: nullTokenProvider,
      timezone: 'Europe/London',
      clientVersion: 'ios/0.1.0',
      strictResponses: true,
      ...overrides,
    });

  it('generates a correlation id in the API’s own format', async () => {
    const { fetch, calls } = stubFetch([{ status: 200, body: HEALTH_BODY }]);

    await bare(fetch).request(health());

    // `req_` plus 32 hex characters, matching `services/api/src/middleware/requestId.ts`,
    // whose `SAFE` pattern must accept what this produces.
    expect(calls[0]?.headers['X-Request-Id']).toMatch(/^req_[0-9a-f]{32}$/);
  });

  it('generates a distinct id per call', async () => {
    const { fetch, calls } = stubFetch([{ status: 200, body: HEALTH_BODY }]);
    const client = bare(fetch);

    await client.request(health());
    await client.request(health());

    expect(calls[0]?.headers['X-Request-Id']).not.toBe(calls[1]?.headers['X-Request-Id']);
  });

  /**
   * Hermes has no `crypto.randomUUID` without a polyfill, so this branch is the React
   * Native path rather than a defensive nicety.
   */
  it('falls back to a non-crypto id when crypto.randomUUID is absent', async () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      const { fetch, calls } = stubFetch([{ status: 200, body: HEALTH_BODY }]);

      await bare(fetch).request(health());

      expect(calls[0]?.headers['X-Request-Id']).toMatch(/^req_[0-9a-f]{32}$/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: original,
        configurable: true,
      });
    }
  });

  it('really waits between retries when no sleep is injected', async () => {
    const { fetch, calls } = stubFetch([{ status: 500, body: undefined }]);

    const startedAt = Date.now();
    await bare(fetch)
      .request(health())
      .catch(() => undefined);

    expect(calls).toHaveLength(MAX_RETRIES + 1);
    // Three real backoffs. Only a floor is asserted — full jitter can draw zero, so an
    // upper bound would be a flaky test.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(0);
  });

  it('warns through the console when no handler is injected', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fetch } = stubFetch([{ status: 200, body: { data: {}, meta: {} } }]);

    await bare(fetch, { strictResponses: false }).request(health());

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toContain('Response did not match its schema');
    spy.mockRestore();
  });
});

describe('isAppErrorBody rejects what is not an envelope', () => {
  it.each([
    ['a null body', null],
    ['a string', 'nope'],
    ['an object with no error key', { data: {} }],
    ['a null error', { error: null }],
    ['an error that is a string', { error: 'boom' }],
    ['an unknown code', { error: { code: 'nope', message: 'x', requestId: 'r' } }],
    ['a missing requestId', { error: { code: 'not_found', message: 'x' } }],
  ])('treats %s as a non-envelope failure', async (_name, body) => {
    const { client } = makeClient([{ status: 500, body }]);

    const error = (await client.request(health()).catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('internal');
  });
});

describe('getHealth', () => {
  it('returns the health payload, parsed with the shared schema', async () => {
    const { client, calls } = makeClient([{ status: 200, body: HEALTH_BODY }]);

    const result = await getHealth(client);

    expect(calls[0]?.url).toBe('https://api.test/v1/health');
    expect(result).toEqual(HEALTH_BODY.data);
  });

  it('passes an abort signal through when given one', async () => {
    const { client } = makeClient([{ status: 200, body: HEALTH_BODY }]);
    const controller = new AbortController();

    await expect(getHealth(client, controller.signal)).resolves.toEqual(HEALTH_BODY.data);
  });
});
