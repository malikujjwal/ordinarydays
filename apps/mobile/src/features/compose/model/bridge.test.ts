import type { List, ListItemFeatures } from '@od/shared/types';
import { describe, expect, it, vi } from 'vitest';
import { type BridgeSource, bridgePrefill, explicitKindFor } from './bridge';

/** `draft.ts` mints `ing_` ids through `expo-crypto`, which has no jsdom implementation. */
vi.mock('expo-crypto', () => ({
  getRandomBytes: (count: number) =>
    Uint8Array.from({ length: count }, (_, index) => index),
  randomUUID: () => 'idem-test-key',
}));

/**
 * The one-time copy behind `Plan this item` (P3-34).
 *
 * The shared adapter owns the compatible intersection; these tests pin what the compose layer
 * adds on top of it — the draft-string mapping, and the single next-episode offer — and what
 * it must never add: a kind, an audience, or a value from a disabled feature.
 */

const WATCH_CONFIG: List['featureConfig'] = {
  progress: { enabled: true, kind: 'episode' },
};

const severanceFeatures: ListItemFeatures = {
  progress: { kind: 'episode', mediaKind: 'show', season: 2, episode: 4 },
};

function source(
  featureConfig: List['featureConfig'],
  item: Partial<BridgeSource['item']> & { title: string },
): BridgeSource {
  return {
    listId: 'lst_01J0000000000000000000000A',
    itemId: 'itm_01J0000000000000000000000B',
    list: { featureConfig },
    item: { state: 'open', ...item },
  };
}

describe('explicitKindFor', () => {
  it('maps the explicit General tap to the stored custom type', () => {
    expect(explicitKindFor('custom')).toBe('general');
    expect(explicitKindFor('meal')).toBe('meal');
    expect(explicitKindFor('watch')).toBe('watch');
    expect(explicitKindFor('event')).toBe('event');
  });
});

describe('bridgePrefill', () => {
  it('copies title and note only for General, whatever the item carries', () => {
    const prefill = bridgePrefill(
      source(WATCH_CONFIG, {
        title: 'Severance',
        note: 'Apple TV+',
        features: severanceFeatures,
        state: 'active',
      }),
      'custom',
    );
    expect(prefill.title).toBe('Severance');
    expect(prefill.notes).toBe('Apple TV+');
    expect(prefill.details).toEqual({});
    expect(prefill.location).toEqual({ label: '', address: '' });
  });

  it('offers the next episode for an active item after the explicit Watch tap', () => {
    const prefill = bridgePrefill(
      source(WATCH_CONFIG, {
        title: 'Severance',
        features: severanceFeatures,
        state: 'active',
      }),
      'watch',
    );
    expect(prefill.details).toEqual({ mediaKind: 'show', season: '2', episode: '5' });
  });

  it('copies stored progress unchanged when the item is not active', () => {
    const prefill = bridgePrefill(
      source(WATCH_CONFIG, { title: 'Severance', features: severanceFeatures }),
      'watch',
    );
    expect(prefill.details).toEqual({ mediaKind: 'show', season: '2', episode: '4' });
  });

  it('copies nothing from a disabled progress feature', () => {
    const prefill = bridgePrefill(
      source(
        { progress: { enabled: false, kind: 'episode' } },
        { title: 'Severance', features: severanceFeatures, state: 'active' },
      ),
      'watch',
    );
    expect(prefill.details).toEqual({});
  });

  it('copies sub-items into Meal ingredients only with the mealIngredients integration', () => {
    const features: ListItemFeatures = {
      subItems: {
        entries: [
          { id: 'sub_1', title: 'Chicken', secondary: '2 lb', rank: 'a' },
          { id: 'sub_2', title: 'Rice', rank: 'b' },
        ],
      },
    };
    const integrated = bridgePrefill(
      source(
        {
          subItems: {
            enabled: true,
            sectionLabel: 'Ingredients',
            singularLabel: 'Ingredient',
            secondaryLabel: 'Quantity',
            integration: 'mealIngredients',
          },
        },
        { title: 'Chicken tacos', features },
      ),
      'meal',
    );
    expect(integrated.details.ingredients).toEqual([
      { id: 'sub_1', name: 'Chicken', quantity: '2 lb', selected: false },
      { id: 'sub_2', name: 'Rice', quantity: '', selected: false },
    ]);

    const generic = bridgePrefill(
      source(
        {
          subItems: {
            enabled: true,
            sectionLabel: 'Materials',
            singularLabel: 'Material',
          },
        },
        { title: 'Bookshelf', features },
      ),
      'meal',
    );
    expect(generic.details.ingredients).toBeUndefined();
  });

  it('copies an enabled Place into the Event location and nowhere else', () => {
    const featureConfig: List['featureConfig'] = { place: { enabled: true } };
    const features: ListItemFeatures = {
      place: { label: 'Zahav', address: '237 St James Pl' },
    };
    const event = bridgePrefill(
      source(featureConfig, { title: 'Zahav', features }),
      'event',
    );
    expect(event.location).toEqual({ label: 'Zahav', address: '237 St James Pl' });

    const watch = bridgePrefill(
      source(featureConfig, { title: 'Zahav', features }),
      'watch',
    );
    expect(watch.location).toEqual({ label: '', address: '' });
    expect(watch.details).toEqual({});
  });
});
