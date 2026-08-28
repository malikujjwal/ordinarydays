import { spawnSync } from 'node:child_process';

const pnpmCli = process.env.npm_execpath;
if (pnpmCli === undefined) throw new Error('Run this script through pnpm.');
// Metro does not key its cached manifest by Expo app-config environment values. A normal web
// build must never be able to leave the visual export with the gallery compiled out.
const result = spawnSync(
  process.execPath,
  [pnpmCli, '--filter', '@od/mobile', 'build', '--', '--clear'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      EXPO_PUBLIC_PROFILE: 'local',
      EXPO_PUBLIC_CONTRACT_GALLERY: '1',
      TZ: 'America/New_York',
    },
  },
);

if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
