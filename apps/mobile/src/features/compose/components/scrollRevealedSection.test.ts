import { describe, expect, it, vi } from 'vitest';

/**
 * `coding-standards.md` §8.6: every fork exports the same names. Each fork is loaded by its
 * exact filename, because an extensionless specifier resolves to the `.web.ts` fork. A string
 * path through `vi.importActual` does that without `import.meta.glob`, whose Vite types this
 * package does not have, and without `.ts`-extension imports, which `tsc` rejects here.
 */
describe('the platform fork', () => {
  const load = (path: string) => vi.importActual<Record<string, unknown>>(path);

  it('exports the same names from both files', async () => {
    const native = await load('./scrollRevealedSection.ts');
    const web = await load('./scrollRevealedSection.web.ts');

    // Two distinct modules, or the comparison below would pass on one fork loaded twice.
    expect(native).not.toBe(web);
    expect(Object.keys(native).sort()).toEqual(['scrollRevealedSectionIntoView']);
    expect(Object.keys(web).sort()).toEqual(Object.keys(native).sort());
  });
});
