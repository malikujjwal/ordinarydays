import { describe, expect, expectTypeOf, it } from 'vitest';
import { listTemplate } from '../../schemas/list.js';
import type { ListBehaviour, ListTemplate } from '../../types/list.js';
import type { DefaultSlot } from '../../types/user.js';
import { LIST_TEMPLATES } from '../templates.js';

/**
 * The canonical table, `plans-and-lists.md` §5.3, transcribed a second time here — by hand,
 * from the document, **not** from `templates.ts`. The module and this fixture are two
 * independent readings of the same table; if they disagree, one of them misread it, and
 * that is exactly the failure this test exists to catch. Rows are in the table's order.
 */
const CANONICAL: readonly ListTemplate[] = [
  {
    templateKey: 'simple-list',
    chooserLabel: 'Blank',
    summary: 'A plain list',
    defaultTitle: 'Simple list',
    icon: 'list',
    behaviour: 'collection',
    capabilities: { checkable: false, supportsLocation: false },
    slot: null,
    emptyStateCopy: 'Add the first item.',
  },
  {
    templateKey: 'checklist',
    chooserLabel: 'Checklist',
    summary: 'Items have checkboxes',
    defaultTitle: 'Checklist',
    icon: 'check-square',
    behaviour: 'collection',
    capabilities: { checkable: true, supportsLocation: false },
    slot: null,
    emptyStateCopy: 'Add something to check off.',
  },
  {
    templateKey: 'groceries',
    chooserLabel: 'Groceries',
    summary: 'Checkboxes for shopping',
    defaultTitle: 'Groceries',
    icon: 'cart',
    behaviour: 'collection',
    capabilities: { checkable: true, supportsLocation: false },
    slot: 'groceries',
    emptyStateCopy: 'Add something to buy.',
  },
  {
    templateKey: 'shopping',
    chooserLabel: 'Shopping',
    summary: 'Things to buy',
    defaultTitle: 'Shopping',
    icon: 'bag',
    behaviour: 'collection',
    capabilities: { checkable: true, supportsLocation: false },
    slot: null,
    emptyStateCopy: 'Add something to shop for.',
  },
  {
    templateKey: 'packing',
    chooserLabel: 'Packing',
    summary: 'A checklist for a trip',
    defaultTitle: 'Packing',
    icon: 'suitcase',
    behaviour: 'collection',
    capabilities: { checkable: true, supportsLocation: false },
    slot: null,
    emptyStateCopy: 'Add something to pack.',
  },
  {
    templateKey: 'restaurants-to-try',
    chooserLabel: 'Restaurants to try',
    summary: 'Places and checkboxes',
    defaultTitle: 'Restaurants to try',
    icon: 'bowl',
    behaviour: 'collection',
    capabilities: { checkable: true, supportsLocation: true },
    slot: null,
    emptyStateCopy: 'Add a restaurant to try.',
  },
  {
    templateKey: 'bars-to-try',
    chooserLabel: 'Bars to try',
    summary: 'Places and checkboxes',
    defaultTitle: 'Bars to try',
    icon: 'glass',
    behaviour: 'collection',
    capabilities: { checkable: true, supportsLocation: true },
    slot: null,
    emptyStateCopy: 'Add a bar to try.',
  },
  {
    templateKey: 'coffee-shops',
    chooserLabel: 'Coffee shops',
    summary: 'Places without checkboxes',
    defaultTitle: 'Coffee shops',
    icon: 'cup',
    behaviour: 'collection',
    capabilities: { checkable: false, supportsLocation: true },
    slot: null,
    emptyStateCopy: 'Add a coffee shop.',
  },
  {
    templateKey: 'places-to-visit',
    chooserLabel: 'Places to visit',
    summary: 'Places and checkboxes',
    defaultTitle: 'Places to visit',
    icon: 'map-pin',
    behaviour: 'collection',
    capabilities: { checkable: true, supportsLocation: true },
    slot: null,
    emptyStateCopy: 'Add a place to visit.',
  },
  {
    templateKey: 'date-ideas',
    chooserLabel: 'Date ideas',
    summary: 'Places and ideas',
    defaultTitle: 'Date ideas',
    icon: 'heart',
    behaviour: 'collection',
    capabilities: { checkable: false, supportsLocation: true },
    slot: null,
    emptyStateCopy: 'Add a date idea.',
  },
  {
    templateKey: 'favourite-restaurants',
    chooserLabel: 'Favourite restaurants',
    summary: 'Places without checkboxes',
    defaultTitle: 'Favourite restaurants',
    icon: 'star',
    behaviour: 'collection',
    capabilities: { checkable: false, supportsLocation: true },
    slot: null,
    emptyStateCopy: 'Add a restaurant you love.',
  },
  {
    templateKey: 'books-to-read',
    chooserLabel: 'Books to read',
    summary: 'Books with checkboxes',
    defaultTitle: 'Books to read',
    icon: 'book',
    behaviour: 'collection',
    capabilities: { checkable: true, supportsLocation: false },
    slot: null,
    emptyStateCopy: 'Add a book to read.',
  },
  {
    templateKey: 'gift-ideas',
    chooserLabel: 'Gift ideas',
    summary: 'Ideas without checkboxes',
    defaultTitle: 'Gift ideas',
    icon: 'gift',
    behaviour: 'collection',
    capabilities: { checkable: false, supportsLocation: false },
    slot: null,
    emptyStateCopy: 'Add a gift idea.',
  },
  {
    templateKey: 'watchlist',
    chooserLabel: 'Watchlist',
    summary: 'Status and progress',
    defaultTitle: 'Watchlist',
    icon: 'play-rect',
    behaviour: 'watch',
    capabilities: { checkable: false, supportsLocation: false },
    slot: 'watch',
    emptyStateCopy: 'Add a movie or show.',
  },
  {
    templateKey: 'movies-to-watch',
    chooserLabel: 'Movies to watch',
    summary: 'Status for movies',
    defaultTitle: 'Movies to watch',
    icon: 'film',
    behaviour: 'watch',
    capabilities: { checkable: false, supportsLocation: false },
    slot: 'watch',
    emptyStateCopy: 'Add a movie.',
  },
  {
    templateKey: 'tv-shows',
    chooserLabel: 'TV shows',
    summary: 'Episode progress',
    defaultTitle: 'TV shows',
    icon: 'play-rect',
    behaviour: 'watch',
    capabilities: { checkable: false, supportsLocation: false },
    slot: 'watch',
    emptyStateCopy: 'Add a TV show.',
  },
  {
    templateKey: 'meals-to-try',
    chooserLabel: 'Meals to try',
    summary: 'Ingredients on each item',
    defaultTitle: 'Meals to try',
    icon: 'bowl',
    behaviour: 'meals',
    capabilities: { checkable: false, supportsLocation: false },
    slot: 'meals',
    emptyStateCopy: 'Add a meal to try.',
  },
];

