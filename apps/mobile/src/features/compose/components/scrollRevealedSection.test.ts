import { describe, expect, it } from 'vitest';

/**
 * `coding-standards.md` §8.6: every fork exports the same names. Loaded through
 * `import.meta.glob` because an extensionless specifier resolves to the `.web.ts` fork.
 */
describe('the platform fork', () => {
  const modules = import.meta.glob('./scrollRevealedSection*.ts', {
    eager: true,
  }) as Record<string, Record<string, unknown>>;

  const exportsOf = (path: string): string[] => {
    const found = modules[path];
    if (found === undefined) throw new Error(`${path} was not loaded`);
    return Object.keys(found).sort();
  };

  it('exports the same names from both files', () => {
    expect(exportsOf('./scrollRevealedSection.ts')).toEqual([
      'scrollRevealedSectionIntoView',
    ]);
    expect(exportsOf('./scrollRevealedSection.web.ts')).toEqual(
      exportsOf('./scrollRevealedSection.ts'),
    );
  });
});
