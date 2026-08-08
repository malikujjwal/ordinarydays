#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

/**
 * Fails when the Lambda artifact exceeds its budget: **5 MB zipped**
 * (`definition-of-done.md` §7, `tech-stack.md` §2.3).
 *
 * The number is a cold-start proxy. Every byte in the artifact is a byte Lambda downloads
 * and unpacks before the first request, and `NodeLambda` sets `bundleAwsSDK: true`, so the
 * SDK clients are inside this figure rather than borrowed from the runtime. The budget that
 * actually matters — 400 ms p95 init — cannot be measured until Phase 4 deploys something,
 * and this is the half that can be enforced from Phase 0.
 *
 * **It measures what CDK will upload, not a re-creation of it.** The bundle is produced by
 * `NodejsFunction`'s esbuild invocation inside `NodeLambda`, with its own `minify`, `target`,
 * `format`, `banner` and `bundleAwsSDK` settings. Re-running esbuild here with a copy of
 * those options would be a second configuration to keep in step, and the day it drifted this
 * check would still pass — measuring a bundle nobody deploys. Instead it reads CDK's own
 * asset manifest, which names the exact directory destined for the assets bucket.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cdkOut = join(root, 'infra', 'cdk.out');

/** `definition-of-done.md` §7: Lambda artifact, zipped, ≤ 5 MB. */
const LIMIT_BYTES = 5 * 1024 * 1024;

/**
 * Warn well before the gate. A budget that only ever speaks when it fails gives no notice,
 * and the fix for an oversized bundle — finding what pulled a dependency in — is much easier
 * while it is still small.
 */
const WARN_AT = 0.8;

const STAGES = ['dev', 'prod'];

function fail(message, detail) {
  console.error(`\n✖ ${message}`);
  if (detail !== undefined) console.error(`  ${detail}`);
  console.error('');
  process.exit(1);
}

function synth() {
  console.log('  → synthesising (pnpm --filter @od/infra exec cdk synth --quiet)');
  const result = spawnSync(
    'pnpm',
    ['--filter', '@od/infra', 'exec', 'cdk', 'synth', '--quiet'],
    { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', stdio: 'pipe' },
  );
  if (result.status !== 0) {
    fail(
      'cdk synth failed, so there is no artifact to measure.',
      `Run it directly to see why:\n${(result.stderr ?? '').trim()}`,
    );
  }
}

function filesIn(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) filesIn(full, acc);
    else acc.push(full);
  }
  return acc;
}

/**
 * The size of the ZIP that CDK will build from this directory, modelled rather than
 * measured: DEFLATE each file, then add the archive's own bookkeeping — a 30-byte local
 * header and a 46-byte central-directory entry per file, each carrying the name twice, plus
 * a 22-byte end-of-central-directory record.
 *
 * Modelled because Node has no ZIP writer in its standard library, and the alternatives are
 * both worse than a documented approximation: a new dependency for a number that only needs
 * to be compared against a 5 MB threshold, or shelling out to `zip`/`Compress-Archive`,
 * which is the platform split `check-forbidden.mjs` exists to avoid. The model is
 * conservative — real ZIPs are no larger — and the headroom here is measured in megabytes.
 */
function zippedSize(dir) {
  const files = filesIn(dir);
  let total = 22;
  for (const file of files) {
    const nameLength = Buffer.byteLength(relative(dir, file));
    total += deflateRawSync(readFileSync(file)).length + 30 + 46 + nameLength * 2;
  }
  return { bytes: total, fileCount: files.length };
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

/** Every directory a stack will upload as a zip, from CDK's own manifest. */
function lambdaAssets(stage) {
  const manifestPath = join(cdkOut, `od-api-${stage}.assets.json`);
  if (!existsSync(manifestPath)) return [];

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return Object.values(manifest.files ?? {})
    .filter((asset) => asset.source?.packaging === 'zip')
    .map((asset) => ({
      displayName: asset.displayName ?? asset.source.path,
      dir: join(cdkOut, asset.source.path),
    }))
    .filter((asset) => existsSync(asset.dir));
}

// ── Run ─────────────────────────────────────────────────────────────────────────────────
// Synthesise unless told not to. Fresh by default: a `cdk.out` left over from an earlier
// commit would let this pass on a bundle that no longer exists, which is the one failure a
// size gate must not have.
if (!process.argv.includes('--no-synth')) synth();

const measured = [];

for (const stage of STAGES) {
  for (const asset of lambdaAssets(stage)) {
    const { bytes, fileCount } = zippedSize(asset.dir);
    const raw = filesIn(asset.dir).reduce((sum, f) => sum + statSync(f).size, 0);
    measured.push({ stage, name: asset.displayName, bytes, raw, fileCount });
  }
}

if (measured.length === 0) {
  fail(
    'no Lambda code asset was found in infra/cdk.out.',
    'Expected od-api-<stage>.assets.json to name a zip-packaged asset. Has ApiStack changed?',
  );
}

let failed = false;

for (const asset of measured) {
  const pct = Math.round((asset.bytes / LIMIT_BYTES) * 100);
  const line = `${asset.stage.padEnd(4)} ${asset.name.padEnd(14)} ${mb(asset.bytes).padStart(8)} zipped  (${mb(asset.raw)} raw, ${asset.fileCount} file${asset.fileCount === 1 ? '' : 's'})  ${pct}% of budget`;

  if (asset.bytes > LIMIT_BYTES) {
    console.error(`✖ ${line}`);
    failed = true;
  } else if (asset.bytes > LIMIT_BYTES * WARN_AT) {
    console.warn(`! ${line}`);
  } else {
    console.log(`✔ ${line}`);
  }
}

if (failed) {
  fail(
    `a Lambda artifact exceeds the ${mb(LIMIT_BYTES)} budget (definition-of-done.md §7).`,
    'Usual cause: a dependency imported at module scope that only one code path needs. ' +
      'Import it lazily inside that function — tech-stack.md §2.3 does this for SES, ' +
      'Scheduler and Secrets Manager.',
  );
}