const FIXED_ORDER = [
  'simple-list',
  'checklist',
  'groceries',
  'shopping',
  'packing',
  'restaurants-to-try',
  'bars-to-try',
  'coffee-shops',
  'places-to-visit',
  'date-ideas',
  'favourite-restaurants',
  'books-to-read',
  'gift-ideas',
  'watchlist',
  'movies-to-watch',
  'tv-shows',
  'meals-to-try',
] as const;

const byKey = (key: string) => {
  const found = LIST_TEMPLATES.find((t) => t.templateKey === key);
  if (!found) throw new Error(`No template ${key}`);
  return found;
};

describe('the catalogue matches plans-and-lists.md §5.3 exactly', () => {
  it('is the seventeen canonical records, every field verbatim, in the fixed order', () => {
    expect(LIST_TEMPLATES).toEqual(CANONICAL);
    expect(LIST_TEMPLATES.map((t) => t.templateKey)).toEqual(FIXED_ORDER);
  });

  it('is typed as the shared ListTemplate shape', () => {
    expectTypeOf(LIST_TEMPLATES).toMatchTypeOf<readonly ListTemplate[]>();
  });

  it('has unique templateKeys', () => {
    const keys = LIST_TEMPLATES.map((t) => t.templateKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every record parses against the ListTemplate schema', () => {
    for (const record of LIST_TEMPLATES) {
      const result = listTemplate.safeParse(record);
      expect(
        result.success,
        result.success ? undefined : JSON.stringify(result.error.issues),
      ).toBe(true);
    }
  });

  it('is frozen — the array cannot be appended to or reordered at runtime', () => {
    expect(Object.isFrozen(LIST_TEMPLATES)).toBe(true);
    expect(() => {
      // The cast is the point: the static type already forbids this, and the runtime must too.
      (LIST_TEMPLATES as unknown as ListTemplate[]).push(CANONICAL[0] as ListTemplate);
    }).toThrow();
  });
});

describe('behaviours and capabilities', () => {
  it('has exactly thirteen collection, three watch and one meals', () => {
    const count: Record<ListBehaviour, number> = { collection: 0, watch: 0, meals: 0 };
    for (const t of LIST_TEMPLATES) count[t.behaviour] += 1;
    expect(count).toEqual({ collection: 13, watch: 3, meals: 1 });
  });

  it('the first thirteen are collection, the next three watch, the last meals', () => {
    expect(LIST_TEMPLATES.slice(0, 13).every((t) => t.behaviour === 'collection')).toBe(
      true,
    );
    expect(LIST_TEMPLATES.slice(13, 16).every((t) => t.behaviour === 'watch')).toBe(true);
    expect(LIST_TEMPLATES[16]?.behaviour).toBe('meals');
  });

  it('checkable and supportsLocation are false on every non-collection record', () => {
    for (const t of LIST_TEMPLATES.filter((t) => t.behaviour !== 'collection')) {
      expect(t.capabilities, t.templateKey).toEqual({
        checkable: false,
        supportsLocation: false,
      });
    }
  });

  it('Blank and Gift ideas are the same thing under two names; the two restaurant styles differ by one flag', () => {
    expect(byKey('simple-list').capabilities).toEqual(byKey('gift-ideas').capabilities);
    expect(byKey('restaurants-to-try').capabilities).toEqual({
      checkable: true,
      supportsLocation: true,
    });
    expect(byKey('favourite-restaurants').capabilities).toEqual({
      checkable: false,
      supportsLocation: true,
    });
  });
});

describe('slots', () => {
  /** A slot is a destination, not a behaviour — but a seeded one must be coherent with it. */
  const compatible: Record<DefaultSlot, ListBehaviour> = {
    groceries: 'collection',
    watch: 'watch',
    meals: 'meals',
  };

  it('every non-null slot is compatible with its behaviour', () => {
    for (const t of LIST_TEMPLATES) {
      if (t.slot !== null) expect(t.behaviour, t.templateKey).toBe(compatible[t.slot]);
    }
  });

  it('exactly one seeds groceries, the three Watch styles seed watch, one seeds meals', () => {
    const seeding = (slot: DefaultSlot) =>
      LIST_TEMPLATES.filter((t) => t.slot === slot).map((t) => t.templateKey);
    expect(seeding('groceries')).toEqual(['groceries']);
    expect(seeding('watch')).toEqual(['watchlist', 'movies-to-watch', 'tv-shows']);
    expect(seeding('meals')).toEqual(['meals-to-try']);
  });

  it('per-occasion templates seed null — packing is not a standing destination', () => {
    expect(byKey('packing').slot).toBeNull();
    expect(byKey('shopping').slot).toBeNull();
  });
});

describe('simple-list is a catalogue choice, not a fallback', () => {
  it('presents as Blank and prefills Simple list — two deliberately different fields', () => {
    const blank = byKey('simple-list');
    expect(blank.chooserLabel).toBe('Blank');
    expect(blank.defaultTitle).toBe('Simple list');
    expect(LIST_TEMPLATES[0]).toBe(blank);
  });
});

describe('what the catalogue deliberately does not carry (ADR-031, ADR-032, criterion 6)', () => {
  it('no record has a deprecated flag, a Plan kind, a bridge kind, match terms or a rank', () => {
    const allowed = Object.keys(CANONICAL[0] as ListTemplate).sort();
    for (const t of LIST_TEMPLATES) {
      expect(Object.keys(t).sort(), t.templateKey).toEqual(allowed);
    }
  });

  /**
   * The catalogue module itself still exports the array and nothing else. The barrel gained
   * P3-07's `listTemplateChoices` — a field projection of these same records, with no
   * ordering or copy of its own — and that is the complete surface; anything resembling a
   * matcher, registry or suggestion function is still absent from both.
   */
  it('exports nothing but the array — no matcher, registry or suggestion function', async () => {
    const mod = await import('../templates.js');
    expect(Object.keys(mod)).toEqual(['LIST_TEMPLATES']);
    const barrel = await import('../index.js');
    expect(Object.keys(barrel).sort()).toEqual(['LIST_TEMPLATES', 'listTemplateChoices']);
  });
});
