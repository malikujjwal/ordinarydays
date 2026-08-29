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
  it('compiles the drop-index calculation as a UI-thread worklet', () => {
    const filename = resolve(process.cwd(), 'src/features/lists/model/reorder.ts');
    const configFile = resolve(process.cwd(), 'babel.config.js');
    const compiled = transformFileSync(filename, { configFile }).code ?? '';

    expect(compiled).toContain('dropIndex.__workletHash');
  });
});
