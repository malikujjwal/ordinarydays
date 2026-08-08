import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `packages/ui` has the strictest "never" column in the repository (`repo-structure.md`
 * §2.2), and the cheapest moment to lock it in is now, before there is a single component
 * to be tempted by. `dependency-cruiser` enforces the graph-level version in P0-27; this
 * test exists as well because it fails with a message naming the file and the line.
 *
 * The scanning helpers are duplicated from `packages/shared`'s equivalent rather than
 * shared. That is not an oversight: this package may not import `@od/shared`, and inventing
 * a third package to hold eight lines of test helper would cost more than the duplication.
 */

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.includes('.test.')
    ) {
      acc.push(full);
    }
  }
  return acc;
}

/** Strip block comments and whole-line `//` comments; the rule is about code, not prose. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

describe('the ui package barrel', () => {
  it('resolves', async () => {
    await expect(import('@od/ui')).resolves.toBeDefined();
  });
});

describe('what must never enter ui (repo-structure.md §2.2)', () => {
  const files = sourceFiles(join(import.meta.dirname, '.'));

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // Guards the guard: if `code()` were weakened until nothing matched, every assertion
  // below would pass for the wrong reason and read like evidence.
  it('still detects a violation in real code after comments are stripped', () => {
    const planted = [
      '/** A doc comment naming @od/shared and zustand is fine. */',
      "import type { Activity } from '@od/shared/types';",
      'const bg = "#1a1a1a";',
    ].join('\n');

    expect(/from\s+['"]@od\//.test(code(planted))).toBe(true);
    expect(/#[0-9a-fA-F]{3,8}\b/.test(code(planted))).toBe(true);

    const commentOnly = planted.split('\n')[0] ?? '';
    expect(/from\s+['"]@od\//.test(code(commentOnly))).toBe(false);
  });

  it.each([
    // "ui depends on **no** workspace package" — not even @od/shared. A primitive that
    // needs a domain type is a feature component in the app, not a primitive.
    ['any workspace package', /from\s+['"]@od\//],
    [
      'server state or data fetching',
      /from\s+['"](@tanstack\/react-query|zustand|swr)['"]/,
    ],
    ['navigation — a primitive never navigates', /from\s+['"]expo-router['"]/],
    ['an AWS SDK client', /from\s+['"]@aws-sdk\//],
    ['fetch', /\bfetch\s*\(/],
    // design-system.md §9: colour, spacing, radius and font size come from tokens only.
    ['a hard-coded colour', /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/],
  ])('contains no reference to %s', (_label, pattern) => {
    const offenders = files.filter((f) => pattern.test(code(readFileSync(f, 'utf8'))));
    expect(offenders).toEqual([]);
  });
});
