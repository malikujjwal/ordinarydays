import { spawnSync } from 'node:child_process';
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

export default function globalSetup(): void {
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
}
