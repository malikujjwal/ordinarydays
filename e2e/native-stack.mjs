import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const endpoint = new URL(process.env.DDB_ENDPOINT ?? 'http://127.0.0.1:8000');
if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
  throw new Error('Native test seeding requires a loopback DynamoDB Local endpoint.');
}
// Never inherit TABLE_NAME or load .env.local: those can identify a user's real data.
// Each stack owns a new table, including when a previous run exited before cleanup.
const table = `od-main-maestro-${Date.now()}-${randomUUID().slice(0, 8)}`;
const env = {
  ...process.env,
  STAGE: 'local',
  AUTH_MODE: 'local',
  LOG_LEVEL: 'warn',
  TABLE_NAME: table,
  DDB_ENDPOINT: endpoint.href,
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'local',
  AWS_SECRET_ACCESS_KEY: 'localsecret',
  MEDIA_BUCKET: 'od-media-local',
  PORT: '13001',
  MAESTRO_PROXY_PORT: '13000',
  MAESTRO_CONTROL_PORT: '18474',
  MAESTRO_API_URL: 'http://127.0.0.1:13001',
};
const children = [];
let closing = false;
async function stop(code) {
  if (closing) return;
  closing = true;
  await Promise.all(
    children.map(
      (child) =>
        new Promise((done) => {
          if (child.pid === undefined || child.exitCode !== null) return done();
          const signal = (name) => {
            try {
              if (process.platform === 'win32') child.kill(name);
              else process.kill(-child.pid, name);
            } catch (error) {
              if (error.code !== 'ESRCH') console.error(error.message);
            }
          };
          // A shutdown grace period, not a test retry or an application performance budget.
          const deadline = setTimeout(() => {
            signal('SIGKILL');
            done();
          }, 5000);
          child.once('exit', () => {
            clearTimeout(deadline);
            done();
          });
          signal('SIGTERM');
        }),
    ),
  );
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
function start(command, args) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });
  children.push(child);
  child.on('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on('exit', () => {
    if (!closing) {
      console.error(`${command} stopped; shutting down the native test stack.`);
      stop(1);
    }
  });
}
// Refuse a competing stack before creating data or starting any owned processes.
for (const port of [13000, 13001, 18474]) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
}
const seed = spawnSync(
  'pnpm',
  ['--filter', '@od/api', 'exec', 'tsx', 'scripts/seed-local.ts', '--reset'],
  { cwd: root, env, stdio: 'inherit' },
);
if (seed.status !== 0) {
  console.error(seed.error?.message ?? 'Native fixture seeding failed.');
  await stop(1);
}
start('pnpm', ['--filter', '@od/api', 'exec', 'tsx', 'src/local.ts']);
start(process.execPath, ['e2e/mobile-network-proxy.mjs']);
const readinessDeadline = Date.now() + 60_000;
let ready = false;
while (!ready && Date.now() < readinessDeadline) {
  try {
    ready = (
      await fetch('http://127.0.0.1:13000/v1/health', {
        signal: AbortSignal.timeout(2000),
      })
    ).ok;
  } catch {
    /* API is still starting. */
  }
  if (!ready) await delay(100);
}
if (!ready) {
  console.error('Native API did not become healthy within startup deadline.');
  await stop(1);
}
console.log(`Native test stack ready (pid ${process.pid}); table: ${table}`);
console.log('Keep this process running. API/proxy: 13001/13000; network control: 18474.');
console.log(
  'Build the local Release app with EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:13000.',
);
console.log('Then run pnpm e2e:native --device <test-simulator-id>.');
