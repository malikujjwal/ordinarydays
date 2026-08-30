#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const expectedDir = fromRoot(
  environment('EXPECTED_DIR') ?? 'apps/mobile/e2e/visual-baselines/ios',
);
const actualDir = fromRoot(environment('ACTUAL_DIR') ?? 'test-results/lists-ios-actual');
const diffDir = fromRoot(environment('DIFF_DIR') ?? 'test-results/lists-ios-diff');
const simulatorName = environment('SIMULATOR_NAME') ?? 'iPhone 16 Pro';
const frames = [
  ['overview-light', 'frame=overview&scheme=light'],
  ['overview-dark', 'frame=overview&scheme=dark'],
  ['create', 'frame=create&scheme=light'],
  ['empty', 'frame=empty&scheme=light'],
  ['checklist-light', 'frame=checklist&scheme=light'],
  ['checklist-dark', 'frame=checklist&scheme=dark'],
  ['stages', 'frame=stages&scheme=light'],
  ['context-add', 'frame=context-add&scheme=light'],
  ['global-add', 'frame=global-add&scheme=light'],
  ['settings-light', 'frame=settings&scheme=light'],
  ['settings-dark', 'frame=settings&scheme=dark'],
  ['items', 'frame=items&scheme=light'],
];

if (process.platform !== 'darwin') {
  fail('The iOS List visual runner requires macOS and Xcode.');
}

mkdirSync(actualDir, { recursive: true });
mkdirSync(diffDir, { recursive: true });

const deviceId = environment('DEVICE_ID') ?? findSimulator(simulatorName);
// `boot` reports an error when the selected simulator is already running. `bootstatus` is the
// authoritative readiness check, so that one benign result does not make local reruns fail.
spawnSync('xcrun', ['simctl', 'boot', deviceId], { cwd: root, stdio: 'ignore' });
run('xcrun', ['simctl', 'bootstatus', deviceId, '-b']);
run('xcrun', [
  'simctl',
  'status_bar',
  deviceId,
  'override',
  '--time',
  '9:41',
  '--batteryState',
  'charged',
  '--batteryLevel',
  '100',
  '--wifiBars',
  '3',
  '--cellularBars',
  '4',
]);

for (const [name, query] of frames) {
  run('xcrun', [
    'simctl',
    'openurl',
    deviceId,
    `ordinarydays-local://lists-contract-gallery?${query}`,
  ]);
  await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
  run('xcrun', ['simctl', 'io', deviceId, 'screenshot', join(actualDir, `${name}.png`)]);
}

let comparisonFailed = false;
for (const [name] of frames) {
  const expected = join(expectedDir, `${name}.png`);
  if (!existsSync(expected)) {
    process.stderr.write(`Missing approved iOS baseline: ${expected}\n`);
    comparisonFailed = true;
    continue;
  }

  const result = spawnSync(
    'swift',
    [
      join(root, 'e2e', 'compare-png.swift'),
      expected,
      join(actualDir, `${name}.png`),
      join(diffDir, `${name}.png`),
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.status !== 0) comparisonFailed = true;
}

if (comparisonFailed) process.exitCode = 1;

function fromRoot(path) {
  return isAbsolute(path) ? path : resolve(root, path);
}

function environment(name) {
  return process.env[name];
}

function findSimulator(name) {
  const result = spawnSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) fail(result.stderr || 'Could not list available simulators.');

  const payload = JSON.parse(result.stdout);
  const devices = Object.values(payload.devices).flat();
  const match = devices.find((device) => device.name === name);
  if (match === undefined) fail(`No available ${name} simulator was found.`);
  return match.udid;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed.`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
