import { spawnSync } from 'node:child_process';

// Match calendar-selection-race.yaml's local XCTest driver URL. Maestro otherwise picks
// a random port, making its accessibility-based in-flight tap helper unreachable.
const args = process.argv.slice(2);
// `--flow path` selects one journey; all other options filter/configure the catalogue.
const flowIndex = args.indexOf('--flow');
const flow = flowIndex < 0 ? undefined : args[flowIndex + 1];
if (flowIndex >= 0 && (!flow || flow.startsWith('-'))) {
  throw new Error('--flow requires a Maestro YAML path.');
}
if (flowIndex >= 0) args.splice(flowIndex, 2);
const result = spawnSync(
  'maestro',
  [
    'test',
    '--driver-host-port',
    '22087',
    ...(flow ? [flow] : ['.', '--config', '.maestro/config.yaml']),
    ...args,
  ],
  { stdio: 'inherit' },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
