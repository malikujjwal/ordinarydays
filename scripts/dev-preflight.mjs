#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

// ── Metro's advertised address ──────────────────────────────────────────────────────────
/**
 * The address this machine would use to reach the internet — which is the address a phone
 * on the same Wi-Fi can reach it on.
 *
 * A UDP socket is `connect`ed to a public address and its local address read back. No
 * packet is ever sent; the value comes from the OS routing table, which is the only thing
 * that actually knows which of a developer machine's adapters is the real one. Enumerating
 * `os.networkInterfaces()` and guessing does not work here: this machine offers Wi-Fi,
 * Ethernet, Bluetooth, two Hyper-V switches and four APIPA addresses, and the right answer
 * is not the first non-internal one.
 */
function detectLanAddress() {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    const done = (value) => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    socket.on('error', () => done(undefined));
    try {
      socket.connect(53, '1.1.1.1', () => done(socket.address().address));
    } catch {
      done(undefined);
    }
  });
}

/**
 * Writes that address into `apps/mobile/.env.local` as `REACT_NATIVE_PACKAGER_HOSTNAME`.
 *
 * **Expo does not reliably find it on its own.** On a machine with Hyper-V and WSL
 * adapters, `expo start` advertises `hostUri: 127.0.0.1:8081` — with `--host lan`, and with
 * the Wi-Fi profile set to Private. A phone told to fetch from `127.0.0.1` fetches from
 * itself, and the symptom is a bundle that never loads with no error worth reading. Found
 * while preparing P0-22's physical-device check.
 *
 * The file is git-ignored and machine-local, so the address is re-detected on every run and
 * follows the laptop onto a different network. Other keys in the file are preserved — this
 * rewrites one line, not the file.
 */
async function ensureMetroHostname() {
  const address = await detectLanAddress();
  if (address === undefined || address.startsWith('127.') || address === '0.0.0.0')
    return;

  const path = join(root, 'apps', 'mobile', '.env.local');
  const key = 'REACT_NATIVE_PACKAGER_HOSTNAME';
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';

  const lines = existing.split(/\r?\n/).filter((line) => line.trim() !== '');
  const current = lines.find((line) => line.startsWith(`${key}=`));
  if (current === `${key}=${address}`) return;

  const next = [
    ...lines.filter((line) => !line.startsWith(`${key}=`)),
    `${key}=${address}`,
  ];
  writeFileSync(path, `${next.join('\n')}\n`, 'utf8');
  act(`pointed Metro at ${address} for physical devices (apps/mobile/.env.local)`);
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
await ensureMetroHostname();
ensureSharedBuilt();
await ensureDynamo();
await ensureTable();

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  actions.length === 0
    ? `preflight ok in ${elapsed}s — node, database, table and env were already in place`
    : `preflight ok in ${elapsed}s — ${actions.length} thing${actions.length === 1 ? '' : 's'} set up for you`,
);
