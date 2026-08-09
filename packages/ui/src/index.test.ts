import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
/**
 * Imported statically, not with `await import()`.
 *
 * The barrel pulls in every primitive and, under coverage instrumentation, that dynamic
 * import took over five seconds and timed out — a slow import reported as a broken one. A
 * static import proves the same thing (the whole graph resolves and the surface is there)
 * and is paid once at collection.
 */
import * as barrel from './index';

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
  /**
   * Imported by relative path rather than by package name.
   *
   * `@od/ui`'s exports map points at `./src/index.ts`, and resolving the package by name from
   * inside itself makes Vite treat it as an external dependency and hand the raw TypeScript
   * to Node — which parsed fine while the barrel was `export {}` and stopped the moment it
   * had types in it. The relative path goes through the transform, which is what actually
   * exercises the barrel.
   */
  it('resolves, and exports the theme and the primitives', () => {
    expect(barrel.ThemeProvider).toBeDefined();
    expect(barrel.Button).toBeDefined();
    expect(barrel.Text).toBeDefined();
    expect(barrel.space).toBeDefined();
    expect(barrel.ratioOf).toBeDefined();
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
  ])('contains no reference to %s', (_label, pattern) => {
    const offenders = files.filter((f) => pattern.test(code(readFileSync(f, 'utf8'))));
    expect(offenders).toEqual([]);
  });
});

/**
 * The token rule (`design-system.md` §10), stated the way the design system actually states
 * it.
 *
 * The original assertion was "no hex anywhere in `packages/ui`", which was true while the
 * package was an empty barrel and became wrong the moment it had a theme: §10's own
 * enforcement table says *"the theme is the only export path for values; **ramps are
 * module-private in `theme/colors.ts`**"* — so hexes live there by design, and the rule is
 * that **nothing outside `theme/` may contain one**.
 *
 * Corrected in P1-22 to say that, which is both true and stronger: it now catches a
 * component reaching for a raw colour, which is the failure the rule is about, rather than
 * catching the theme for doing its job.
 */
describe('the token rule (design-system.md §10)', () => {
  const files = sourceFiles(join(import.meta.dirname, '.'));
  const colour = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
  const isTheme = (path: string) => path.replaceAll('\\', '/').includes('/src/theme/');

  it('confines every raw colour to theme/', () => {
    const offenders = files
      .filter((f) => !isTheme(f))
      .filter((f) => colour.test(code(readFileSync(f, 'utf8'))))
      .map((f) => f.replaceAll('\\', '/').split('/src/')[1]);

    expect(offenders).toEqual([]);
  });

  /** Guards the guard: the check is worthless if `theme/` turned out to hold no colours. */
  it('and theme/ is where they actually are', () => {
    const withColour = files
      .filter(isTheme)
      .filter((f) => colour.test(code(readFileSync(f, 'utf8'))));

    expect(withColour.length).toBeGreaterThan(0);
  });

  /**
   * The other half of §10: no inline numeric spacing, radius or font size outside the theme.
   * A component that wrote `padding: 14` would be inventing a value the scale does not have.
   */
  it('confines inline spacing, radius and font sizes to theme/', () => {
    const magic = /\b(padding|margin|fontSize|borderRadius)\s*:\s*\d+/;
    const offenders = files
      .filter((f) => !isTheme(f))
      .filter((f) => magic.test(code(readFileSync(f, 'utf8'))))
      .map((f) => f.replaceAll('\\', '/').split('/src/')[1]);

    expect(offenders).toEqual([]);
  });
});
