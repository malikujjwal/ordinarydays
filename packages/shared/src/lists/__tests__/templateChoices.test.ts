import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ListTemplate } from '../../types/list.js';
import { type ListTemplateChoice, listTemplateChoices } from '../templateChoices.js';
import { LIST_TEMPLATES } from '../templates.js';

/**
 * The explicit selection contract (§P3-07). What matters here is as much what the projection
 * refuses to do as what it produces: the user's tap is the only input that sets a
 * `templateKey`, and these tests are what stop a matcher, a ranking or a fallback returning.
 */

const DISPLAYED_FIELDS = [
  'chooserLabel',
  'defaultTitle',
  'icon',
  'summary',
  'templateKey',
] as const;

describe('the projection', () => {
  it('is every catalogue entry, exactly once, in catalogue order', () => {
    const choices = listTemplateChoices();

    expect(choices.map((choice) => choice.templateKey)).toEqual(
      LIST_TEMPLATES.map((template) => template.templateKey),
    );
    expect(new Set(choices.map((choice) => choice.templateKey)).size).toBe(
      choices.length,
    );
  });

  it('carries the five displayed fields and nothing else', () => {
    for (const choice of listTemplateChoices()) {
      expect(Object.keys(choice).sort(), choice.templateKey).toEqual([
        ...DISPLAYED_FIELDS,
      ]);
    }
  });

  /**
   * Behaviour, capabilities and slot are structural: the chooser shows what a style looks
   * like, and the server copies what it does. A renderer that received them here would be
   * one step from branching on them.
   */
  it.each(['behaviour', 'capabilities', 'slot', 'emptyStateCopy'])(
    'does not carry the structural field %s',
    (field) => {
      for (const choice of listTemplateChoices()) {
        expect(choice).not.toHaveProperty(field);
      }
    },
  );

  it('copies each displayed value verbatim from its catalogue record', () => {
    // Widened to `string` deliberately: the catalogue is `as const`, so an inferred map
    // would be keyed by the literal union and could not be looked up by the projection's
    // ordinary `string` key — which is the type a caller actually holds.
    const byKey = new Map<string, ListTemplate>(
      LIST_TEMPLATES.map((template) => [template.templateKey, template]),
    );

    for (const choice of listTemplateChoices()) {
      const source = byKey.get(choice.templateKey);
      expect(source, choice.templateKey).toBeDefined();
      for (const field of DISPLAYED_FIELDS) {
        expect(choice[field], `${choice.templateKey}.${field}`).toBe(
          (source as ListTemplate)[field],
        );
      }
    }
  });

  it('is a Pick of the catalogue record, so a field cannot drift in type', () => {
    expectTypeOf<ListTemplateChoice>().toEqualTypeOf<
      Pick<
        ListTemplate,
        'templateKey' | 'chooserLabel' | 'icon' | 'summary' | 'defaultTitle'
      >
    >();
  });

  it('is frozen, so a caller cannot reorder what it was handed', () => {
    const choices = listTemplateChoices();

    expect(Object.isFrozen(choices)).toBe(true);
    expect(() => {
      (choices as ListTemplateChoice[]).push(choices[0] as ListTemplateChoice);
    }).toThrow();
    expect(() => {
      (choices[0] as { chooserLabel: string }).chooserLabel = 'Renamed';
    }).toThrow();
  });

  it('returns the same array on every call — no per-call work, no ordering drift', () => {
    expect(listTemplateChoices()).toBe(listTemplateChoices());
  });
});

describe('the order the sheet renders', () => {
  it('opens with Blank and Checklist', () => {
    expect(
      listTemplateChoices()
        .slice(0, 2)
        .map((choice) => choice.chooserLabel),
    ).toEqual(['Blank', 'Checklist']);
  });

  /** The label and the prefilled title are two different fields, deliberately (§5.4). */
  it('projects Blank as simple-list with the editable default title Simple list', () => {
    const blank = listTemplateChoices()[0];

    expect(blank).toEqual({
      templateKey: 'simple-list',
      chooserLabel: 'Blank',
      summary: 'A plain list',
      defaultTitle: 'Simple list',
      icon: 'list',
    });
  });

  /**
   * Acceptance criterion 2: a record added to the array appears in the chooser with no
   * schema change, no migration and no edit to any other file. Asserted structurally — the
   * projection reads the catalogue it is given rather than a list of its own — because a
   * literal fixture appended to a frozen shipped constant is not something a test may do.
   */
  it('has no per-template map, second ordering array or copy of its own', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../templateChoices.ts', import.meta.url), 'utf8'),
    );
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

    // Every chooser label and default title lives on the catalogue record and nowhere here.
    for (const template of LIST_TEMPLATES) {
      expect(code, template.templateKey).not.toContain(template.chooserLabel);
      expect(code, template.templateKey).not.toContain(template.templateKey);
    }
    expect(code).not.toMatch(/\bswitch\b/);
  });
});

describe('nothing but a tap may choose a style', () => {
  /**
   * The arity **is** the contract: a parameter is how a title, a Plan kind or a "recent"
   * hint would get in, and any of those would let something other than the user decide.
   */
  it('accepts no arguments — no title, no free text, no context', () => {
    expect(listTemplateChoices).toHaveLength(0);
  });

  it('returns no recommendation, ranking, score or selection', () => {
    for (const choice of listTemplateChoices()) {
      for (const field of [
        'recommended',
        'suggested',
        'score',
        'rank',
        'selected',
        'isDefault',
        'matchTerms',
      ]) {
        expect(choice, choice.templateKey).not.toHaveProperty(field);
      }
    }
  });

  /**
   * The module's own export surface. The repo-wide half of this contract — that no
   * `suggestTemplate` symbol exists anywhere, in any package — is
   * `scripts/check-forbidden.mjs no-template-suggester`, which runs in CI: no test inside
   * one package can assert an absence about the others.
   *
   * This file is that rule's single exemption, because proving the absence means naming it.
   */
  it('exports only the projection and its type — no matcher or suggester', async () => {
    const module = await import('../templateChoices.js');
    expect(Object.keys(module)).toEqual(['listTemplateChoices']);

    const barrel = await import('../index.js');
    expect(Object.keys(barrel).sort()).toEqual([
      'LIST_TEMPLATES',
      'listTemplateChoices',
      'resolveSlot',
    ]);
    for (const key of Object.keys(barrel)) {
      expect(key.toLowerCase()).not.toContain('suggest');
      expect(key.toLowerCase()).not.toContain('match');
    }
  });
});
