import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The chain is exercised through `createApp().fetch` directly — no AWS, no network, no
 * server. Every assertion here is about behaviour a later task will rely on without
 * re-reading the middleware.
 *
 * `config` parses `process.env` at module load, so the environment is set before `app.ts`
 * is imported. That is the cost of failing fast on a missing variable, and it is the right
 * trade: a cold-start crash naming the field beats an `undefined` surfacing three layers
 * down.
 */
process.env.STAGE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';

// A type-only import: it is erased at runtime, so it cannot execute `app.ts` before the
// environment above is set, while still giving the real type instead of `any`.
import type { createApp } from './app.js';

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const mod = await import('./app.js');
  app = mod.createApp();
});

const req = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init));

describe('the success path', () => {
  it('answers /v1/health with the data envelope', async () => {
    const res = await req('/v1/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('ok');
    expect(body.meta.requestId).toMatch(/^req_/);
  });
});

describe('requestId', () => {
  it('generates one and echoes it', async () => {
    const res = await req('/v1/health');
    expect(res.headers.get('X-Request-Id')).toMatch(/^req_[0-9a-f]{32}$/);
  });

  it('honours a caller-supplied id so a retry correlates with its original', async () => {
    const res = await req('/v1/health', { headers: { 'X-Request-Id': 'req_abc-123' } });
    expect(res.headers.get('X-Request-Id')).toBe('req_abc-123');
    expect((await res.json()).meta.requestId).toBe('req_abc-123');
  });

  it.each([
    ['a space', 'req_a b'],
    ['something absurdly long', `req_${'a'.repeat(200)}`],
  ])('replaces %s rather than trusting it', async (_why, value) => {
    const res = await req('/v1/health', { headers: { 'X-Request-Id': value } });
    expect(res.headers.get('X-Request-Id')).toMatch(/^req_[0-9a-f]{32}$/);
  });
});

/**
 * Tested directly rather than through the app. A header value containing a newline cannot
 * be put on a `Request` — `undici` rejects it — so routing these through `fetch` would only
 * prove that `undici` validates headers. Under the Lambda adapter the headers come from an
 * API Gateway event instead, which is where this check actually matters.
 */
describe('resolveRequestId', () => {
  it('keeps a well-formed inbound id', async () => {
    const { resolveRequestId } = await import('./middleware/requestId.js');
    expect(resolveRequestId('req_abc-123.x:y')).toBe('req_abc-123.x:y');
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['a newline — the log-injection case', 'req_a\nINJECTED'],
    ['a carriage return', 'req_a\r\nSet-Cookie: x=1'],
    ['a null byte', 'req_a\0b'],
    ['a space', 'req_a b'],
    ['over the length bound', `req_${'a'.repeat(200)}`],
  ])('generates a fresh id for %s', async (_why, value) => {
    const { resolveRequestId } = await import('./middleware/requestId.js');
    expect(resolveRequestId(value)).toMatch(/^req_[0-9a-f]{32}$/);
  });
});

describe('the error envelope', () => {
  it('returns 404 with the error shape for an unknown prefix', async () => {
    const res = await req('/nope');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
    expect(body.error.requestId).toMatch(/^req_/);
    expect(body).not.toHaveProperty('data');
  });

  // A path the contract describes but this build has not implemented is not the same thing
  // as a path that does not exist.
  it('returns 501 for a contract path that Phase 0 has not built', async () => {
    const res = await req('/v1/activities');
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe('not_implemented');
  });

  it('never leaks a stack trace or an exception message', async () => {
    const res = await req('/nope');
    const text = await res.text();
    expect(text).not.toContain('at ');
    expect(text).not.toContain('Error:');
  });
});

describe('bodyLimit', () => {
  it('rejects a 300 KB body with 413, in the envelope', async () => {
    const res = await req('/v1/health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(300 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('payload_too_large');
  });

  it('lets a small body through to routing', async () => {
    const res = await req('/v1/health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    });
    // What is under test is that the body was **not** rejected — anything but 413 proves
    // bodyLimit passed it on to routing.
    //
    // The status is 501, and was 404 before P1-30. `POST /v1/health` matches no route, and
    // Hono reports a method mismatch identically to a path that was never mounted: in both
    // cases `matchedRoutes` contains only middleware. `routeSplit` therefore cannot tell
    // "this path exists under another verb" from "this path does not exist", and applies the
    // known-prefix rule — a path under `/v1/` that nothing handled is `not_implemented`.
    // Distinguishing the two would need a second matcher over the route table, which is the
    // one thing this middleware must not grow (P1-30).
    expect(res.status).toBe(501);
  });
});

describe('cors', () => {
  it('answers OPTIONS from an allowed origin', async () => {
    const res = await req('/v1/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:8081',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:8081');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('does not hand CORS headers to a disallowed origin', async () => {
    const res = await req('/v1/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  // Preflights carry no credentials. If auth ran first, every cross-origin request would
  // fail at the OPTIONS and the real request would never be sent.
  it('answers the preflight before route rejection can', async () => {
    const res = await req('/v1/activities', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:8081',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:8081');
  });
});

describe('securityHeaders', () => {
  it.each([
    ['X-Content-Type-Options', 'nosniff'],
    ['Referrer-Policy', 'no-referrer'],
    ['Cache-Control', 'no-store'],
  ])('sets %s on a success response', async (header, value) => {
    expect((await req('/v1/health')).headers.get(header)).toBe(value);
  });

  it('sets them on an error response too', async () => {
    const res = await req('/nope');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
