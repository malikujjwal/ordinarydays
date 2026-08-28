import { describe, expect, expectTypeOf, it } from 'vitest';
import { listTemplate } from '../../schemas/list.js';
import type { ListTemplate } from '../../types/list.js';
import { LIST_TEMPLATES } from '../templates.js';

const expected = [
  ['blank', 'Blank'],
  ['checklist', 'Checklist'],
  ['groceries', 'Groceries'],
  ['watch-later', 'Watch Later'],
  ['books-to-read', 'Books to Read'],
  ['places-to-visit', 'Places to Visit'],
  ['meal-ideas', 'Meal Ideas'],
] as const;

describe('P3-33 list creation types', () => {
  it('is exactly the seven fixed types in Blank-first order', () => {
    expect(
      LIST_TEMPLATES.map(({ templateKey, chooserLabel }) => [templateKey, chooserLabel]),
    ).toEqual(expected);
  });

  it('matches the public schema and type', () => {
    expectTypeOf(LIST_TEMPLATES).toMatchTypeOf<readonly ListTemplate[]>();
    for (const template of LIST_TEMPLATES)
      expect(listTemplate.safeParse(template).success).toBe(true);
  });

  it('seeds typed configuration, never a purpose discriminator', () => {
    for (const template of LIST_TEMPLATES) {
      expect(template).toHaveProperty('itemStateMode');
      expect(template).toHaveProperty('featureConfig');
      expect(template).not.toHaveProperty('behaviour');
      expect(template).not.toHaveProperty('capabilities');
    }
  });

  it('pins the semantic presets without making labels semantic', () => {
    expect(LIST_TEMPLATES[3]).toMatchObject({
      itemStateMode: { mode: 'stages', groupByState: true },
      featureConfig: { progress: { enabled: true, kind: 'episode' } },
      slot: 'watch',
    });
    expect(LIST_TEMPLATES[6]).toMatchObject({
      itemStateMode: { mode: 'none' },
      featureConfig: { subItems: { integration: 'mealIngredients' } },
      slot: 'meals',
    });
  });
});
