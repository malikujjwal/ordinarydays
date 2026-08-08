#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Everything `pnpm dev` needs before Turbo starts anything.
 *
 * The API and Metro are the easy part — `turbo run dev --parallel` handles those. The part
 * a new developer forgets is the database, and the failure when they do is a screen that
 * says nothing useful. So this runs first, and its contract is narrow:
 *
 * - It **acts** rather than lectures, for the things that are safe to do: start the
 *   containers, create the table, copy `.env.example`.
 * - It **prints one line for every action it takes**. A script that silently fixes your
 *   environment is one you cannot reason about when it eventually fixes the wrong thing.
 * - It **fails with an instruction, not a stack trace**, for the things only a human can do.
 * - It is idempotent, and near-silent when everything is already up.
 *
 * Order note: `phase-00-foundations.md` P0-23 lists the Docker daemon check before the
 * DynamoDB one. This asks DynamoDB first, because a container answering on :8000 is proof
 * the daemon is running, and `docker info` costs most of the two-second budget on its own.
 * The daemon check still happens, exactly when it can tell you something you do not know.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DDB_URL = 'http://127.0.0.1:8000/';
const TABLE = 'od-main-local';
const ENV_FILE = join(root, 'services', 'api', '.env.local');
const ENV_EXAMPLE = join(root, 'services', 'api', '.env.example');

const started = Date.now();
const actions = [];

/** One line per action taken, printed as it happens so a slow step explains itself. */
function act(message) {
  actions.push(message);
  console.log(`  → ${message}`);
}

function fail(message, instruction) {
  console.error(`\npnpm dev cannot start: ${message}`);
  console.error(`  ${instruction}\n`);
  process.exit(1);
}

