import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

const script = readFileSync(resolve('../../e2e/run-native.mjs'), 'utf8').replace(
  "import { spawnSync } from 'node:child_process';",
  '',
);

function command(args: string[], status = 0, env: Record<string, string> = {}) {
  const invocations: unknown[] = [];
  const process = {
    env,
    argv: ['node', 'run-native.mjs', ...args],
    exitCode: undefined,
  };
  runInNewContext(script, {
    process,
    spawnSync: (...invocation: unknown[]) => {
      invocations.push(invocation);
      return { status };
    },
  });
  return { invocations, process };
}

it('keeps the catalogue and driver port when filtering native journeys', () => {
  expect(command(['--include-tags', 'calendar']).invocations).toEqual([
    [
      'maestro',
      [
        'test',
        '--driver-host-port',
        '22087',
        '-e',
        'API_BASE_URL=http://127.0.0.1:13000',
        '-e',
        'PROXY_CONTROL_URL=http://127.0.0.1:18474',
        '.',
        '--config',
        '.maestro/config.yaml',
        '--include-tags',
        'calendar',
      ],
      { stdio: 'inherit' },
    ],
  ]);
});

it('runs a focused flow without also running the catalogue and propagates failure', () => {
  const result = command(['--flow', 'apps/mobile/e2e/calendar-selection-race.yaml'], 1);
  expect(result.invocations).toEqual([
    [
      'maestro',
      [
        'test',
        '--driver-host-port',
        '22087',
        '-e',
        'API_BASE_URL=http://127.0.0.1:13000',
        '-e',
        'PROXY_CONTROL_URL=http://127.0.0.1:18474',
        'apps/mobile/e2e/calendar-selection-race.yaml',
      ],
      { stdio: 'inherit' },
    ],
  ]);
  expect(result.process.exitCode).toBe(1);
});

it('rejects an incomplete focused invocation', () => {
  expect(() => command(['--flow', '--include-tags', 'calendar'])).toThrow(
    '--flow requires a Maestro YAML path.',
  );
});

it('uses explicitly configured CI endpoints instead of local stack defaults', () => {
  const result = command([], 0, {
    MAESTRO_API_BASE_URL: 'http://127.0.0.1:3000',
    MAESTRO_CONTROL_URL: 'http://127.0.0.1:8474',
  });
  expect(JSON.stringify(result.invocations)).toContain(
    'API_BASE_URL=http://127.0.0.1:3000',
  );
  expect(JSON.stringify(result.invocations)).not.toContain('13000');
  expect(JSON.stringify(result.invocations)).toContain(
    'PROXY_CONTROL_URL=http://127.0.0.1:8474',
  );
});
