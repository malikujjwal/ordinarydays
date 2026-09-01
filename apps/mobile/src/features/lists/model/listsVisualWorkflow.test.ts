import { existsSync, readFileSync } from 'node:fs';
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
    'apps/mobile/app/(app)/(tabs)/lists-contract-tab-gallery.tsx',
    'apps/mobile/app/(app)/(tabs)/_layout.tsx',
    'apps/mobile/src/components/TabScreen.tsx',
    'apps/mobile/src/features/shell/components/ShellFrame.tsx',
    'apps/mobile/src/components/ConfirmDialog.tsx',
    'apps/mobile/src/components/listsContractGallery/OpenListFixture.tsx',
    'e2e/lists-visual-global-setup.mjs',
  ])('runs for the direct visual dependency %s', (path) => {
    expect(existsSync(resolve(process.cwd(), '..', '..', path))).toBe(true);
    expect(matchesTrigger(path)).toBe(true);
  });
});