function sh(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options,
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Node ────────────────────────────────────────────────────────────────────────────────
// `.nvmrc` is the single source of truth, and it is the same file CI reads. A mismatch is
// worth stopping for: Node 20 will install this workspace and then fail somewhere specific
// and confusing rather than here.
function checkNode() {
  const expected = readFileSync(join(root, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
  const actual = process.versions.node;
  const expectedMajor = expected.split('.')[0];
  const actualMajor = actual.split('.')[0];

  if (expectedMajor !== actualMajor) {
    fail(
      `Node ${expectedMajor} is required and this is Node ${actual}.`,
      `Run \`nvm use\` (or install Node ${expectedMajor}) and try again.`,
    );
  }
}

// ── DynamoDB Local ──────────────────────────────────────────────────────────────────────
/**
 * Any HTTP answer means the container is up. DynamoDB Local rejects a malformed request
 * with a 400, which is still an answer — so this deliberately does not care about the
 * status, only that something is listening and speaking HTTP.
 */
async function dynamoAnswers(timeoutMs = 1000) {
  try {
    await fetch(DDB_URL, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

function dockerIsRunning() {
  const result = sh('docker', ['info', '--format', '{{.ServerVersion}}'], {
    stdio: 'pipe',
  });
  return result.status === 0;
}

async function ensureDynamo() {
  if (await dynamoAnswers()) return;

  if (!dockerIsRunning()) {
    fail(
      'the Docker daemon is not reachable, and the local database runs in a container.',
      'Start Docker Desktop and re-run `pnpm dev`.',
    );
  }

  act('starting DynamoDB Local and dynamodb-admin (docker compose up -d)');
  const up = sh('docker', ['compose', 'up', '-d'], { stdio: 'pipe' });
  if (up.status !== 0) {
    fail(
      'docker compose could not start the local database.',
      `Run \`docker compose up -d\` to see why:\n${(up.stderr ?? '').trim()}`,
    );
  }

  // The container accepts connections a moment after compose returns. Polling beats a
  // fixed sleep: it is faster when the image is warm and still correct when it is not.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await dynamoAnswers(500)) return;
    await sleep(250);
  }
  fail(
    'DynamoDB Local did not answer on :8000 within 60 seconds.',
    'Check `docker compose logs dynamodb`.',
  );
}

// ── The shared package ──────────────────────────────────────────────────────────────────
/**
 * `packages/shared` has to be **compiled** before anything reaches it through Node.
 *
 * Its `exports` map resolves `react-native` to `src/*.ts` and everything else to
 * `dist/*.js` (`tech-stack.md` §3.3, amended in P0-12). Metro takes the first branch and is
 * fine; the create-table script and the API's dev server take the second, and `dist/` is
 * build output, so it does not exist in a fresh clone.
 *
 * Found by the P0-23 clean-clone check and by nothing before it — every machine that had
 * already run `pnpm build` or `pnpm verify` had a `dist/` lying around, which is precisely
 * the class of bug that check exists to find.
 */
function ensureSharedBuilt() {
  if (existsSync(join(root, 'packages', 'shared', 'dist', 'table', 'index.js'))) return;

  act(
    'building @od/shared (its dist/ is what Node resolves, and a fresh clone has none)',
  );
  const result = sh('pnpm', ['--filter', '@od/shared', 'build'], { stdio: 'pipe' });
  if (result.status !== 0) {
    fail(
      '@od/shared could not be built, and the API cannot start without it.',
      `Run \`pnpm --filter @od/shared build\` to see why:\n${(result.stderr ?? '').trim()}`,
    );
  }
}

// ── The table ───────────────────────────────────────────────────────────────────────────
/**
 * `ListTables` over plain HTTP, with a credential string that is present but meaningless.
 *
 * DynamoDB Local requires credentials to *exist* and never validates them, which is the
 * same reason `.env.example` carries the literal strings `local` / `localsecret`. Asking
 * this way keeps the preflight free of an AWS SDK dependency it would otherwise have to
 * borrow from `services/api` — a phantom dependency at the repository root.
 */
async function tableExists() {
  try {
    const response = await fetch(DDB_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.0',
        'X-Amz-Target': 'DynamoDB_20120810.ListTables',
        Authorization:
          'AWS4-HMAC-SHA256 Credential=local/20260101/us-east-1/dynamodb/aws4_request, SignedHeaders=host, Signature=preflight',
      },
      body: '{}',
      signal: AbortSignal.timeout(2000),
    });
    const body = await response.json();
    return Array.isArray(body.TableNames) && body.TableNames.includes(TABLE);
  } catch {
    return false;
  }
}

async function ensureTable() {
  if (await tableExists()) return;

  act(`creating ${TABLE} from @od/shared/table (pnpm --filter @od/api ddb:create-table)`);
  const result = sh('pnpm', ['--filter', '@od/api', 'ddb:create-table'], {
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    fail(
      `the ${TABLE} table could not be created.`,
      `Run \`pnpm --filter @od/api ddb:create-table\` to see why:\n${(result.stderr ?? '').trim()}`,
    );
  }
}

// ── Environment ─────────────────────────────────────────────────────────────────────────
/**
 * Copied, never generated. `.env.example` is the documented set of variables and its
 * placeholder values are already correct for a laptop, so the copy is the whole setup step
 * — which is what makes "clone, install, dev" true with no file editing.
 */
function ensureEnv() {
  if (existsSync(ENV_FILE)) return;

  if (!existsSync(ENV_EXAMPLE)) {
    fail(
      'services/api/.env.example is missing, so there is nothing to copy from.',
      'That file is tracked; check your working tree.',
    );
  }

  copyFileSync(ENV_EXAMPLE, ENV_FILE);
  act('copied services/api/.env.example → services/api/.env.local');
}

// ── Run ─────────────────────────────────────────────────────────────────────────────────
checkNode();
ensureEnv();
ensureSharedBuilt();
await ensureDynamo();
await ensureTable();

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  actions.length === 0
    ? `preflight ok in ${elapsed}s — node, database, table and env were already in place`
    : `preflight ok in ${elapsed}s — ${actions.length} thing${actions.length === 1 ? '' : 's'} set up for you`,
);
