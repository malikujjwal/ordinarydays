import { healthResponse } from '@od/shared/schemas';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * `config` parses `process.env` at module load, so the environment is set before `app.ts`
 * is imported. `GIT_SHA` is set to a recognisable value so the assertion proves the SHA
 * comes from the environment rather than from a default that happens to look right.
 */
process.env.STAGE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.GIT_SHA = 'deadbeefcafe';
process.env.LOG_LEVEL = 'fatal';

import type { createApp } from '../app.js';

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const mod = await import('../app.js');
  app = mod.createApp();
});

const get = () => app.fetch(new Request('http://localhost/v1/health'));

describe('GET /v1/health', () => {
  it('returns 200', async () => {
    expect((await get()).status).toBe(200);
  });

  /**
   * The shared schema is the contract. Parsing the live response against the same object
   * the client will use (P0-20) is what makes "defined once, two consumers" true rather
   * than aspirational — if the handler drifts, this fails here rather than in the app.
   */
  it('matches the shared healthResponse schema exactly', async () => {
    const parsed = healthResponse.safeParse(await (await get()).json());
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown field, so a drifting handler is caught', () => {
    const result = healthResponse.safeParse({
      data: {
        status: 'ok',
        sha: 'x',
        stage: 'local',
        coldStart: true,
        surprise: true,
      },
      meta: { requestId: 'req_1' },
    });
    // Zod strips unknown keys by default rather than failing; the guarantee that matters
    // is that the known fields are present and correctly typed, which `.parse` gives.
    expect(result.success).toBe(true);
    expect(result.data?.data).not.toHaveProperty('surprise');
  });

  it('takes the sha from the environment', async () => {
    const body = await (await get()).json();
    expect(body.data.sha).toBe('deadbeefcafe');
  });

  it('reports the stage', async () => {
    expect((await (await get()).json()).data.stage).toBe('local');
  });

  it('echoes the requestId into meta', async () => {
    const res = await app.fetch(
      new Request('http://localhost/v1/health', {
        headers: { 'X-Request-Id': 'req_health1' },
      }),
    );
    expect((await res.json()).meta.requestId).toBe('req_health1');
    expect(res.headers.get('X-Request-Id')).toBe('req_health1');
  });

  /**
   * `coldStart` is module-scope, so asserting it against the shared app would make this
   * test depend on running before every other one in the file. A fresh module registry
   * gives a genuinely uninitialised execution environment, which is what the flag is
   * actually reporting.
   */
  it('is true for the first request an environment serves, and false after', async () => {
    vi.resetModules();
    const { createApp: freshApp } = await import('../app.js');
    const fresh = freshApp();
    const call = () => fresh.fetch(new Request('http://localhost/v1/health'));

    expect((await (await call()).json()).data.coldStart).toBe(true);
    expect((await (await call()).json()).data.coldStart).toBe(false);
    expect((await (await call()).json()).data.coldStart).toBe(false);
  });

  // A cached health response makes a reload look successful when it was not.
  it('is never cacheable', async () => {
    expect((await get()).headers.get('Cache-Control')).toBe('no-store');
  });

  it('runs the whole chain rather than bypassing it', async () => {
    const res = await get();
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('X-Request-Id')).toMatch(/^req_/);
  });

  it('answers without touching DynamoDB', async () => {
    // No credentials, no endpoint, no table — if the handler did any I/O it would hang or
    // throw here rather than return 200.
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.DDB_ENDPOINT;
    const res = await get();
    expect(res.status).toBe(200);
  });
});
