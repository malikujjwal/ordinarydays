import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiPort = process.env.E2E_API_PORT ?? '3100';
if (!/^\d+$/.test(apiPort)) {
  throw new Error(
    `E2E_API_PORT must be a port number, received ${JSON.stringify(apiPort)}.`,
  );
}

const env = {
  ...process.env,
  E2E_API_PORT: apiPort,
  // Expo embeds this value at export time. Keeping it beside E2E_API_PORT prevents the
  // browser bundle and Playwright's API process from ever drifting onto different ports.
  EXPO_PUBLIC_API_BASE_URL:
    process.env.EXPO_PUBLIC_API_BASE_URL ?? `http://127.0.0.1:${apiPort}`,
};

function run(args) {
  const result = spawnSync('pnpm', args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Expo's Metro cache does not key the embedded manifest by app-config environment values.
// Clear it so a previous local build cannot leave this export pointing back at :3000.
run(['--filter', '@od/mobile', 'run', 'build', '--', '--clear']);
run(['exec', 'playwright', 'test', '--config', 'e2e/playwright.config.ts']);
