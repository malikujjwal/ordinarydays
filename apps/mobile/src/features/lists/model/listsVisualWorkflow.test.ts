import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(process.cwd(), '..', '..', '.github', 'workflows', 'lists-visual.yml'),
  'utf8',
);

const configuredPaths = [...workflow.matchAll(/^\s+- '([^']+)'\s*$/gm)].map(
  ([, path]) => path ?? '',
);

function matchesTrigger(path: string): boolean {
  return configuredPaths.some((pattern) =>
    pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : path === pattern,
  );
}

describe('the List visual workflow path filter', () => {
  it.each([
    'apps/mobile/src/components/ConfirmDialog.tsx',
    'apps/mobile/src/components/listsContractGallery/OpenListFixture.tsx',
    'apps/mobile/src/features/compose/ComposeScreen.tsx',
    'e2e/lists-visual-global-setup.mjs',
  ])('runs for the direct visual dependency %s', (path) => {
    expect(matchesTrigger(path)).toBe(true);
  });
});
