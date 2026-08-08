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
  const fetch: FetchLike = (url, init) => {
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
      text: () =>
        Promise.resolve(outcome.body === undefined ? '' : JSON.stringify(outcome.body)),
    });
  };
  return { fetch, calls };
}

function makeClient(
  outcomes: Parameters<typeof stubFetch>[0],
  overrides: Partial<HttpClientConfig> = {},
) {
  const { fetch, calls } = stubFetch(outcomes);
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
  return { client, calls, warnings };
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
      tokenProvider: { getToken: () => Promise.resolve('tok_123') },
    });

    await client.request(health());

    expect(calls[0]?.headers.Authorization).toBe('Bearer tok_123');
  });

  it('treats an empty-string token as no token', async () => {
    const { client, calls } = makeClient([{ status: 200, body: HEALTH_BODY }], {
      tokenProvider: { getToken: () => Promise.resolve('') },
    });

    await client.request(health());

    expect(calls[0]?.headers).not.toHaveProperty('Authorization');
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

describe('getHealth', () => {
  it('returns the health payload, parsed with the shared schema', async () => {
    const { client, calls } = makeClient([{ status: 200, body: HEALTH_BODY }]);

    const result = await getHealth(client);

    expect(calls[0]?.url).toBe('https://api.test/v1/health');
    expect(result).toEqual(HEALTH_BODY.data);
  });
});
