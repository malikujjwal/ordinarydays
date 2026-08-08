#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The cheap textual checks from `repo-structure.md` §4, which sit alongside
 * dependency-cruiser rather than inside it.
 *
 * They exist because some rules are about **what a file says**, not about what it imports.
 * `ScanCommand` is a banned call, not a banned module; a raw `USER#` key literal outside the
 * repository layer is a string, invisible to a dependency graph. dependency-cruiser cannot
 * see either.
 *
 * Written in Node rather than as `grep -rn` pipelines, for two reasons. The repository is
 * developed on Windows, where `grep` is not on the path outside Git Bash, so the documented
 * commands fail locally and pass in CI — the worst split there is. And a `! grep ...` shell
 * negation reports "found something" with no indication of *what*, whereas this prints the
 * file, the line number and the line.
 *
 * One rule per invocation, so a CI step names the rule that broke:
 *
 *   node scripts/check-forbidden.mjs no-scan
 *   node scripts/check-forbidden.mjs no-key-literals
 *   node scripts/check-forbidden.mjs no-dangerous-html
 *   node scripts/check-forbidden.mjs client-layer-rules
 *   node scripts/check-forbidden.mjs --all
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'cdk.out',
  'coverage',
  '.expo',
  '.turbo',
  '.git',
]);

/** @type {Record<string, { description: string; doc: string; roots: string[]; extensions: string[]; pattern: RegExp; excludePath?: RegExp }>} */
const RULES = {
  'no-scan': {
    description: 'No DynamoDB Scan in application code',
    doc: 'data-model.md §5 — a Scan reads every item in the table and is denied by the Lambda’s IAM policy at runtime',
    roots: ['services/api/src', 'apps', 'packages'],
    extensions: ['.ts', '.tsx'],
    pattern: /\bScanCommand\b|\.scan\s*\(/,
    // The repository layer is where a migration script would legitimately live, and
    // `infra/scripts/migrations/` is the one permitted home (`security-privacy.md` §2.2).
    excludePath: /infra[\\/]scripts[\\/]migrations[\\/]/,
  },

  'no-key-literals': {
    description: 'No raw DynamoDB key literals outside the repository layer',
    doc: 'repo-structure.md §2.4 — keys are built only in repositories/keys.ts, which is what makes tenant isolation auditable in one place',
    roots: ['services/api/src'],
    extensions: ['.ts'],
    pattern: /['"`](ACT|USER|LIST|INVITE|EMAIL|IDEM|OCC|REM|SUGG|PLINK|LLINK|LNK)#/,
    excludePath: /services[\\/]api[\\/]src[\\/]repositories[\\/]/,
  },

  'no-dangerous-html': {
    description: 'No dangerouslySetInnerHTML anywhere in the client',
    doc: 'security-privacy.md §1 row 6 — the one API that turns user or model content into markup',
    roots: ['apps', 'packages'],
    extensions: ['.ts', '.tsx'],
    pattern: /dangerouslySetInnerHTML/,
  },

  /**
   * Covers the two client rules dependency-cruiser cannot see, because it cannot parse
   * `.tsx` at all under TypeScript 7 (see the note in `.dependency-cruiser.cjs`). Textual
   * matching is weaker than a resolved module graph — it sees the specifier, not where it
   * ends up — but it covers the exact files the graph is blind to, so the rule is narrowed
   * rather than merely documented.
   */
  'client-layer-rules': {
    description: 'No server or infra imports in the client, and no cross-feature imports',
    doc: 'repo-structure.md §3 rules 6 and the feature-slice rule; the .tsx half of what dependency-cruiser enforces',
    roots: ['apps/mobile'],
    extensions: ['.tsx'],
    pattern: /from\s+['"](?:@od\/(?:api|infra)|(?:\.\.\/)+(?:services|infra)\/)/,
  },
};

function walk(dir, extensions, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), extensions, acc);
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

/**
 * Cross-feature imports need the importing file's own feature to compare against, so they
 * are matched here rather than by one regex in the table above.
 */
function crossFeatureHits(file, lines) {
  const relativePath = relative(root, file).split(sep).join('/');
  const owner = /^apps\/mobile\/src\/features\/([^/]+)\//.exec(relativePath)?.[1];
  if (owner === undefined) return [];

  const hits = [];
  lines.forEach((line, index) => {
    const target = /from\s+['"]@\/features\/([^/'"]+)/.exec(line)?.[1];
    if (target !== undefined && target !== owner) {
      hits.push({ line: index + 1, text: line.trim() });
    }
  });
  return hits;
}

function run(ruleName) {
  const rule = RULES[ruleName];
  if (rule === undefined) {
    console.error(`Unknown rule "${ruleName}". Known: ${Object.keys(RULES).join(', ')}`);
    process.exit(2);
  }

  const files = rule.roots.flatMap((r) => walk(join(root, r), rule.extensions));
  const scanned = files.filter(
    (file) => rule.excludePath === undefined || !rule.excludePath.test(file),
  );

  /** @type {string[]} */
  const violations = [];

  for (const file of scanned) {
    const relativePath = relative(root, file).split(sep).join('/');
    // A test may legitimately name the thing it asserts is banned.
    if (/\.test\.tsx?$/.test(relativePath)) continue;
    if (relativePath.startsWith('scripts/')) continue;

    const lines = readFileSync(file, 'utf8').split(/\r?\n/);

    lines.forEach((line, index) => {
      if (rule.pattern.test(line)) {
        violations.push(`${relativePath}:${index + 1}  ${line.trim()}`);
      }
    });

    if (ruleName === 'client-layer-rules') {
      for (const hit of crossFeatureHits(file, lines)) {
        violations.push(`${relativePath}:${hit.line}  ${hit.text}`);
      }
    }
  }

  if (violations.length > 0) {
    console.error(`\n✖ ${ruleName}: ${rule.description}`);
    console.error(`  ${rule.doc}\n`);
    for (const violation of violations) console.error(`  ${violation}`);
    console.error('');
    return false;
  }

  console.log(`✔ ${ruleName}: ${rule.description} (${scanned.length} files)`);
  return true;
}

const requested = process.argv[2];
const names =
  requested === '--all' || requested === undefined ? Object.keys(RULES) : [requested];

const passed = names.map(run).every(Boolean);
if (!passed) process.exit(1);
