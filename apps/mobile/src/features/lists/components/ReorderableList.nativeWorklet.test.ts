import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(resolve(process.cwd(), 'package.json'));
const { transformFileSync } = require('@babel/core') as {
  transformFileSync: (
    filename: string,
    options: { configFile: string },
  ) => { code?: string | null };
};

describe('the native reorder gesture worklet boundary', () => {
  // The first Babel/Worklets transform is a synchronous cold start. It remains sub-second
  // alone, but can exceed Vitest's generic 5s ceiling while every Turbo coverage task runs.
  it('compiles the drop-index calculation as a UI-thread worklet', () => {
    const filename = resolve(process.cwd(), 'src/features/lists/model/reorder.ts');
    const configFile = resolve(process.cwd(), 'babel.config.js');
    const compiled = transformFileSync(filename, { configFile }).code ?? '';

    expect(compiled).toContain('dropIndex.__workletHash');
  }, 15_000);

  it('compiles the wrapper-owned grip with long press and bounded accessibility actions', () => {
    const filename = resolve(
      process.cwd(),
      'src/features/lists/components/ReorderableList.tsx',
    );
    const configFile = resolve(process.cwd(), 'babel.config.js');
    const compiled = transformFileSync(filename, { configFile }).code ?? '';

    expect(compiled).toContain('activateAfterLongPress');
    expect(compiled).toContain('GestureDetector');
    expect(compiled).toContain('accessibilityActions');
    expect(compiled).toContain('Move up');
    expect(compiled).toContain('Move down');
    expect(compiled).toContain('accessibilityLabel');
    expect(compiled).toContain('Reorder ');
    expect(compiled).toContain('theme.layout.hitTarget');
  });
});
