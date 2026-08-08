import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **No DynamoDB call outside the repository layer** (`CLAUDE.md`, `repo-structure.md` §2.4).
 *
 * This is the rule the routing and middleware skeleton exists to protect, and the cheapest
 * moment to lock it in is now — before there is a service or a handler tempted to reach for
 * the client directly. `dependency-cruiser` enforces it on the real module graph in P0-27;
 * this test runs today, and fails with the offending file named.
 *
 * It is deliberately stricter than "do not call `send`": it forbids *importing* the client
 * at all, and forbids building a `pk`/`sk` string anywhere but `repositories/keys.ts`. Key
 * construction in one place is what makes tenant isolation auditable
 * (`security-privacy.md` §1 row 4).
 */

const SRC = join(import.meta.dirname, '..');

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) acc.push(full);
  }
  return acc;
}

/** Strip block comments and whole-line `//`; the rule is about code, not prose. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

const rel = (f: string) => f.slice(SRC.length + 1).replaceAll('\\', '/');
const files = sourceFiles(SRC).map((f) => ({
  path: rel(f),
  body: code(readFileSync(f, 'utf8')),
}));

const isRepositoryLayer = (path: string) => path.startsWith('repositories/');

describe('the DynamoDB seam', () => {
  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  // Guards the guard: a stripper weakened until nothing matches would make every
  // assertion below pass for the wrong reason.
  it('still detects a violation after comments are stripped', () => {
    const planted = [
      '/** A doc comment naming lib/ddb.js and ACT# is fine. */',
      "import { ddb } from '../lib/ddb.js';",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the violation text.
      'const pk = `ACT#${activityId}`;',
    ].join('\n');
    expect(/from\s+['"].*lib\/ddb\.js['"]/.test(code(planted))).toBe(true);
    expect(/['"`](ACT|USER|LIST|INVITE|EMAIL|IDEM)#/.test(code(planted))).toBe(true);
  });

  it('is imported by nothing outside repositories/', () => {
    const offenders = files
      .filter((f) => !isRepositoryLayer(f.path))
      .filter((f) => /from\s+['"].*lib\/ddb\.js['"]/.test(f.body))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('is the only place an AWS DynamoDB SDK client is imported', () => {
    const offenders = files
      .filter((f) => f.path !== 'lib/ddb.ts' && !isRepositoryLayer(f.path))
      .filter((f) =>
        /from\s+['"]@aws-sdk\/(client-dynamodb|lib-dynamodb)['"]/.test(f.body),
      )
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('sees no pk/sk key literal outside repositories/keys.ts', () => {
    const offenders = files
      .filter((f) => f.path !== 'repositories/keys.ts')
      .filter((f) =>
        /['"`](ACT|USER|LIST|INVITE|EMAIL|IDEM|EXPENSE|SETTLEMENT|RATE)#/.test(f.body),
      )
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  // `Scan` is banned in application code, denied by the Lambda's IAM policy, and grepped in
  // CI (`data-model.md` §5). It is permitted only in `infra/scripts/migrations/`.
  it('contains no Scan', () => {
    const offenders = files
      .filter((f) => /\bScanCommand\b|\.scan\s*\(/.test(f.body))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe('process.env', () => {
  it('is read only by lib/config.ts', () => {
    const offenders = files
      .filter((f) => f.path !== 'lib/config.ts')
      .filter((f) => /process\s*\.\s*env/.test(f.body))
      .map((f) => f.path);
    // `local.ts` reads PORT, which is a dev-server concern rather than app configuration.
    expect(offenders).toEqual(['local.ts']);
  });
});
