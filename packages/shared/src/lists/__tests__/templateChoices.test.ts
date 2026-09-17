import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ListCapabilities, ListTemplate } from '../../types/list.js';
import { listCapabilities } from '../ingredientDestination.js';
import { type ListTemplateChoice, listTemplateChoices } from '../templateChoices.js';
import { LIST_TEMPLATES } from '../templates.js';

/**
 * The explicit selection contract (§P3-07). What matters here is as much what the projection
 * refuses to do as what it produces: the user's tap is the only input that sets a
 * `templateKey`, and these tests are what stop a matcher, a ranking or a fallback returning.
 */

const CHOICE_FIELDS = [
  'capabilities',
  'chooserLabel',
  'defaultTitle',
  'icon',
  'itemStateMode',
  'summary',
  'templateKey',
] as const;

/** `capabilities` is derived, not a `ListTemplate` field — verbatim copy does not apply to it. */
const COPIED_FIELDS = CHOICE_FIELDS.filter((field) => field !== 'capabilities');

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

  it('carries displayed fields plus item state for destination capability', () => {
    for (const choice of listTemplateChoices()) {
      expect(Object.keys(choice).sort(), choice.templateKey).toEqual([...CHOICE_FIELDS]);
    }
  });

  /**
   * Features and slot remain structural: the chooser only receives item state because the
   * shared ingredient-destination predicate needs it to prevent creating an unusable list.
   */
  it.each(['featureConfig', 'slot', 'emptyStateCopy'])(
    'does not carry the unrelated structural field %s',
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
      for (const field of COPIED_FIELDS) {
        expect(choice[field], `${choice.templateKey}.${field}`).toBe(
          (source as ListTemplate)[field],
        );
      }
    }
  });

  it('derives capabilities from the same shared rule the API guard uses, not a copy', () => {
    for (const choice of listTemplateChoices()) {
      expect(choice.capabilities, choice.templateKey).toEqual(listCapabilities(choice));
    }
  });

  it('is a Pick of the catalogue record plus the one derived field, so a field cannot drift in type', () => {
    expectTypeOf<ListTemplateChoice>().toEqualTypeOf<
      Pick<
        ListTemplate,
        | 'templateKey'
        | 'chooserLabel'
        | 'icon'
        | 'summary'
        | 'defaultTitle'
        | 'itemStateMode'
      > & { capabilities: ListCapabilities }
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
  it('projects Blank with the editable default title Untitled list', () => {
    const blank = listTemplateChoices()[0];

    expect(blank).toEqual({
      templateKey: 'blank',
      chooserLabel: 'Blank',
      summary: 'Start without a category or item details',
      defaultTitle: 'Untitled list',
      icon: 'list',
      itemStateMode: { mode: 'none' },
      capabilities: { ingredients: false },
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
      'adaptListItemToPlan',
      'canReceiveIngredients',
      'formatIngredientTitle',
      // Option B (2026-09-16): the one predicate for "does this item answer for this meal's
      // ingredient?", derived from `sourceProvenance` and never re-derived by a caller.
      'itemOriginatesFrom',
      'listCapabilities',
      'listTemplateChoices',
      // P3-26's creation seed: the other half of what a create resolves, and narrowed to the
      // durable-create path by `check-forbidden.mjs`'s `template-seed-is-creation-only`.
      'listTemplateSeed',
      'migrateLegacyListAggregate',
      'originsFromProvenance',
      'provenanceLabel',
      // `resolveSlot` is gone (Option B1, `docs/reports/
      // destination-flow-simplification-20260916.md`): resolving a destination is client-only
      // now, filtered from the same cached list index a picker already holds.
    ]);
    for (const key of Object.keys(barrel)) {
      expect(key.toLowerCase()).not.toContain('suggest');
      expect(key.toLowerCase()).not.toContain('match');
    }
  });
});
