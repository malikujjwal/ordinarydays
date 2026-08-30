import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Everything that must be true before the first spec runs: a web export to serve, and a
 * seeded table for the API to read (P1-29).
 *
 * The servers themselves are Playwright's `webServer` entries — this is only the state they
 * depend on. It runs before them, because an API that starts against a table that does not
 * exist answers `500` to the first request and the failure reads like a broken app.
 */

// `__dirname` for the same reason `playwright.config.ts` uses it: Playwright loads this as
// CommonJS, so `import.meta` would be a syntax error rather than a type error.
const root = join(__dirname, '..');
const DIST = join(root, 'apps', 'mobile', 'dist');

const TABLE = process.env.E2E_TABLE_NAME ?? 'od-main-e2e';
const ENDPOINT = process.env.DDB_ENDPOINT ?? 'http://localhost:8000';
const API_PORT = process.env.E2E_API_PORT ?? '3100';
const API_ENV = {
  STAGE: 'local',
  AUTH_MODE: 'local',
  LOG_LEVEL: 'warn',
  TABLE_NAME: TABLE,
  DDB_ENDPOINT: ENDPOINT,
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'local',
  AWS_SECRET_ACCESS_KEY: 'localsecret',
  MEDIA_BUCKET: 'od-media-local',
  PORT: API_PORT,
};

function run(command: string, args: string[], env: Record<string, string>): void {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}.`);
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  /**
   * The export is a **precondition, not a step**. Building it here would put a two-minute
   * bundle inside the harness's startup and hide which of the two failed; the CI job and the
   * `e2e:web` script both build first, and this only says so when they have not.
   */
  if (!existsSync(DIST)) {
    throw new Error(
      `No web export at ${DIST}.\n` +
        '  Run `pnpm --filter @od/mobile build` first, or use `pnpm e2e:web` which does.\n',
    );
  }

  /**
   * `--reset` drops and rebuilds the table, then writes the fixture rows.
   *
   * Seeding matters even though **no assertion reads a seeded row** (`testing.md` §8.2, and
   * P1-29's edge case says so explicitly): the flow's own row has to be found in a list that
   * has other things in it, which is the only version of that assertion worth making. A row
   * that is the only row in an empty list proves the list renders, not that the row landed in
   * the right stage.
   *
   * Invoked through `tsx` rather than the package's `seed:local` script for the reason the
   * Playwright config gives for the API: that script loads `.env.local`, which names the
   * developer's own table.
   */
  run(
    'pnpm',
    ['--filter', '@od/api', 'exec', 'tsx', 'scripts/seed-local.ts', '--reset'],
    {
      STAGE: 'local',
      AUTH_MODE: 'local',
      LOG_LEVEL: 'warn',
      TABLE_NAME: TABLE,
      DDB_ENDPOINT: ENDPOINT,
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'local',
      AWS_SECRET_ACCESS_KEY: 'localsecret',
      MEDIA_BUCKET: 'od-media-local',
    },
  );

  /**
   * Own both servers in this process. Playwright's Windows child cleanup stops the `pnpm`
   * wrapper but can leave the `tsx` grandchild serving forever; starting the Hono adapter here
   * gives teardown the actual Node server and makes process ownership unambiguous.
   *
   * Set the complete environment before importing: API config is intentionally read once at
   * module evaluation, and the developer's `.env.local` must never select `od-main-local` here.
   */
  Object.assign(process.env, API_ENV);
  // Keep the specifiers dynamic so this CommonJS harness does not re-typecheck ESM API code
  // or the API package's dev-only adapter under the harness's intentionally different module
  // resolution settings. Both have their own package typecheck.
  const appEntry = '../services/api/src/app.ts';
  const nodeServerEntry = '../services/api/node_modules/@hono/node-server/dist/index.js';
  const { createApp } = (await import(appEntry)) as {
    createApp: (overrides: { rateLimitNow: () => number }) => {
      fetch: (request: Request) => Response | Promise<Response>;
    };
  };
  const { serve } = (await import(nodeServerEntry)) as {
    serve: (options: {
      fetch: (request: Request) => Response | Promise<Response>;
      port: number;
      hostname: string;
    }) => import('node:http').Server;
  };

  /**
   * Every spec uses the one deliberately fixed local identity. A full suite is not one user's
   * traffic session, so allowing its requests to accumulate in one real-time fixed window
   * makes the last spec pass or fail according to the second the runner started. Keep every
   * request in the real limiter while rolling the injected clock before its 120-request cap.
   */
  const rateLimitEpoch = Date.now();
  let rateLimitedRequests = 0;
  const api = createApp({
    rateLimitNow: () => rateLimitEpoch + Math.floor(rateLimitedRequests++ / 100) * 60_000,
  });
  const apiServer = serve({
    fetch: api.fetch,
    port: Number(API_PORT),
    hostname: '0.0.0.0',
  });
  if (!apiServer.listening) await once(apiServer, 'listening');

  /**
   * Keep the static server in this process. Playwright's child-process shutdown can leave a
   * Windows run waiting after every spec has finished; a returned teardown closes every live
   * connection and then the listener itself before the runner exits.
   */
  // @ts-expect-error The dependency is an intentionally dependency-free JavaScript server.
  const { server } = await import('./serve-export.mjs');
  if (!server.listening) await once(server, 'listening');

  return async () => {
    // Stop accepting first, then close connections. Do not await the close callback: Windows
    // can retain an already-aborted read stream after Chromium exits even though no socket is
    // live, which turns test cleanup into an unbounded wait. `close` plus the forced connection
    // sweep is the teardown; unref makes that cleanup incapable of retaining the runner.
    server.close();
    server.closeAllConnections();
    server.unref();
    apiServer.close();
    apiServer.closeAllConnections();
    apiServer.unref();
  };
}
