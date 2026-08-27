import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ListTemplate } from '../../types/list.js';
import { type ListTemplateSeed, listTemplateSeed } from '../creationSeed.js';
import { listTemplateChoices } from '../templateChoices.js';
import { LIST_TEMPLATES } from '../templates.js';

/**
 * What a create copies (§P3-26, ADR-032, §P3-05 step 2).
 *
 * The seed and the chooser projection read the **same** records, so the assertions that matter
 * are that every style has one, that each value is the catalogue's verbatim, and that an
 * unknown key gets nothing rather than a fallback.
 */

const SEEDED_FIELDS = [
  'behaviour',
  'capabilities',
  'emptyStateCopy',
  'icon',
  'slot',
] as const;

describe('the creation seed', () => {
  it('answers for every style the chooser offers', () => {
    for (const choice of listTemplateChoices()) {
      expect(listTemplateSeed(choice.templateKey), choice.templateKey).toBeDefined();
    }
  });

  it('carries the five copied fields and nothing else', () => {
    for (const template of LIST_TEMPLATES) {
      const seed = listTemplateSeed(template.templateKey);
      expect(Object.keys(seed ?? {}).sort(), template.templateKey).toEqual([
        ...SEEDED_FIELDS,
      ]);
    }
  });

  it('copies each value verbatim from its catalogue record', () => {
    for (const template of LIST_TEMPLATES as readonly ListTemplate[]) {
      const seed = listTemplateSeed(template.templateKey);
      for (const field of SEEDED_FIELDS) {
        expect(seed?.[field], `${template.templateKey}.${field}`).toEqual(
          template[field],
        );
      }
    }
  });

  /**
   * The absence that matters: a client that fell back to `simple-list` would create a plain
   * list from a style the user tapped, which is the same silent substitution the server
   * refuses with `validation_failed` (§P3-05 edge case 1).
   */
  it('has no fallback for an unknown key', () => {
    expect(listTemplateSeed('not-a-style')).toBeUndefined();
    expect(listTemplateSeed('')).toBeUndefined();
    expect(listTemplateSeed('Groceries')).toBeUndefined();
  });

  it('is a Pick of the catalogue record, so a field cannot drift in type', () => {
    expectTypeOf<ListTemplateSeed>().toEqualTypeOf<
      Pick<
        ListTemplate,
        'behaviour' | 'capabilities' | 'slot' | 'icon' | 'emptyStateCopy'
      >
    >();
  });

  it('is frozen, so a caller cannot edit what a create is about to copy', () => {
    const seed = listTemplateSeed('groceries');

    expect(Object.isFrozen(seed)).toBe(true);
    expect(() => {
      (seed as { emptyStateCopy: string }).emptyStateCopy = 'Add anything.';
    }).toThrow();
    expect(() => {
      (seed as ListTemplateSeed).capabilities.checkable = false;
    }).toThrow();
  });

  /** Acceptance criterion 2: adding a style is one catalogue entry and no second file. */
  it('has no per-template map or copy of its own', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../creationSeed.ts', import.meta.url), 'utf8'),
    );
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

    for (const template of LIST_TEMPLATES) {
      expect(code, template.templateKey).not.toContain(template.templateKey);
      expect(code, template.templateKey).not.toContain(template.emptyStateCopy);
    }
    expect(code).not.toMatch(/\bswitch\b/);
  });

  /**
   * The seed answers about a **style**, never about a title. The arity is the same contract
   * `listTemplateChoices`'s zero arguments state: nothing here can be handed words.
   */
  it('takes one key and returns no ranking, score or recommendation', () => {
    expect(listTemplateSeed).toHaveLength(1);
    for (const field of ['recommended', 'score', 'matchTerms', 'defaultTitle']) {
      expect(listTemplateSeed('groceries')).not.toHaveProperty(field);
    }
  });
});
