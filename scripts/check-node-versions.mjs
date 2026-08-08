#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fails when the four places that declare a Node version stop agreeing.
 *
 * `tech-stack.md` §2.1 pins Node 22 for one reason: it "matches the Lambda `nodejs22.x`
 * runtime exactly, so local behaviour equals deployed behaviour". That guarantee is only
 * worth having while every declaration says the same number, and they are spread across
 * four files that are edited by different tasks for different reasons:
 *
 * - `.nvmrc` — what a developer's shell and `actions/setup-node` pick up
 * - `package.json` `engines.node` — what `pnpm install` enforces
 * - `NodeLambda`'s `lambda.Runtime.NODEJS_*_X` — what actually executes in production
 * - `esbuild`'s `target` in the same construct — what the bundle is compiled down to
 *
 * The failure this prevents is quiet and specific: bump the runtime to 24 and forget
 * `.nvmrc`, and CI keeps testing on 22 while production runs 24. Nothing errors. The first
 * symptom is a syntax or API difference in a Lambda that passed every check.
 *
 * Text-matched rather than imported, deliberately: `NodeLambda` is TypeScript that pulls in
 * `aws-cdk-lib`, and a check that runs in the first thirty seconds of CI should not need a
 * CDK app constructed to tell you two numbers disagree.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

/** @type {Array<{ source: string, major: number | undefined, detail: string }>} */
const declarations = [];

function record(source, major, detail) {
  declarations.push({ source, major, detail });
}

// .nvmrc — a bare major, or a full version.
const nvmrc = read('.nvmrc').trim().replace(/^v/, '');
record('.nvmrc', Number.parseInt(nvmrc, 10), nvmrc);

// package.json engines — the range's lower bound is the pin that matters.
const engines = JSON.parse(read('package.json')).engines?.node ?? '';
record(
  'package.json engines.node',
  Number.parseInt(/(\d+)/.exec(engines)?.[1] ?? '', 10),
  engines,
);

// The Lambda runtime and the esbuild target, both in NodeLambda.
const nodeLambda = read('infra/lib/constructs/node-lambda.ts');

const runtime = /lambda\.Runtime\.NODEJS_(\d+)_X/.exec(nodeLambda);
record(
  'NodeLambda runtime',
  runtime === null ? undefined : Number.parseInt(runtime[1], 10),
  runtime === null ? 'not found' : `NODEJS_${runtime[1]}_X`,
);

const target = /target:\s*'node(\d+)'/.exec(nodeLambda);
record(
  'NodeLambda esbuild target',
  target === null ? undefined : Number.parseInt(target[1], 10),
  target === null ? 'not found' : `node${target[1]}`,
);

// The runtime this process is actually running on — the one that runs the tests.
const running = Number.parseInt(process.versions.node, 10);

const missing = declarations.filter(
  (d) => Number.isNaN(d.major) || d.major === undefined,
);
if (missing.length > 0) {
  console.error('\n✖ a Node version declaration could not be read:\n');
  for (const d of missing) console.error(`  ${d.source.padEnd(28)} ${d.detail}`);
  console.error(
    '\n  The file moved or its shape changed. Fix this check, do not delete it.\n',
  );
  process.exit(1);
}

const majors = new Set(declarations.map((d) => d.major));

if (majors.size > 1) {
  console.error('\n✖ Node version declarations disagree:\n');
  for (const d of declarations) {
    console.error(`  ${d.source.padEnd(28)} ${String(d.major).padEnd(4)} (${d.detail})`);
  }
  console.error(
    '\n  tech-stack.md §2.1 pins Node to the Lambda runtime so local behaviour equals\n' +
      '  deployed behaviour. Update all four together, or the guarantee is gone.\n',
  );
  process.exit(1);
}

const [expected] = [...majors];

if (running !== expected) {
  console.error(
    `\n✖ this process is Node ${process.versions.node}, but everything declares Node ${expected}.`,
  );
  console.error("  Run `nvm use`, or fix the CI runner's node-version-file.\n");
  process.exit(1);
}

console.log(
  `✔ node-versions: all four declarations say Node ${expected}, and this runner is ${process.versions.node}`,
);
